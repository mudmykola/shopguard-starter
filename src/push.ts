import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  gitState,
  guardClientRepository,
  listFiles,
  parseThemeList,
  protectedFiles,
  pullArgs,
  shopifyCommandArgs,
  verifyThemeStructure,
  type CommandRunner,
  type CommandResult,
  type ProjectConfig,
} from './core.js';

export type PushDependencies = {
  run: CommandRunner;
  runShopify?: (args: string[], cwd: string, label: string) => Promise<CommandResult>;
  prompt: (message: string, expected: string) => Promise<boolean>;
  output: (message: string) => void;
  now?: () => number;
};

type BaselinePointer = { themeId: string; snapshot: string; createdAt: string };

export async function pushThemeBaseline(root: string, config: ProjectConfig, deps: PushDependencies): Promise<string> {
  assertTarget(root, config);
  await assertRemoteStagingTheme(root, config, deps);
  deps.output(`Save a read-only staging snapshot for ${config.store} / ${config.themeId}. No Shopify files will be uploaded.`);
  if (!await deps.prompt('Download and store this unpublished theme as the manual-push baseline?', `BASELINE ${config.store} ${config.themeId}`)) {
    throw new Error('Baseline capture was not confirmed.');
  }
  const snapshot = await takeSnapshot(root, config, deps, 'snapshots');
  const themeRoot = join(root, '.shopguard', 'baselines', config.themeId!);
  mkdirSync(themeRoot, { recursive: true });
  const archived = join(themeRoot, `snapshot-${(deps.now?.() ?? Date.now()).toString()}-${randomUUID()}`);
  cpSync(snapshot, archived, { recursive: true, errorOnExist: true, force: false });
  const pointer: BaselinePointer = { themeId: config.themeId!, snapshot: relative(root, archived), createdAt: new Date(deps.now?.() ?? Date.now()).toISOString() };
  writeFileSync(join(themeRoot, 'latest.json'), `${JSON.stringify(pointer, null, 2)}\n`);
  deps.output(`Staging baseline saved locally at ${pointer.snapshot}. No remote theme files were changed.`);
  return archived;
}

export async function pushTheme(root: string, config: ProjectConfig, selectedFiles: string[] | undefined, deps: PushDependencies): Promise<string[]> {
  assertTarget(root, config);
  const baseline = loadBaseline(root, config.themeId!);
  await assertRemoteStagingTheme(root, config, deps);
  const backup = await takeSnapshot(root, config, deps, 'backups');
  const baselineDrift = changedFiles(baseline, backup);
  const localDiff = changedFiles(baseline, root).filter((file) => isThemePath(file));
  const deleted = localDiff.filter((file) => !existsSync(join(root, file)));
  if (deleted.length) throw new Error(`Remote deletions are not supported by sgd push; local deletions left untouched: ${deleted.join(', ')}`);

  const protectedLocal = protectedFiles(localDiff);
  const candidates = localDiff.filter((file) => !protectedLocal.includes(file));
  if (protectedLocal.length) deps.output(`Protected merchant JSON excluded: ${protectedLocal.join(', ')}`);
  const selected = selectedFiles?.length ? [...new Set(selectedFiles)] : candidates;
  const invalid = selected.filter((file) => !candidates.includes(file));
  if (invalid.length) throw new Error(`Files must be changed local theme files and cannot be protected: ${invalid.join(', ')}`);
  if (!selected.length) throw new Error('No changed, unprotected local theme files are available to upload.');

  const conflicts = selected.filter((file) => baselineDrift.includes(file));
  if (conflicts.length) throw new Error(`Remote drift conflicts with selected local files. Resolve and refresh the baseline first: ${conflicts.join(', ')}`);

  deps.output(`Staging target: ${config.store} / ${config.themeId} (unpublished)\nSelected files (${selected.length}):\n${selected.map((file) => `- ${file}`).join('\n')}\nRemote-only changes preserved: ${baselineDrift.filter((file) => !selected.includes(file)).join(', ') || 'none'}\nRecovery snapshot: ${backup}`);
  if (!await deps.prompt('Upload these files to the verified unpublished theme? Live themes and publish actions are excluded.', `PUSH ${config.store} ${config.themeId} ${selected.length}`)) {
    throw new Error(`Upload declined. Recovery snapshot retained at ${backup}.`);
  }

  await assertRemoteStagingTheme(root, config, deps);
  const beforeUpload = await takeSnapshot(root, config, deps, 'snapshots');
  const changedSinceReview = selected.filter((file) => hashIn(beforeUpload, file) !== hashIn(backup, file));
  if (changedSinceReview.length) throw new Error(`Remote files changed after review; upload cancelled: ${changedSinceReview.join(', ')}. Recovery snapshot: ${backup}`);

  const checkArgs = shopifyCommandArgs(config, ['theme', 'check', '--path', root]);
  const check = await runShopify(deps, checkArgs, root, 'Запускаю Shopify Theme Check');
  if (!check.ok) throw new Error(`Theme Check failed; nothing was uploaded. ${check.output}`);
  const pushArgs = shopifyCommandArgs(config, [
    'theme', 'push', '--theme', config.themeId!, '--nodelete', '--json', '--path', root,
    ...selected.flatMap((file) => ['--only', file]),
  ]);
  deps.output(`Shopify upload command (no Live/publish flags):\nshopify ${pushArgs.join(' ')}`);
  const uploaded = await runShopify(deps, pushArgs, root, `Завантажую ${selected.length} файлів у тему`);
  if (!uploaded.ok) throw new Error(`Shopify upload failed. Recovery snapshot retained at ${backup}. ${uploaded.output}`);

  await assertRemoteStagingTheme(root, config, deps);
  const verified = await takeSnapshot(root, config, deps, 'snapshots');
  const mismatches = selected.filter((file) => hashIn(root, file) !== hashIn(verified, file));
  if (mismatches.length) throw new Error(`Upload ran but remote verification differs for ${mismatches.join(', ')}. Recovery snapshot retained at ${backup}; no automatic rollback was attempted.`);

  const themeRoot = join(root, '.shopguard', 'baselines', config.themeId!);
  const archived = join(themeRoot, `snapshot-${(deps.now?.() ?? Date.now()).toString()}-${randomUUID()}`);
  cpSync(verified, archived, { recursive: true, errorOnExist: true, force: false });
  const pointer: BaselinePointer = { themeId: config.themeId!, snapshot: relative(root, archived), createdAt: new Date(deps.now?.() ?? Date.now()).toISOString() };
  writeFileSync(join(themeRoot, 'latest.json'), `${JSON.stringify(pointer, null, 2)}\n`);
  deps.output(`Upload verified for ${selected.length} files. New local baseline saved at ${pointer.snapshot}. Recovery snapshot retained at ${backup}.`);
  return selected;
}

