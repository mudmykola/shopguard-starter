import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export type ProjectConfig = {
  store: string;
  mode: 'existing' | 'new';
  authAlias?: string;
  themeId?: string;
  themeRole?: 'live' | 'unpublished' | 'development';
  liveThemeId?: string;
  productionBranch: string;
  developmentBranch: string;
  github?: { remote?: string; connected?: boolean };
};

export type ShopifyTheme = { id: string; name: string; role: string; shop?: string };
export type CommandResult = { ok: boolean; output: string; command: string };
export type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult;

const STORE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const PROTECTED = [/^config\/settings_data\.json$/, /^templates\/.*\.json$/, /^sections\/.*-group\.json$/];
export const THEME_DIRS = ['layout', 'sections', 'snippets', 'templates', 'config', 'assets'];

export function validateConfig(input: unknown): ProjectConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project configuration');
  const data = input as Record<string, unknown>;
  if (typeof data.store !== 'string' || !STORE_RE.test(data.store)) {
    throw new Error('Store must be a canonical lowercase myshopify.com domain');
  }
  const mode = data.mode ?? 'existing';
  if (mode !== 'existing' && mode !== 'new') throw new Error('mode must be existing or new');
  const productionBranch = typeof data.productionBranch === 'string' ? data.productionBranch : 'master';
  const developmentBranch = typeof data.developmentBranch === 'string' ? data.developmentBranch : 'dev';
  if (!validBranch(productionBranch) || !validBranch(developmentBranch) || productionBranch === developmentBranch) {
    throw new Error('Production and development branches must be valid and different');
  }
  if (data.authAlias !== undefined && (typeof data.authAlias !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.authAlias))) {
    throw new Error('Invalid authAlias');
  }
  if (data.themeRole !== undefined && !['live', 'unpublished', 'development'].includes(String(data.themeRole))) {
    throw new Error('Invalid themeRole');
  }
  if (data.themeId !== undefined && (typeof data.themeId !== 'string' || !/^\d+$/.test(data.themeId))) {
    throw new Error('themeId must be a numeric Shopify theme ID');
  }
  return {
    store: data.store,
    mode,
    productionBranch,
    developmentBranch,
    ...(typeof data.authAlias === 'string' ? { authAlias: data.authAlias } : {}),
    ...(typeof data.themeId === 'string' ? { themeId: data.themeId } : {}),
    ...(typeof data.liveThemeId === 'string' ? { liveThemeId: data.liveThemeId } : {}),
    ...(typeof data.themeRole === 'string' ? { themeRole: data.themeRole as ProjectConfig['themeRole'] } : {}),
    ...(data.github && typeof data.github === 'object' ? { github: data.github as ProjectConfig['github'] } : {}),
  };
}

function validBranch(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..') && !branch.endsWith('/') && !branch.endsWith('.');
}

export function findRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.shopguard', 'project.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('No .shopguard/project.json found. Copy .shopguard/project.example.json and set the store domain.');
    dir = parent;
  }
}

export function loadConfig(root: string): ProjectConfig {
  return validateConfig(JSON.parse(readFileSync(join(root, '.shopguard', 'project.json'), 'utf8')));
}

export function saveConfig(root: string, config: ProjectConfig): void {
  writeFileSync(join(root, '.shopguard', 'project.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
}

export function shopifyArgs(config: ProjectConfig, command = 'theme list'): string[] {
  return [
    ...command.split(' '),
    '--store', config.store,
    '--no-input',
    '--path', process.cwd(),
    ...(config.authAlias ? ['--auth-alias', config.authAlias] : []),
  ];
}

export function safeEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => value !== undefined && !key.startsWith('SHOPIFY_')),
  ) as Record<string, string>;
}

