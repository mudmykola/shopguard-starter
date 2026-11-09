import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLiveTheme,
  gitState,
  guardClientRepository,
  isTheme,
  importNewFiles,
  loadConfig,
  parseThemeList,
  planThemeImport,
  pullArgs,
  selectableSourceThemes,
  selectSourceTheme,
  setupLocal,
  shopifyCommandArgs,
  verifyThemeStructure,
  type ShopifyTheme,
  type CommandRunner,
  type ProjectConfig,
} from './core.js';

export type InitDependencies = {
  run: CommandRunner;
  prompt: (message: string, expected: string) => Promise<boolean>;
  chooseSourceTheme?: (themes: ShopifyTheme[]) => Promise<string | undefined>;
  sourceThemeId?: string;
  output: (message: string) => void;
  tempRoot?: string;
};

export async function initProject(root: string, config: ProjectConfig, deps: InitDependencies): Promise<void> {
  const current = loadConfig(root);
  if (current.store !== config.store) throw new Error('The configured store changed during initialization; refusing to continue');
  let git = gitState(root, deps.run);
  guardClientRepository(git.remote);
  const stateFile = join(root, '.shopguard', 'init-state.json');
  let filesToCommit: string[];
  let snapshot = '';

  if (current.mode === 'new' && deps.sourceThemeId) throw new Error('--source-theme can only be used with an existing Shopify theme.');

  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { files?: unknown };
    filesToCommit = Array.isArray(state.files) ? state.files.filter((file): file is string => typeof file === 'string') : [];
    deps.output('Resuming local Git bootstrap from the saved initialization preview; Shopify will not be contacted again.');
  } else {
    if (git.dirty) {
      const status = deps.run('git', ['status', '--porcelain'], root).output.trim().split('\n').filter(Boolean);
      const allowed = status.every((line) => line.trim().endsWith('.shopguard/project.json'));
      if (!allowed) throw new Error('Working tree has local changes. Commit or review them before initialization.');
    }

    if (current.mode === 'new') {
      snapshot = mkdtempSync(join(tmpdir(), 'shopguard-new-'));
      const initArgs = ['theme', 'init', '--path', snapshot, '--no-input'];
      deps.output(`Create an untouched Shopify skeleton locally. Configured future store: ${config.store}.\nshopify ${initArgs.join(' ')}\nTemporary destination: ${snapshot}`);
      if (!await deps.prompt('Download the official Shopify skeleton into a temporary local folder?', `SKELETON ${config.store}`)) {
        throw new Error('Skeleton creation was not confirmed; no files were imported.');
      }
      const initialized = deps.run('shopify', initArgs, root);
      if (!initialized.ok) throw new Error(`Shopify skeleton download failed. Snapshot retained at ${snapshot}.\n${initialized.output.trim()}`);
      const missing = verifyThemeStructure(snapshot);
      if (missing.length) throw new Error(`Downloaded files do not form a recognizable theme (missing ${missing.join(', ')}). Snapshot retained at ${snapshot}.`);
      const plan = planThemeImport(snapshot, root);
      deps.output(`Skeleton import preview: ${plan.added.length} new files; ${plan.conflicts.length} existing files preserved.`);
      if (!await deps.prompt('Copy only new skeleton files into this project?', `IMPORT ${config.store}`)) {
        throw new Error(`Skeleton import was not confirmed. Files remain in ${snapshot}.`);
      }
      importNewFiles(snapshot, root, plan.added);
      const tooling = setupLocal(root);
      filesToCommit = [...plan.added, ...tooling];
      writeFileSync(stateFile, `${JSON.stringify({ files: [...new Set(filesToCommit)], snapshot }, null, 2)}\n`);
      deps.output(`Imported ${plan.added.length} Shopify skeleton files. No store was queried or changed. Snapshot: ${snapshot}`);
    } else {
    const listArgs = shopifyCommandArgs(config, ['theme', 'list', '--json', '--path', root]);
    deps.output(`Read-only Shopify request:\nshopify ${listArgs.join(' ')}\nTarget store: ${config.store}`);
    if (!await deps.prompt(`ShopGuard will query the theme list for ${config.store}.`, `LIST ${config.store}`)) {
      throw new Error('Store access check was not confirmed; nothing was sent to Shopify.');
    }
    const listed = deps.run('shopify', listArgs, root);
    if (!listed.ok) throw new Error(`Shopify access check failed for ${config.store}. Sign in manually for this store; ShopGuard did not log out or switch accounts.\n${listed.output.trim()}`);
    const themes = parseThemeList(listed.output, config.store);
    const live = findLiveTheme(themes);
    const sources = selectableSourceThemes(themes);
    if (!sources.length) throw new Error('Shopify returned no Live or unpublished themes that can be used as a local source.');
    deps.output(`Теми магазину ${config.store}:\n${themes.map((theme) => `- ${theme.name} (${theme.role}, ID ${theme.id})${sources.some((source) => source.id === theme.id) ? '' : ' — недоступна як джерело'}`).join('\n')}\n\nВибір джерела лише завантажує файли локально. Це не ціль завантаження в Shopify.`);
    const requestedSourceId = deps.sourceThemeId ?? await deps.chooseSourceTheme?.(sources);
    const source = selectSourceTheme(themes, requestedSourceId);
    deps.output(`Обрано джерело: ${source.name} (${source.role}, ID ${source.id}). Live ID магазину: ${live.id}.`);

    if (!await deps.prompt(`Завантажити файли теми «${source.name}» локально? Shopify не отримає жодних змін.`, `PULL ${source.id}`)) {
      throw new Error('Завантаження вибраної теми не підтверджено; локальні файли не змінено.');
    }
    snapshot = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'shopguard-theme-'));
    const pullCommandArgs = pullArgs(config, source.id, snapshot);
    deps.output(`Local-only download:\nshopify ${pullCommandArgs.join(' ')}\nTemporary destination: ${snapshot}`);
    const pulled = deps.run('shopify', pullCommandArgs, root);
    if (!pulled.ok) throw new Error(`Theme download failed. Snapshot retained for inspection at ${snapshot}.\n${pulled.output.trim()}`);
    const missing = verifyThemeStructure(snapshot);
    if (missing.length) throw new Error(`Downloaded files do not form a recognizable theme (missing ${missing.join(', ')}). Snapshot retained at ${snapshot}.`);

    const plan = planThemeImport(snapshot, root);
    deps.output(`Import preview for ${root}:\n${plan.added.length} new files will be copied.\n${plan.conflicts.length} existing files will be preserved.\n${plan.protectedConflicts.length} protected merchant JSON conflicts require manual review.${plan.conflicts.length ? `\nConflicts:\n${plan.conflicts.map((file) => `- ${file}${plan.protectedConflicts.includes(file) ? ' [protected]' : ''}`).join('\n')}` : ''}`);
    if (!await deps.prompt('Copy only new files? Existing and merchant-managed files will not be replaced.', `IMPORT ${config.store}`)) {
      throw new Error(`Import was not confirmed. Theme files remain in ${snapshot}; the project folder was not changed.`);
    }
    importNewFiles(snapshot, root, plan.added);
    const nextConfig = { ...config, liveThemeId: live.id };
    writeFileSync(join(root, '.shopguard', 'project.json'), `${JSON.stringify(nextConfig, null, 2)}\n`);
    const tooling = setupLocal(root);
      filesToCommit = [...plan.added, ...tooling];
    writeFileSync(stateFile, `${JSON.stringify({ files: [...new Set(filesToCommit)], snapshot }, null, 2)}\n`);
    deps.output(`Imported ${plan.added.length} theme files. Existing files preserved.${tooling.length ? ` Added tooling: ${tooling.join(', ')}.` : ''}\nSnapshot retained at ${snapshot}.`);
    }
  }

  git = gitState(root, deps.run);
  if (!git.inside) {
    if (!await deps.prompt('Initialize local Git on the client project. This does not create or push a remote repository.', `INIT GIT ${config.store}`)) {
      deps.output('Local theme import is complete. Git bootstrap can be resumed by rerunning sgd init.');
      return;
    }
    const initialized = deps.run('git', ['init', '--initial-branch', config.productionBranch], root);
    if (!initialized.ok) throw new Error(`Could not initialize local Git.\n${initialized.output.trim()}`);
    git = gitState(root, deps.run);
  }
  guardClientRepository(git.remote);
  if (git.branch !== config.productionBranch) {
    const master = deps.run('git', ['branch', '--list', config.productionBranch], root);
    const args = master.output.trim() ? ['switch', config.productionBranch] : ['switch', '-c', config.productionBranch];
    const switched = deps.run('git', args, root);
    if (!switched.ok) throw new Error(`Could not safely switch to ${config.productionBranch}; no branch was overwritten.\n${switched.output.trim()}`);
  }
  const stagedAlready = deps.run('git', ['diff', '--cached', '--name-only'], root);
  if (stagedAlready.output.trim()) throw new Error('Git index already has staged changes. Commit or unstage them before ShopGuard creates the baseline.');
  const userName = deps.run('git', ['config', 'user.name'], root);
  const userEmail = deps.run('git', ['config', 'user.email'], root);
  if (!userName.ok || !userName.output.trim() || !userEmail.ok || !userEmail.output.trim()) {
    throw new Error('Git author identity is not configured. Set git config user.name and user.email, then rerun sgd init.');
  }
  const files = [...new Set(filesToCommit)].filter((file) => !isSensitivePath(file));
  for (const file of files) {
    const ignored = deps.run('git', ['check-ignore', '--quiet', '--', file], root);
    if (ignored.ok) throw new Error(`Refusing to stage ignored or sensitive path: ${file}`);
  }
  deps.output(`Git review list (${files.length} paths):\n${files.map((file) => `- ${file}`).join('\n')}`);
  if (!await deps.prompt('Stage only the listed baseline files for review.', `STAGE ${config.store}`)) {
    deps.output('Theme import is complete; Git stage was declined. Rerun sgd init to resume Git bootstrap.');
    return;
  }
  const added = deps.run('git', ['add', '--', ...files], root);
  if (!added.ok) throw new Error(`Could not stage baseline files.\n${added.output.trim()}`);
  const diff = deps.run('git', ['diff', '--cached'], root);
  const stagedNames = deps.run('git', ['diff', '--cached', '--name-only'], root);
  deps.output(`Staged diff for review:\n${stagedNames.output.trim()}\n${diff.output}`);
  if (!await deps.prompt('Commit this reviewed theme baseline to the production branch.', `COMMIT ${config.store}`)) {
    deps.output('Files are staged for your review. Rerun sgd init to continue after deciding how to handle them.');
    return;
  }
  const committed = deps.run('git', ['commit', '-m', 'chore(theme): import Shopify baseline'], root);
  if (!committed.ok) throw new Error(`Baseline commit failed. Staged diff is preserved.\n${committed.output.trim()}`);
  const dev = deps.run('git', ['branch', '--list', config.developmentBranch], root);
  if (dev.output.trim()) {
    const sameCommit = deps.run('git', ['merge-base', '--is-ancestor', config.productionBranch, config.developmentBranch], root);
    if (!sameCommit.ok) throw new Error(`Branch ${config.developmentBranch} already exists and does not include ${config.productionBranch}; it was left unchanged.`);
    const switched = deps.run('git', ['switch', config.developmentBranch], root);
    if (!switched.ok) throw new Error(`Could not switch to existing ${config.developmentBranch}.`);
  } else {
    const created = deps.run('git', ['switch', '-c', config.developmentBranch], root);
    if (!created.ok) throw new Error(`Could not create ${config.developmentBranch} from the baseline commit.`);
  }
  unlinkSync(stateFile);
  const nextStep = git.remote
    ? `Перевір репозиторій командою git remote -v. Якщо origin веде на репозиторій магазину, наступні команди:
  git push -u origin ${config.productionBranch}
  git push -u origin ${config.developmentBranch}`
    : `Створи окремий порожній GitHub-репозиторій магазину, потім виконай:
  git remote add origin https://github.com/OWNER/CLIENT-REPO.git
  git remote -v
Після перевірки origin відправ baseline командами:
  git push -u origin ${config.productionBranch}
  git push -u origin ${config.developmentBranch}`;
  deps.output(`Baseline committed on ${config.productionBranch}; ${config.developmentBranch} now points to that commit. Checked out ${config.developmentBranch}. No remote was created or pushed.\n\n${nextStep}`);
}

function isSensitivePath(file: string): boolean {
  return /(^|\/)(\.env(?:\..*)?|\.npmrc|\.aws|\.codex|\.agents|auth|session|backups|cache|snapshots)(\/|$)|\.(pem|key|p12|pfx)$/i.test(file);
}
