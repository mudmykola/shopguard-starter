#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkProject,
  changedThemeFiles,
  diagnoseProject,
  findRoot,
  gitState,
  guardClientRepository,
  isTheme,
  listFiles,
  loadConfig,
  managePreCommitHook,
  missingSetupDependencies,
  packageManagerCommand,
  parseThemeList,
  preflight,
  planThemeImport,
  importNewFiles,
  pullArgs,
  remoteThemeArgs,
  remotePreflight,
  run,
  runInteractive,
  saveConfig,
  setupLocal,
  shopifyCommandArgs,
  validateConfig,
} from './core.js';
import { initProject } from './workflow.js';
import { pushTheme, pushThemeBaseline } from './push.js';

const args = process.argv.slice(2);
const command = args[0] ?? '--help';
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const has = (flag: string): boolean => args.includes(flag);
const help = () => console.log(`sgd 0.3.0

Commands:
  configure  create .shopguard/project.json for this client project
  init       import an existing Live theme or create a new skeleton
  setup      add quality tooling, VS Code defaults and optional hooks
  status     show actionable project and integration state
  doctor     read-only diagnostics with safe fix guidance
  dev        start a confirmed development-theme upload
  sync       fetch refs and safely fast-forward the current branch
  pull       preview a remote-theme snapshot; optionally import new files
  push       guarded unpublished-theme upload; pass --baseline first
  preflight  release and protected-file checks
  lint       run Theme Check and configured project linters
  format     format changed theme files only
  check      run read-only quality gates

Setup options:
  --e2e             include Playwright and axe dependencies
  --hooks           install a reversible local pre-commit hook
  --uninstall-hooks remove only the hook created by ShopGuard`);

function createPrompt(): (message: string, expected: string) => Promise<boolean> {
  return async (message, expected) => {
    if (!stdin.isTTY) return false;
    const terminal = createInterface({ input: stdin, output: stdout });
    try { return (await terminal.question(`${message}\nType exactly: ${expected}\n> `)).trim() === expected; }
    finally { terminal.close(); }
  };
}

function rootFromArg(): string { return resolve(value('--path') ?? process.cwd()); }
function projectRoot(): string { return findRoot(rootFromArg()); }
function fail(message: string): never { throw new Error(message); }

function ukrainianError(message: string): string {
  const translations: Array<[string, string]> = [
    ['No .shopguard/project.json found.', 'Не знайдено .shopguard/project.json.'],
    ['Working tree is dirty;', 'Робоче дерево має локальні зміни;'],
    ['Working tree has local changes.', 'У робочому дереві є локальні зміни.'],
    ['No client Git repository/origin configured.', 'Git-репозиторій клієнта або origin не налаштовано.'],
    ['No client origin configured', 'Origin клієнтського репозиторію не налаштовано'],
    ['Store verification was not confirmed.', 'Перевірку магазину не підтверджено.'],
    ['Development was not confirmed.', 'Розробку не підтверджено.'],
    ['Shopify pull was not confirmed.', 'Завантаження теми Shopify не підтверджено.'],
    ['Snapshot import was not confirmed.', 'Імпорт snapshot не підтверджено.'],
    ['Remote preflight fetch was not confirmed.', 'Отримання даних для preflight не підтверджено.'],
    ['Refusing development on a Live theme', 'Відхилено запуск розробки на Live-темі'],
    ['No .shopguard/project.json found. Copy .shopguard/project.example.json and set the store domain.', 'Не знайдено .shopguard/project.json. Скопіюй .shopguard/project.example.json і вкажи домен магазину.'],
  ];
  for (const [english, ukrainian] of translations) if (message.startsWith(english)) return `${ukrainian}${message.slice(english.length)}`;
  if (message.startsWith('Unknown command:')) return `Невідома команда:${message.slice('Unknown command:'.length)}`;
  return `Помилка ShopGuard: ${message}`;
}