export function run(command: string, args: string[], cwd: string, execute = false): CommandResult {
  const printable = [command, ...args].join(' ');
  if (!execute) return { ok: true, output: `[dry-run] ${printable}`, command: printable };
  const result = spawnSync(command, args, {
    cwd,
    env: safeEnvironment(process.env),
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(
    /(shpat_|shpss_|shptka_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g,
    '[REDACTED]',
  );
  return { ok: result.status === 0, output, command: printable };
}

export function shopifyCommandArgs(config: ProjectConfig, args: string[]): string[] {
  return [...args, '--store', config.store, '--no-input', ...(config.authAlias ? ['--auth-alias', config.authAlias] : [])];
}

export function parseThemeList(output: string, expectedStore: string): ShopifyTheme[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error('Shopify theme list did not return valid JSON; store access remains unverified');
  }
  const themes = findThemes(parsed);
  if (!themes || themes.length === 0) throw new Error('Shopify returned no recognizable themes for the configured store');
  const normalized = themes.map((theme) => {
    if (!theme || typeof theme !== 'object') throw new Error('Shopify returned an invalid theme record');
    const row = theme as Record<string, unknown>;
    if (row.shop !== undefined && normalizeStore(row.shop) !== expectedStore) {
      throw new Error('Shopify response store does not match .shopguard/project.json');
    }
    if (row.store !== undefined && normalizeStore(row.store) !== expectedStore) {
      throw new Error('Shopify response store does not match .shopguard/project.json');
    }
    if (row.id === undefined || typeof row.name !== 'string' || typeof row.role !== 'string') {
      throw new Error('Shopify returned a theme without an ID, name, or role; refusing to guess Live');
    }
    return { id: String(row.id), name: row.name, role: normalizeRole(row.role), ...(typeof row.shop === 'string' ? { shop: row.shop } : {}) };
  });
  return normalized;
}

function findThemes(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.themes)) return object.themes;
  for (const key of ['data', 'result', 'payload']) {
    const found = findThemes(object[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function normalizeStore(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

function normalizeRole(role: string): string {
  const value = role.toLowerCase();
  return value === 'main' ? 'live' : value;
}

export function findLiveTheme(themes: ShopifyTheme[]): ShopifyTheme {
  const live = themes.filter((theme) => ['live', 'main'].includes(theme.role.toLowerCase()));
  if (live.length !== 1) throw new Error(`Expected exactly one Live theme; Shopify reported ${live.length}. Refusing to choose.`);
  return live[0]!;
}

export function pullArgs(config: ProjectConfig, themeId: string, path: string): string[] {
  return shopifyCommandArgs(config, ['theme', 'pull', '--theme', themeId, '--path', path, '--nodelete']);
}

export function verifyThemeStructure(root: string): string[] {
  const missing = THEME_DIRS.filter((dir) => !existsSync(join(root, dir)) || !statSync(join(root, dir)).isDirectory());
  if (!existsSync(join(root, 'layout', 'theme.liquid'))) missing.push('layout/theme.liquid');
  return missing;
}

export function listFiles(root: string, dir = root): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(root, full) : [relative(root, full).replaceAll('\\', '/')];
  });
}

export type ImportPlan = { added: string[]; conflicts: string[]; protectedConflicts: string[] };
export function planThemeImport(source: string, target: string): ImportPlan {
  const sourceFiles = listFiles(source);
  const added: string[] = [];
  const conflicts: string[] = [];
  for (const file of sourceFiles) (existsSync(join(target, file)) ? conflicts : added).push(file);
  const protectedConflicts = protectedFiles(conflicts);
  return { added, conflicts, protectedConflicts };
}

export function protectedFiles(files: string[]): string[] {
  return files.filter((file) => PROTECTED.some((pattern) => pattern.test(file.replaceAll('\\', '/'))));
}

export function importNewFiles(source: string, target: string, files: string[]): void {
  for (const file of files) {
    const from = join(source, file);
    const to = join(target, file);
    if (existsSync(to)) throw new Error(`Refusing to overwrite local file: ${file}`);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { errorOnExist: true, force: false, recursive: true });
  }
}

export function isTheme(root: string): boolean {
  return THEME_DIRS.every((dir) => existsSync(join(root, dir)));
}

export function setupLocal(root: string): string[] {
  const files: Record<string, string> = {
    '.gitignore': '.env*\n!.env.example\nnode_modules/\ndist/\n.shopguard/project.json\n.shopguard/auth/\n.shopguard/session/\n.shopguard/backups/\n.shopguard/baselines/\n.shopguard/cache/\n.shopguard/snapshots/\n.shopguard/init-state.json\n*.pem\n*.key\n*.p12\n*.pfx\n',
    '.editorconfig': 'root = true\n[*]\ncharset = utf-8\nindent_style = space\nindent_size = 2\nend_of_line = lf\ninsert_final_newline = true\n',
    '.prettierignore': 'node_modules\ndist\n.shopguard/backups\n.shopguard/cache\nassets/vendor\n',
    '.stylelintignore': 'node_modules\ndist\nassets/vendor\n',
    '.theme-check.yml': 'Ignore: []\n',
    'prettier.config.mjs': "export default { singleQuote: true, plugins: ['@shopify/prettier-plugin-liquid'] };\n",
    'eslint.config.mjs': "export default [{ ignores: ['dist/**', 'node_modules/**', 'assets/vendor/**', '.shopguard/**'] }, { files: ['**/*.{js,mjs,cjs}'], rules: { 'no-debugger': 'error', 'no-unreachable': 'error', 'no-duplicate-imports': 'error' } }];\n",
    'stylelint.config.mjs': "export default { ignoreFiles: ['assets/vendor/**', 'dist/**', 'node_modules/**'], rules: { 'color-no-invalid-hex': true, 'declaration-block-no-duplicate-properties': true } };\n",
    '.vscode/extensions.json': `${JSON.stringify({ recommendations: ['Shopify.theme-check-vscode', 'EditorConfig.EditorConfig', 'esbenp.prettier-vscode'] }, null, 2)}\n`,
    '.vscode/settings.json': `${JSON.stringify({ 'editor.tabSize': 2, 'editor.insertSpaces': true, 'editor.formatOnSave': true, 'editor.defaultFormatter': 'esbenp.prettier-vscode', 'files.associations': { '*.liquid': 'liquid' }, '[liquid]': { 'editor.defaultFormatter': 'Shopify.theme-check-vscode' } }, null, 2)}\n`,
    '.github/workflows/theme-check.yml': "name: Shopify Theme Check\n\non:\n  pull_request:\n  push:\n    branches: [master, dev]\n\npermissions:\n  contents: read\n\njobs:\n  theme-check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm install --global @shopify/cli@latest\n      - run: shopify theme check --path . --no-input\n",
  };
  const created: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      created.push(file);
    }
  }
  return created;
}