function assertTarget(root: string, config: ProjectConfig): void {
  if (!config.themeId || !/^\d+$/.test(config.themeId)) throw new Error('Configure a numeric unpublished staging themeId before using sgd push.');
  if (config.themeId === config.liveThemeId) throw new Error('Configured staging themeId matches the recorded Live theme ID.');
  if (config.themeRole !== 'unpublished') throw new Error('Set themeRole to unpublished only after confirming the target in Shopify Admin.');
  if (config.github?.connected !== false) throw new Error('Manual push requires github.connected=false in project.json after confirming the theme is not GitHub-connected.');
  const git = gitState(root);
  guardClientRepository(git.remote);
  if (!git.inside || git.branch !== config.developmentBranch) throw new Error(`Manual staging push is allowed only from ${config.developmentBranch}; current branch is ${git.branch}.`);
  const missing = verifyThemeStructure(root);
  if (missing.length) throw new Error(`Current project is not a complete Shopify theme: ${missing.join(', ')}.`);
}

async function assertRemoteStagingTheme(root: string, config: ProjectConfig, deps: PushDependencies): Promise<void> {
  const listArgs = shopifyCommandArgs(config, ['theme', 'list', '--json', '--path', root]);
  const listed = await runShopify(deps, listArgs, root, 'Перевіряю магазин і цільову тему');
  if (!listed.ok) throw new Error(`Could not verify target store/theme; upload stopped. ${listed.output}`);
  const themes = parseThemeList(listed.output, config.store);
  if (themes.some((theme) => ['live', 'main'].includes(theme.role.toLowerCase()) && theme.id === config.themeId)) {
    throw new Error('Refusing upload: configured target is Live.');
  }
  const target = themes.find((theme) => theme.id === config.themeId);
  if (!target || target.role !== 'unpublished') throw new Error(`Theme ${config.themeId} is not currently reported as unpublished for ${config.store}.`);
}

async function takeSnapshot(root: string, config: ProjectConfig, deps: PushDependencies, area: 'backups' | 'snapshots'): Promise<string> {
  const base = join(root, '.shopguard', area);
  mkdirSync(base, { recursive: true });
  const snapshot = mkdtempSync(join(base, `theme-${config.themeId}-`));
  const pulled = await runShopify(deps, pullArgs(config, config.themeId!, snapshot), root, 'Завантажую snapshot теми локально');
  if (!pulled.ok) throw new Error(`Could not pull a fresh remote snapshot; no upload was attempted. Snapshot path: ${snapshot}. ${pulled.output}`);
  const missing = verifyThemeStructure(snapshot);
  if (missing.length) throw new Error(`Remote snapshot is incomplete; no upload was attempted. Snapshot path: ${snapshot}. Missing: ${missing.join(', ')}.`);
  return snapshot;
}

function runShopify(deps: PushDependencies, args: string[], cwd: string, label: string): Promise<CommandResult> {
  return deps.runShopify ? deps.runShopify(args, cwd, label) : Promise.resolve(deps.run('shopify', args, cwd));
}

function loadBaseline(root: string, themeId: string): string {
  const file = join(root, '.shopguard', 'baselines', themeId, 'latest.json');
  if (!existsSync(file)) throw new Error(`No reviewed baseline for staging theme ${themeId}. Run sgd push --baseline first.`);
  let pointer: BaselinePointer;
  try { pointer = JSON.parse(readFileSync(file, 'utf8')) as BaselinePointer; }
  catch { throw new Error('Staging baseline pointer is invalid; refusing upload.'); }
  const relativePath = pointer.snapshot;
  const absolute = resolve(root, relativePath);
  if (pointer.themeId !== themeId || !relativePath.startsWith(`.shopguard/baselines/${themeId}/snapshot-`) || !absolute.startsWith(`${resolve(root)}/`) || !existsSync(absolute)) {
    throw new Error('Staging baseline pointer does not reference a valid local snapshot.');
  }
  return absolute;
}

function changedFiles(left: string, right: string): string[] {
  const a = new Set(listFiles(left).filter(isThemePath));
  const b = new Set(listFiles(right).filter(isThemePath));
  return [...new Set([...a, ...b])].filter((file) => a.has(file) !== b.has(file) || hashIn(left, file) !== hashIn(right, file)).sort();
}

function hashIn(root: string, file: string): string | undefined {
  const path = join(root, file);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined;
}

function isThemePath(file: string): boolean {
  return ['layout/', 'sections/', 'snippets/', 'templates/', 'config/', 'assets/'].some((prefix) => file.startsWith(prefix));
}