async function main(): Promise<void> {
  if (command === '--help' || command === '-h') return help();
  if (command === '--version' || command === '-v') return console.log('0.3.0');
  if (command === 'configure') {
    const root = rootFromArg();
    const store = value('--store');
    if (!store) fail('configure requires --store <store.myshopify.com>');
    const config = validateConfig({ store, mode: value('--mode') ?? 'existing', authAlias: value('--auth-alias'), themeId: value('--theme-id'), themeRole: value('--theme-role'), productionBranch: value('--production-branch') ?? 'master', developmentBranch: value('--development-branch') ?? 'dev', ...(has('--manual-unconnected') ? { github: { connected: false } } : {}) });
    mkdirSync(join(root, '.shopguard'), { recursive: true });
    saveConfig(root, config);
    console.log(`Created ${join(root, '.shopguard', 'project.json')} for ${config.store}. Review it, then run sgd init.`);
    return;
  }
  if (command === 'init') {
    const root = findRoot(rootFromArg());
    const config = loadConfig(root);
    if (has('--plan')) {
      const state = gitState(root);
      guardClientRepository(state.remote);
      const stages = config.mode === 'new'
        ? '1. Download Shopify skeleton to an isolated temporary folder\n2. Preview import\n3. Copy new files only'
        : '1. Read-only theme list\n2. Confirm the unique Live theme\n3. Pull to a fresh isolated temporary folder\n4. Preview writes and preserve conflicts\n5. Copy new files only';
      console.log(`Plan for ${config.store}:\n${stages}\nGit: ${state.inside ? `${state.branch}; origin=${state.remote || 'none'}` : 'not initialized'}\nNo remote writes or Live theme changes.`);
      return;
    }
    await initProject(root, config, { run: (bin, binArgs, cwd) => run(bin, binArgs, cwd, true), prompt: createPrompt(), output: console.log });
    return;
  }
  if (command === 'setup') {
    const root = projectRoot();
    const created = setupLocal(root);
    console.log(created.length ? `Створено конфігурацію:\n${created.map((file) => `- ${file}`).join('\n')}` : 'Конфігурація вже актуальна; файли не змінювалися.');
    if (has('--hooks') || has('--uninstall-hooks')) {
      const result = managePreCommitHook(root, has('--uninstall-hooks'));
      console.log(result === 'installed' ? 'Встановлено локальний pre-commit hook.' : result === 'removed' ? 'Видалено pre-commit hook ShopGuard.' : 'Pre-commit hook без змін.');
    }
    const missing = missingSetupDependencies(root, has('--e2e'));
    if (missing.length) {
      const manager = packageManagerCommand(root);
      const installCommand = `${manager.command} ${[...manager.installArgs, ...missing].join(' ')}`;
      console.log(`Відсутні залежності: ${missing.join(', ')}\nКоманда встановлення: ${installCommand}`);
      if (await createPrompt()(`ShopGuard виконає цю команду та оновить package.json і lockfile.`, `INSTALL ${missing.length}`)) {
        const installed = run(manager.command, [...manager.installArgs, ...missing], root, true);
        console.log(installed.output);
        if (!installed.ok) fail('Не вдалося встановити залежності через npm. Перевір повідомлення вище.');
      } else console.log(`Для ручного встановлення виконай: ${installCommand}`);
    }
    if (has('--e2e')) console.log('E2E запускаються лише за SHOPGUARD_PREVIEW_URL; без нього тести пропускаються. Встановлення браузера: npx playwright install chromium.');
    return;
  }
  if (command === 'status') {
    const root = projectRoot(); const config = loadConfig(root); const { checks, git } = diagnoseProject(root);
    const baseline = config.themeId && existsSync(join(root, '.shopguard', 'baselines', config.themeId, 'latest.json')) ? 'збережений' : 'не збережений';
    const githubState = config.github?.connected === false ? 'позначено відключеним (не перевірено в Shopify Admin)' : config.github?.connected === true ? 'позначено підключеним' : 'не налаштовано';
    console.log(`Проєкт: ${root}\nМагазин: ${config.store}\nДоступ до магазину: не перевірявся (sgd doctor --verify-store)\nLive theme ID: ${config.liveThemeId ?? 'ще не імпортовано'}\nЦіль завантаження: ${config.themeId ? `${config.themeId} (${config.themeRole ?? 'роль не підтверджена'})` : 'не налаштована'}\nBaseline цілі: ${baseline}\nГілка: ${git.branch}\nOrigin: ${git.remote || 'не налаштований'}\nРобоче дерево: ${git.dirty ? 'є локальні зміни' : 'чисте'}\nЗв’язок теми з GitHub: ${githubState}\n\nПеревірки:\n${checks.map((item) => `${item.ok ? '✓' : '✗'} ${item.label}: ${item.detail}${item.ok ? '' : ` — дія: ${item.fix}`}`).join('\n')}`);
    return;
  }
  if (command === 'doctor') {
    const root = rootFromArg();
    try {
      const project = findRoot(root); const { checks } = diagnoseProject(project);
      console.log(`Діагностика: ${project}\n${checks.map((item) => `${item.ok ? '✓' : '✗'} ${item.label}: ${item.detail}${item.ok ? '' : `\n  Як виправити: ${item.fix}`}`).join('\n')}`);
    } catch (error) { console.log(`Конфігурацію ShopGuard не знайдено. ${error instanceof Error ? error.message : ''}\nДія: sgd configure --store <store>.myshopify.com`); }
    if (has('--verify-store')) {
      const project = findRoot(root); const config = loadConfig(project);
      if (!await createPrompt()(`Буде надіслано read-only запит списку тем до ${config.store}.`, `LIST ${config.store}`)) fail('Перевірку магазину не підтверджено.');
      const result = run('shopify', shopifyCommandArgs(config, ['theme', 'list', '--json', '--path', project]), project, true);
      if (!result.ok) fail(`Не вдалося перевірити доступ до ${config.store}. Увійди вручну; ShopGuard не виконував вихід з акаунту.`);
      const themes = parseThemeList(result.output, config.store); console.log(`Доступ підтверджено для ${config.store}; отримано тем: ${themes.length}.`);
    }
    return;
  }
  if (command === 'dev') {
    const root = projectRoot(); const config = loadConfig(root);
    if (config.themeRole === 'live') fail('Refusing development on a Live theme');
    const devArgs = shopifyCommandArgs(config, ['theme', 'dev', '--path', root]);
    const listed = run('shopify', remoteThemeArgs(config), root, true);
    if (!listed.ok) fail(`Could not verify themes for ${config.store}; development was not started. ${listed.output}`);
    parseThemeList(listed.output, config.store);
    console.log(`Target store verified: ${config.store}. Shopify CLI may upload the current theme to a development theme.\nshopify ${devArgs.join(' ')}`);
    if (!await createPrompt()(`Start Shopify development for ${config.store}?`, `DEV ${config.store}`)) fail('Development was not confirmed.');
    const result = await runInteractive('shopify', devArgs, root);
    if (result.signal === 'SIGINT') {
      console.log('\nShopify preview зупинено.');
      return;
    }
    if (result.code !== 0) fail(`Shopify preview завершився з кодом ${result.code ?? result.signal ?? 'невідомо'}.`);
    return;
  }
  if (command === 'sync') {
    const root = projectRoot(); const git = gitState(root);
    if (!git.inside || !git.remote) fail('No client Git repository/origin configured.');
    guardClientRepository(git.remote);
    if (git.dirty && !has('--check')) fail('Working tree is dirty; commit or review local changes before fast-forward.');
    const expectation = has('--check') ? `FETCH ${git.remote}` : `SYNC ${git.branch}`;
    if (!await createPrompt()(`Fetch refs from ${git.remote}${has('--check') ? ' and inspect divergence' : `, then fast-forward ${git.branch} only if possible`}.`, expectation)) fail('Git synchronization was not confirmed.');
    const fetched = run('git', ['fetch', '--prune', 'origin'], root, true);
    if (!fetched.ok) fail(`Git fetch failed: ${fetched.output}`);
    const branches = [...new Set([git.branch, loadConfig(root).productionBranch, loadConfig(root).developmentBranch])];
    for (const branch of branches) {
      const counts = run('git', ['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`], root, true);
      if (!counts.ok) { console.log(`${branch}: no remote tracking branch origin/${branch}`); continue; }
      const [ahead = '0', behind = '0'] = counts.output.trim().split(/\s+/);
      console.log(`${branch}: local ahead ${ahead}, remote ahead ${behind}`);
      if (!has('--check') && branch === git.branch) {
        if (Number(ahead) > 0 && Number(behind) > 0) fail(`${branch} has diverged; refusing automatic merge/rebase.`);
        if (Number(behind) > 0) {
          const merged = run('git', ['merge', '--ff-only', `origin/${branch}`], root, true);
          if (!merged.ok) fail(`Fast-forward failed: ${merged.output}`);
          console.log(`Fast-forwarded ${branch}.`);
        }
      }
    }
    return;
  }
  if (command === 'pull') {
    const root = projectRoot(); const config = loadConfig(root);
    const git = gitState(root);
    if (git.dirty) fail('Working tree is dirty; commit or review local changes before importing a Shopify snapshot.');
    const target = value('--theme') ?? config.liveThemeId;
    if (!target) fail('pull requires --theme <id> or an imported liveThemeId in project.json');
    const listed = run('shopify', remoteThemeArgs(config), root, true);
    if (!listed.ok) fail(`Could not verify themes for ${config.store}; pull stopped. ${listed.output}`);
    const theme = parseThemeList(listed.output, config.store).find((item) => item.id === target);
    if (!theme) fail(`Theme ${target} is not present in the current theme list for ${config.store}.`);
    if (theme.role === 'development') fail('Refusing to use a transient development theme as a snapshot source.');
    const base = join(root, '.shopguard', 'snapshots');
    mkdirSync(base, { recursive: true });
    const snapshot = mkdtempSync(join(base, 'remote-'));
    const commandArgs = pullArgs(config, target, snapshot);
    console.log(`Verified source: ${theme.name} (${theme.role}), ${config.store}. Snapshot: ${snapshot}\nshopify ${commandArgs.join(' ')}`);
    if (!await createPrompt()(`Download this remote theme into an isolated ignored snapshot?`, `PULL ${target}`)) fail('Shopify pull was not confirmed.');
    const downloaded = run('shopify', commandArgs, root, true);
    if (!downloaded.ok) fail(`Shopify pull failed: ${downloaded.output}`);
    const preview = planThemeImport(snapshot, root);
    console.log(`Snapshot preview: ${preview.added.length} new files; ${preview.conflicts.length} existing files preserved.${preview.protectedConflicts.length ? ` Protected conflicts: ${preview.protectedConflicts.join(', ')}` : ''}`);
    if (has('--preview')) return;
    const selected = value('--files')?.split(',').map((file) => file.trim()).filter(Boolean) ?? [];
    if (!selected.length) { console.log(`Review snapshot at ${snapshot}; rerun with --files <comma-separated-paths> to import selected new files.`); return; }
    const invalid = selected.filter((file) => !preview.added.includes(file));
    if (invalid.length) fail(`Only new files may be imported; conflicts or unknown paths: ${invalid.join(', ')}`);
    if (!await createPrompt()(`Import ${selected.length} selected files; existing files will remain untouched?`, `IMPORT ${config.store}`)) fail('Snapshot import was not confirmed.');
    importNewFiles(snapshot, root, selected);
    console.log(`Imported ${selected.length} files from ${theme.name}.`);
    return;
  }
  if (command === 'push') {
    const root = projectRoot(); const config = loadConfig(root);
    const dependencies = { run: (bin: string, binArgs: string[], cwd: string) => run(bin, binArgs, cwd, true), prompt: createPrompt(), output: console.log };
    if (has('--baseline')) {
      await pushThemeBaseline(root, config, dependencies);
      return;
    }
    const selected = value('--files')?.split(',').map((file) => file.trim()).filter(Boolean);
    const uploaded = await pushTheme(root, config, selected, dependencies);
    console.log(`Verified upload: ${uploaded.join(', ')}`);
    return;
  }
  if (command === 'preflight') {
    const root = projectRoot(); const config = loadConfig(root);
    const result = preflight(root);
    console.log(`Dirty: ${result.dirty}\nProtected files: ${result.protectedFiles.length ? result.protectedFiles.join(', ') : 'none'}\nIssues: ${result.issues.length ? result.issues.join('; ') : 'none'}`);
    let issues = [...result.issues];
    if (has('--fetch')) {
      const git = gitState(root);
      if (!git.remote) fail('No client origin configured for remote preflight.');
      guardClientRepository(git.remote);
      if (!await createPrompt()(`Fetch ${git.remote} to compare production/development branches and merchant JSON drift.`, 'FETCH origin')) fail('Remote preflight fetch was not confirmed.');
      const fetched = run('git', ['fetch', 'origin'], root, true);
      if (!fetched.ok) fail(`Remote preflight fetch failed: ${fetched.output}`);
      const remote = remotePreflight(root, config.productionBranch, config.developmentBranch);
      for (const branch of remote.branches) {
        console.log(`${branch.name}: local ahead ${branch.ahead}, remote ahead ${branch.behind}; remote protected JSON: ${branch.protectedFiles.join(', ') || 'none'}`);
        if (branch.protectedFiles.length) issues.push(`${branch.name} has remote merchant-managed JSON changes`);
      }
      console.log(`Protected JSON difference ${config.developmentBranch} → ${config.productionBranch}: ${remote.releaseProtectedFiles.join(', ') || 'none'}`);
      if (remote.releaseProtectedFiles.length) issues.push('Production/development differ on protected merchant-managed JSON');
      issues.push(...remote.issues);
      if (issues.length) console.log(`Preflight findings: ${issues.join('; ')}`);
    } else console.log('Remote commits were not fetched; use --fetch for GitHub branch and Shopify-originated change checks.');
    if (issues.length) process.exitCode = 1;
    return;
  }
  if (command === 'lint' || command === 'check') {
    const root = projectRoot();
    const errors = checkProject(root);
    if (errors.length) fail(errors.join('\n'));
    const checks: [string, string[]][] = [];
    if (isTheme(root)) checks.push(['shopify', ['theme', 'check', '--path', root, '--no-input']]);
    if (existsSync(join(root, 'eslint.config.js')) || existsSync(join(root, 'eslint.config.mjs')) || existsSync(join(root, '.eslintrc.json'))) {
      if (existsSync(join(root, 'node_modules/.bin/eslint'))) checks.push(['npx', ['--no-install', 'eslint', '.']]);
      else console.log('ESLint config found but dependency is missing; install it in this theme project to enable the check.');
    }
    const cssFiles = listFiles(root).filter((file) => /\.(css|scss)$/.test(file) && !/^(dist|node_modules|\.shopguard)\//.test(file));
    if (cssFiles.length && (existsSync(join(root, 'stylelint.config.js')) || existsSync(join(root, 'stylelint.config.mjs')) || existsSync(join(root, '.stylelintrc.json')))) {
      if (existsSync(join(root, 'node_modules/.bin/stylelint'))) checks.push(['npx', ['--no-install', 'stylelint', ...cssFiles]]);
      else console.log('Stylelint config found but dependency is missing; install it in this theme project to enable the check.');
    }
    for (const [tool, toolArgs] of checks) {
      const result = run(tool, toolArgs, root, true);
      console.log(result.output);
      if (!result.ok) fail(`${tool} quality check failed.`);
    }
    console.log(`ShopGuard config and theme structure passed${checks.length ? `; ${checks.length} tool check(s) passed` : '; no optional linter configs found'}.`);
    return;
  }
  if (command === 'format') {
    const root = projectRoot();
    const files = changedThemeFiles(root, undefined, has('--staged'));
    if (!files.length) { console.log('No changed theme files to format.'); return; }
    const forwarded = value('--files')?.split(',').map((file) => file.trim()).filter(Boolean);
    const selected = forwarded?.length ? files.filter((file) => forwarded.includes(file)) : files;
    if (forwarded?.some((file) => !selected.includes(file))) fail('Format accepts changed theme files only.');
    if (has('--check')) {
      const checked = run('npx', ['--no-install', 'prettier', '--check', ...selected], root, true);
      console.log(checked.output);
      if (!checked.ok) fail('Formatting check failed or Prettier is not installed. Run sgd setup first.');
    } else {
      const formatted = run('npx', ['--no-install', 'prettier', '--write', ...selected], root, true);
      console.log(formatted.output);
      if (!formatted.ok) fail('Formatting failed or Prettier is not installed. Run sgd setup first.');
    }
    return;
  }
  fail(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(ukrainianError(error instanceof Error ? error.message : 'Невідома помилка'));
  process.exitCode = 1;
});