export const PRE_COMMIT_HOOK = '#!/bin/sh\n# shopguard-managed-pre-commit-v1\nset -eu\nsgd format --check --staged\nsgd check\n';

export function managePreCommitHook(root: string, remove = false): 'installed' | 'removed' | 'unchanged' {
  const gitPath = run('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], root, true);
  if (!gitPath.ok) throw new Error('Git hooks need an initialized repository.');
  const customPath = run('git', ['config', '--get', 'core.hooksPath'], root, true);
  if (customPath.ok && customPath.output.trim()) throw new Error('core.hooksPath is customized; existing hooks were left untouched.');
  const hookPath = resolve(root, gitPath.output.trim());
  if (remove) {
    if (!existsSync(hookPath)) return 'unchanged';
    const existing = readFileSync(hookPath, 'utf8');
    if (!existing.startsWith('#!/bin/sh\n# shopguard-managed-pre-commit-v1')) throw new Error('Existing pre-commit hook is not managed by ShopGuard; it was left untouched.');
    unlinkSync(hookPath);
    return 'removed';
  }
  if (existsSync(hookPath)) {
    if (readFileSync(hookPath, 'utf8').startsWith('#!/bin/sh\n# shopguard-managed-pre-commit-v1')) return 'unchanged';
    throw new Error('An existing pre-commit hook was found; it was left untouched.');
  }
  writeFileSync(hookPath, PRE_COMMIT_HOOK, { mode: 0o755, flag: 'wx' });
  return 'installed';
}

export function missingSetupDependencies(root: string, includeE2e = false): string[] {
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) return [];
  const project = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const known = { ...project.dependencies, ...project.devDependencies };
  const required = ['eslint', '@eslint/js', 'prettier', '@shopify/prettier-plugin-liquid', 'stylelint', 'stylelint-config-standard'];
  if (includeE2e) required.push('@playwright/test', '@axe-core/playwright');
  return required.filter((dependency) => !known[dependency]);
}

export function packageManagerCommand(root: string): { command: string; installArgs: string[] } {
  const managers = [
    { command: 'npm', lock: 'package-lock.json', installArgs: ['install', '--save-dev'] },
    { command: 'pnpm', lock: 'pnpm-lock.yaml', installArgs: ['add', '--save-dev'] },
    { command: 'yarn', lock: 'yarn.lock', installArgs: ['add', '--dev'] },
    { command: 'bun', lock: 'bun.lockb', installArgs: ['add', '--dev'] },
  ].filter(({ lock }) => existsSync(join(root, lock)));
  const declared = existsSync(join(root, 'package.json'))
    ? (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager?: string }).packageManager?.split('@')[0]
    : undefined;
  if (managers.length > 1 && !declared) throw new Error('Several package-manager lockfiles found; set packageManager in package.json before installing dependencies.');
  const declaredManager = declared && ['npm', 'pnpm', 'yarn', 'bun'].includes(declared)
    ? managers.find(({ command }) => command === declared) ?? {
      command: declared,
      installArgs: declared === 'npm' ? ['install', '--save-dev'] : declared === 'yarn' ? ['add', '--dev'] : ['add', '--save-dev'],
    }
    : undefined;
  const selected = declaredManager ?? (managers.length === 1 ? managers[0]! : { command: 'npm', installArgs: ['install', '--save-dev'] });
  return { command: selected.command, installArgs: selected.installArgs };
}

export function diagnoseProject(root: string): { checks: Array<{ label: string; ok: boolean; detail: string; fix: string }>; git: ReturnType<typeof gitState> } {
  const git = gitState(root);
  const configExists = existsSync(join(root, '.shopguard', 'project.json'));
  let validConfig = false;
  let store = '';
  if (configExists) {
    try { store = loadConfig(root).store; validConfig = true; } catch { /* summarized below */ }
  }
  const dependencies = missingSetupDependencies(root);
  const shopifyVersion = run('shopify', ['version'], root, true);
  const checks = [
    { label: 'ShopGuard config', ok: validConfig, detail: validConfig ? store : configExists ? 'invalid' : 'missing', fix: 'sgd configure --store <store>.myshopify.com' },
    { label: 'Theme structure', ok: isTheme(root) && verifyThemeStructure(root).length === 0, detail: isTheme(root) ? 'valid' : 'incomplete', fix: 'sgd init' },
    { label: 'Git repository', ok: git.inside, detail: git.inside ? git.branch : 'not initialized', fix: 'git init' },
    { label: 'Git origin', ok: Boolean(git.remote), detail: git.remote || 'not configured', fix: 'Create a private client repository and add its HTTPS URL as origin' },
    { label: 'Working tree', ok: !git.dirty, detail: git.dirty ? 'has changes' : 'clean', fix: 'Review `git status` before sync or import' },
    { label: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.versions.node, fix: 'Install Node.js 22 or newer' },
    { label: 'Shopify CLI', ok: shopifyVersion.ok, detail: shopifyVersion.output.trim().split('\n')[0] || 'not found', fix: 'Install Shopify CLI and sign in manually for the configured store' },
    { label: 'Local quality dependencies', ok: dependencies.length === 0, detail: dependencies.length ? `missing: ${dependencies.join(', ')}` : 'available', fix: 'Run `sgd setup` and confirm dependency installation' },
  ];
  return { checks, git };
}

export function checkProject(root: string): string[] {
  const errors: string[] = [];
  for (const dir of THEME_DIRS) if (!existsSync(join(root, dir))) errors.push(`Missing theme directory: ${dir}/`);
  if (!existsSync(join(root, 'layout', 'theme.liquid'))) errors.push('Missing layout/theme.liquid');
  if (!existsSync(join(root, '.shopguard', 'project.json'))) errors.push('Missing .shopguard/project.json');
  else try { loadConfig(root); } catch (error) { errors.push(`Invalid ShopGuard config: ${error instanceof Error ? error.message : 'unknown error'}`); }
  return errors;
}

export function gitState(root: string, runner: CommandRunner = (command, args, cwd) => run(command, args, cwd, true)): { branch: string; remote: string; dirty: boolean; inside: boolean } {
  const inside = runner('git', ['rev-parse', '--is-inside-work-tree'], root).ok;
  if (!inside) return { branch: 'uninitialized', remote: '', dirty: false, inside: false };
  const branch = runner('git', ['branch', '--show-current'], root);
  const remote = runner('git', ['remote', 'get-url', 'origin'], root);
  const status = runner('git', ['status', '--porcelain'], root);
  return { branch: branch.ok ? branch.output.trim() : 'unborn', remote: remote.ok ? remote.output.trim() : '', dirty: Boolean(status.output.trim()), inside: true };
}

export function isStarterRemote(remote: string): boolean {
  return /(?:shopguard-starter|shopify-theme-starter)(?:\.git)?(?:$|[/?#])/i.test(remote);
}

export function guardClientRepository(remote: string): void {
  if (isStarterRemote(remote)) throw new Error('This checkout still points to the ShopGuard starter. Create a separate client repository from the GitHub template and clone it over HTTPS.');
  if (remote && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(remote)) {
    throw new Error('Client origin must be an HTTPS GitHub repository URL');
  }
}

export function guardPush(config: ProjectConfig, gitRemote: string, targetLive = false): void {
  if (config.github?.connected) throw new Error('Refusing sgd push: theme is GitHub-connected; use git push origin dev');
  if (config.themeRole === 'live' || targetLive) throw new Error('Refusing sgd push: Live themes are protected');
  if (isStarterRemote(gitRemote)) throw new Error('Refusing push to starter repository; configure a client-specific origin');
}

export function preflight(root: string, runner?: CommandRunner): { protectedFiles: string[]; dirty: boolean; issues: string[] } {
  const state = gitState(root, runner);
  const changed = runner
    ? runner('git', ['diff', '--name-only', 'HEAD'], root)
    : run('git', ['diff', '--name-only', 'HEAD'], root, true);
  const untracked = runner
    ? runner('git', ['ls-files', '--others', '--exclude-standard'], root)
    : run('git', ['ls-files', '--others', '--exclude-standard'], root, true);
  const files = [...changed.output.split('\n'), ...untracked.output.split('\n')].filter(Boolean);
  const protectedChanged = protectedFiles(files);
  const issues = [...(state.dirty ? ['Working tree is dirty'] : []), ...(protectedChanged.length ? ['Protected merchant-managed JSON requires review'] : [])];
  return { protectedFiles: protectedChanged, dirty: state.dirty, issues };
}

export function changedThemeFiles(root: string, runner: CommandRunner = (command, args, cwd) => run(command, args, cwd, true), staged = false): string[] {
  const tracked = staged
    ? runner('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB'], root)
    : runner('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'], root);
  const untracked = staged ? { output: '' } : runner('git', ['ls-files', '--others', '--exclude-standard'], root);
  return [...new Set([...tracked.output.split('\n'), ...untracked.output.split('\n')]
    .map((file) => file.trim()).filter((file) => /\.(liquid|css|js|ts|json|scss)$/.test(file)
      && !/^(dist|node_modules|\.shopguard|\.git)\//.test(file)
      && protectedFiles([file]).length === 0))].sort();
}

export function remoteThemeArgs(config: ProjectConfig): string[] {
  return shopifyCommandArgs(config, ['theme', 'list', '--json']);
}

export type RemotePreflight = {
  branches: Array<{ name: string; ahead: number; behind: number; protectedFiles: string[] }>;
  releaseProtectedFiles: string[];
  issues: string[];
};

export function remotePreflight(
  root: string,
  production: string,
  development: string,
  runner: CommandRunner = (command, args, cwd) => run(command, args, cwd, true),
): RemotePreflight {
  const issues: string[] = [];
  const branches = [production, development].map((name) => {
    const counts = runner('git', ['rev-list', '--left-right', '--count', `${name}...origin/${name}`], root);
    if (!counts.ok) {
      issues.push(`Remote branch origin/${name} is unavailable.`);
      return { name, ahead: 0, behind: 0, protectedFiles: [] };
    }
    const [ahead = '0', behind = '0'] = counts.output.trim().split(/\s+/);
    const changed = runner('git', ['diff', '--name-only', `${name}..origin/${name}`], root);
    if (!changed.ok) issues.push(`Could not compare local ${name} with origin/${name}.`);
    return {
      name,
      ahead: Number(ahead),
      behind: Number(behind),
      protectedFiles: changed.ok ? protectedFiles(changed.output.split('\n').filter(Boolean)) : [],
    };
  });
  const release = runner('git', ['diff', '--name-only', `origin/${development}..origin/${production}`], root);
  if (!release.ok) issues.push(`Could not compare origin/${development} with origin/${production}.`);
  return {
    branches,
    releaseProtectedFiles: release.ok ? protectedFiles(release.output.split('\n').filter(Boolean)) : [],
    issues,
  };
}
