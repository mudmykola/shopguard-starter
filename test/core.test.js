import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject } from '../dist/workflow.js';
import {
  changedThemeFiles, checkProject, findLiveTheme, guardClientRepository, guardPush, importNewFiles,
  parseThemeList, planThemeImport, preflight, protectedFiles, pullArgs,
  run, runInteractive, safeEnvironment, setupLocal, shopifyCommandArgs, validateConfig, selectableSourceThemes, selectSourceTheme,
  verifyThemeStructure, remotePreflight, managePreCommitHook, missingSetupDependencies, packageManagerCommand,
} from '../dist/core.js';
import { pushTheme, pushThemeBaseline } from '../dist/push.js';

const storeA = 'alpha.myshopify.com';
const storeB = 'beta.myshopify.com';
test('compiled sgd entrypoint is executable on Unix', { skip: process.platform === 'win32' }, () => {
  const { mode } = statSync(new URL('../dist/cli.js', import.meta.url));
  assert.ok(mode & 0o111, 'dist/cli.js must have executable permissions for npm link');
});

const liveThemes = (store = storeA) => JSON.stringify([
  { id: 123, name: 'Published theme', role: 'main', shop: store },
  { id: 456, name: 'Unpublished copy', role: 'unpublished', shop: store },
]);
const config = (store = storeA) => validateConfig({ store, mode: 'existing', productionBranch: 'master', developmentBranch: 'dev' });
const tempDir = () => mkdtempSync(join(tmpdir(), 'sgd-test-'));
const git = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
};
function clientRepo() {
  const root = tempDir();
  mkdirSync(join(root, '.shopguard'));
  writeFileSync(join(root, '.shopguard/project.json'), `${JSON.stringify(config())}\n`);
  writeFileSync(join(root, '.gitignore'), '.shopguard/project.json\n.shopguard/init-state.json\n.shopguard/snapshots/\n.shopguard/backups/\n.shopguard/baselines/\n');
  git(root, ['init', '--initial-branch', 'main']);
  git(root, ['config', 'user.name', 'ShopGuard Test']);
  git(root, ['config', 'user.email', 'shopguard-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-m', 'template baseline']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/example-owner/client-theme.git']);
  return root;
}
function stagingRepo() {
  const root = clientRepo(); const remote = tempDir();
  git(root, ['switch', '-c', 'dev']);
  for (const folder of ['layout', 'sections', 'snippets', 'templates', 'config', 'assets']) mkdirSync(join(remote, folder), { recursive: true });
  writeFileSync(join(remote, 'layout/theme.liquid'), '<html>{{ content_for_header }}{{ content_for_layout }}</html>');
  writeFileSync(join(remote, 'assets/theme.css'), 'body { color: black; }');
  writeFileSync(join(remote, 'config/settings_data.json'), '{"current":"merchant"}');
  writeFileSync(join(remote, 'templates/index.json'), '{"sections":{}}');
  cpSync(remote, root, { recursive: true });
  git(root, ['add', 'layout', 'sections', 'snippets', 'templates', 'config', 'assets']);
  git(root, ['commit', '-m', 'chore(theme): staging baseline']);
  const stagingConfig = validateConfig({ ...config(), themeId: '456', themeRole: 'unpublished', github: { connected: false } });
  writeFileSync(join(root, '.shopguard/project.json'), `${JSON.stringify(stagingConfig)}\n`);
  writeFileSync(join(root, 'assets/theme.css'), 'body { color: navy; }');
  return { root, remote, stagingConfig };
}
function fakeStagingShopify(root, remote, { decline = false, driftAfterReview = false } = {}) {
  const calls = []; const prompts = [];
  const runner = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git') return run(command, args, cwd, true);
    if (command !== 'shopify') return { ok: false, output: 'unexpected command', command };
    if (args[1] === 'list') return { ok: true, output: JSON.stringify([
      { id: '123', name: 'Live', role: 'main', shop: 'alpha.myshopify.com' },
      { id: '456', name: 'Staging', role: 'unpublished', shop: 'alpha.myshopify.com' },
    ]), command: 'shopify theme list' };
    if (args[1] === 'pull') {
      const destination = args[args.indexOf('--path') + 1];
      rmSync(destination, { recursive: true, force: true });
      cpSync(remote, destination, { recursive: true });
      return { ok: true, output: '', command: 'shopify theme pull' };
    }
    if (args[1] === 'check') return { ok: true, output: 'Theme Check passed', command: 'shopify theme check' };
    if (args[1] === 'push') {
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--only') {
          const file = args[index + 1]; mkdirSync(join(remote, file, '..'), { recursive: true }); cpSync(join(root, file), join(remote, file));
        }
      }
      return { ok: true, output: '{"theme":{"id":456,"role":"unpublished"}}', command: 'shopify theme push' };
    }
    return { ok: false, output: `unexpected Shopify command ${args.join(' ')}`, command: 'shopify' };
  };
  return {
    calls, prompts,
    run: runner,
    prompt: async (_message, expected) => {
      prompts.push(expected);
      if (driftAfterReview && expected.startsWith('PUSH ')) writeFileSync(join(remote, 'assets/theme.css'), 'body { color: maroon; }');
      return !decline;
    },
    output() {},
  };
}
function fakeWorkflow({ output = liveThemes(), failList = false, promptResults = [true, true, true, true, true], pullTree = true, chooseSourceThemeId = '123' } = {}) {
  const calls = [];
  const prompts = [];
  let promptIndex = 0;
  const runner = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git') return run(command, args, cwd, true);
    if (command === 'shopify' && args[1] === 'list') return { ok: !failList, output: failList ? 'authorization failed' : output, command: 'shopify theme list' };
    if (command === 'shopify' && args[1] === 'pull') {
      if (pullTree) {
        const themeRoot = args[args.indexOf('--path') + 1];
        for (const folder of ['layout', 'sections', 'snippets', 'templates', 'config', 'assets']) mkdirSync(join(themeRoot, folder), { recursive: true });
        writeFileSync(join(themeRoot, 'layout/theme.liquid'), '<html>{{ content_for_header }}{{ content_for_layout }}</html>');
        writeFileSync(join(themeRoot, 'config/settings_data.json'), '{"current":"fixture"}');
        writeFileSync(join(themeRoot, 'templates/index.json'), '{}');
        writeFileSync(join(themeRoot, 'assets/theme.css'), 'body{}');
      }
      return { ok: true, output: '', command: 'shopify theme pull' };
    }
    if (command === 'shopify' && args[1] === 'init') {
      const themeRoot = args[args.indexOf('--path') + 1];
      for (const folder of ['layout', 'sections', 'snippets', 'templates', 'config', 'assets']) mkdirSync(join(themeRoot, folder), { recursive: true });
      writeFileSync(join(themeRoot, 'layout/theme.liquid'), '<html>{{ content_for_header }}{{ content_for_layout }}</html>');
      writeFileSync(join(themeRoot, 'assets/theme.css'), 'body{}');
      return { ok: true, output: '', command: 'shopify theme init' };
    }
    return { ok: false, output: 'unexpected command', command: `${command} ${args.join(' ')}` };
  };
  const prompt = async (_message, expected) => {
    prompts.push(expected);
    const result = promptResults[promptIndex] ?? false;
    promptIndex += 1;
    return result;
  };
  return { calls, prompts, run: runner, prompt, chooseSourceTheme: async () => chooseSourceThemeId || undefined, output() {} };
}

test('1. Store config rejects URLs, paths, uppercase and suspicious domains', () => {
  for (const store of ['https://a.myshopify.com', 'a.myshopify.com/x', '-a.myshopify.com', 'A.myshopify.com', 'store.example.com']) {
    assert.throws(() => validateConfig({ store }));
  }
});
test('2. Two configured stores produce separate explicit Shopify targets', () => {
  const a = shopifyCommandArgs(config(storeA), ['theme', 'list', '--json']);
  const b = shopifyCommandArgs(config(storeB), ['theme', 'list', '--json']);
  assert.equal(a[a.indexOf('--store') + 1], storeA);
  assert.equal(b[b.indexOf('--store') + 1], storeB);
  assert.ok(!b.includes(storeA));
});
test('3. A successful account login is not used to retarget a different configured store', () => {
  const args = shopifyCommandArgs(config(storeB), ['theme', 'list', '--json']);
  assert.deepEqual(args.filter((arg) => arg === '--store'), ['--store']);
  assert.equal(args[args.indexOf('--store') + 1], storeB);
});
test('4. Theme list JSON from another store is rejected', () => {
  assert.throws(() => parseThemeList(liveThemes(storeA), storeB), /does not match/);
});
test('5. Unreadable Shopify output fails closed', () => {
  assert.throws(() => parseThemeList('Not authenticated', storeA), /valid JSON/);
});
test('6. Theme list must identify exactly one Live/main theme', () => {
  assert.equal(findLiveTheme(parseThemeList(liveThemes(), storeA)).id, '123');
  assert.throws(() => findLiveTheme([]), /exactly one Live/);
  assert.throws(() => findLiveTheme([{ id: 'a', name: 'A', role: 'live' }, { id: 'b', name: 'B', role: 'main' }]), /exactly one Live/);
});
test('7. Unknown roles are not interpreted as Live', () => {
  const themes = parseThemeList(JSON.stringify([{ id: 4, name: 'Theme', role: 'primary' }]), storeA);
  assert.throws(() => findLiveTheme(themes), /exactly one Live/);
});
test('7a. Source selection allows Live and unpublished themes but excludes transient development themes', () => {
  const themes = parseThemeList(JSON.stringify([
    { id: '123', name: 'Live', role: 'main', shop: storeA },
    { id: '456', name: 'Copy', role: 'unpublished', shop: storeA },
    { id: '789', name: 'Preview', role: 'development', shop: storeA },
  ]), storeA);
  assert.deepEqual(selectableSourceThemes(themes).map(({ id }) => id), ['123', '456']);
  assert.equal(selectSourceTheme(themes, '456').role, 'unpublished');
  assert.throws(() => selectSourceTheme(themes, '789'), /not a unique Live or unpublished source/);
  assert.throws(() => selectSourceTheme(themes, undefined), /No source theme was selected/);
});
test('8. Shopify args carry explicit store and supported auth alias', () => {
  const args = shopifyCommandArgs(validateConfig({ store: storeA, authAlias: 'client-account' }), ['theme', 'list', '--json']);
  assert.deepEqual(args.slice(-5), ['--store', storeA, '--no-input', '--auth-alias', 'client-account']);
});
test('9. Inherited Shopify flags and tokens never reach child processes', () => {
  assert.deepEqual(safeEnvironment({ PATH: '/bin', SHOPIFY_FLAG_STORE: storeB, SHOPIFY_CLI_THEME_TOKEN: 'shptka-secret', HOME: '/tmp' }), { PATH: '/bin', HOME: '/tmp' });
});
test('10. Pull targets the exact configured store, theme ID and isolated path', () => {
  const args = pullArgs(config(), '123', '/tmp/shopguard-snapshot');
  assert.ok(args.includes(storeA)); assert.ok(args.includes('123'));
  assert.equal(args[args.indexOf('--path') + 1], '/tmp/shopguard-snapshot');
  assert.ok(args.includes('--nodelete'));
});
test('11. Import preview separates additions from conflicts and never overwrites', () => {
  const source = tempDir(); const target = tempDir();
  try {
    mkdirSync(join(source, 'assets')); mkdirSync(join(target, 'assets'));
    writeFileSync(join(source, 'assets/new.css'), 'new'); writeFileSync(join(target, 'assets/existing.css'), 'local');
    const plan = planThemeImport(source, target);
    assert.deepEqual(plan.added, ['assets/new.css']);
    importNewFiles(source, target, plan.added);
    assert.equal(readFileSync(join(target, 'assets/existing.css'), 'utf8'), 'local');
    assert.equal(readFileSync(join(target, 'assets/new.css'), 'utf8'), 'new');
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});
test('12. Merchant-managed JSON files are explicitly protected', () => {
  assert.deepEqual(protectedFiles(['config/settings_data.json', 'templates/index.json', 'sections/header-group.json', 'assets/theme.js']), ['config/settings_data.json', 'templates/index.json', 'sections/header-group.json']);
});
test('13. Client repositories require HTTPS and cannot point to the starter', () => {
  assert.doesNotThrow(() => guardClientRepository('https://github.com/example-owner/client-theme.git'));
  assert.throws(() => guardClientRepository('https://github.com/mudmykola/shopguard-starter.git'), /starter/);
  assert.throws(() => guardClientRepository('git@github.com:owner/client.git'), /HTTPS/);
});
test('14. Full mocked init pulls Live locally and creates master/dev at the same baseline', async () => {
  const root = clientRepo(); const deps = fakeWorkflow();
  try {
    await initProject(root, config(), { ...deps, tempRoot: root });
    const master = git(root, ['rev-parse', 'master']); const dev = git(root, ['rev-parse', 'dev']);
    assert.equal(master, dev); assert.equal(git(root, ['branch', '--show-current']), 'dev');
    assert.equal(JSON.parse(readFileSync(join(root, '.shopguard/project.json'), 'utf8')).liveThemeId, '123');
    assert.equal(existsSync(join(root, 'layout/theme.liquid')), true);
    assert.deepEqual(deps.prompts, [`LIST ${storeA}`, 'PULL 123', `IMPORT ${storeA}`, `STAGE ${storeA}`, `COMMIT ${storeA}`]);
    assert.ok(deps.calls.every((call) => call.command !== 'git' || !call.args.some((arg) => arg.includes('push'))));
    assert.ok(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'list' && call.args.includes(storeA)));
    assert.ok(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'pull' && call.args.includes('123')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('14b. Init lets the operator choose an unpublished source without changing the manual push target', async () => {
  const root = clientRepo(); const deps = fakeWorkflow({ chooseSourceThemeId: '456' });
  const projectConfig = validateConfig({ ...config(), themeId: '789', themeRole: 'unpublished', github: { connected: false } });
  try {
    writeFileSync(join(root, '.shopguard/project.json'), `${JSON.stringify(projectConfig)}\n`);
    await initProject(root, projectConfig, { ...deps, tempRoot: root });
    const saved = JSON.parse(readFileSync(join(root, '.shopguard/project.json'), 'utf8'));
    assert.equal(saved.liveThemeId, '123');
    assert.equal(saved.themeId, '789');
    const pull = deps.calls.find((call) => call.command === 'shopify' && call.args[1] === 'pull');
    assert.equal(pull.args[pull.args.indexOf('--theme') + 1], '456');
    assert.equal(deps.prompts.includes('PULL 456'), true);
    assert.equal(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'push'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('14a. New-theme init creates a local Shopify skeleton without querying a store', async () => {
  const root = clientRepo(); const deps = fakeWorkflow(); const newConfig = validateConfig({ ...config(), mode: 'new' });
  try {
    writeFileSync(join(root, '.shopguard/project.json'), `${JSON.stringify(newConfig)}\n`);
    await initProject(root, newConfig, { ...deps, tempRoot: root });
    assert.equal(existsSync(join(root, 'layout/theme.liquid')), true);
    assert.equal(deps.calls.some((call) => call.command === 'shopify' && call.args.includes('list')), false);
    assert.ok(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'init' && call.args.includes('--no-input')));
    assert.equal(git(root, ['rev-parse', 'master']), git(root, ['rev-parse', 'dev']));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('15. Missing store access fails without logout or theme download', async () => {
  const root = clientRepo(); const deps = fakeWorkflow({ failList: true });
  try {
    await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /did not log out/);
    assert.equal(deps.calls.some((call) => call.args.includes('logout')), false);
    assert.equal(deps.calls.some((call) => call.args[1] === 'pull'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('16. Initialization refuses an unrecognizable Live role before downloading', async () => {
  const root = clientRepo(); const deps = fakeWorkflow({ output: JSON.stringify([{ id: '9', name: 'Theme', role: 'primary' }]) });
  try {
    await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /exactly one Live/);
    assert.equal(deps.calls.some((call) => call.args[1] === 'pull'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('17. Declining store query sends no Shopify request', async () => {
  const root = clientRepo(); const deps = fakeWorkflow({ promptResults: [false] });
  try { await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /nothing was sent/); assert.equal(deps.calls.some((call) => call.command === 'shopify'), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('18. Declining Live pull does not invoke Shopify pull', async () => {
  const root = clientRepo(); const deps = fakeWorkflow({ promptResults: [true, false] });
  try { await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /не підтверджено/); assert.equal(deps.calls.some((call) => call.args[1] === 'pull'), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('18a. Missing or invalid source selection stops before any Shopify pull', async () => {
  for (const chooseSourceThemeId of ['', '789']) {
    const root = clientRepo(); const deps = fakeWorkflow({ chooseSourceThemeId });
    try {
      await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /source theme was selected|not a unique Live or unpublished source/);
      assert.equal(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'pull'), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('19. Declining import leaves project theme files unchanged', async () => {
  const root = clientRepo(); const deps = fakeWorkflow({ promptResults: [true, true, false] });
  try { await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /project folder was not changed/); assert.equal(existsSync(join(root, 'layout/theme.liquid')), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('20. Starter origin is blocked before any Shopify request', async () => {
  const root = clientRepo(); git(root, ['remote', 'set-url', 'origin', 'https://github.com/mudmykola/shopguard-starter.git']); const deps = fakeWorkflow();
  try { await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /starter/); assert.equal(deps.calls.some((call) => call.command === 'shopify'), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('21. Dirty unrelated Git work blocks bootstrap', async () => {
  const root = clientRepo(); writeFileSync(join(root, 'notes.txt'), 'uncommitted'); const deps = fakeWorkflow();
  try { await assert.rejects(initProject(root, config(), { ...deps, tempRoot: root }), /local changes/); assert.equal(deps.calls.some((call) => call.command === 'shopify'), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('22. Existing package and tool configs are preserved by idempotent setup', () => {
  const root = tempDir();
  try { writeFileSync(join(root, 'package.json'), '{"private":true}'); writeFileSync(join(root, 'prettier.config.mjs'), 'custom'); const first = setupLocal(root); const second = setupLocal(root); assert.ok(first.length); assert.equal(second.length, 0); assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{"private":true}'); assert.equal(readFileSync(join(root, 'prettier.config.mjs'), 'utf8'), 'custom'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('23. Push refuses Live, GitHub-connected and starter targets', () => {
  assert.throws(() => guardPush(validateConfig({ store: storeA, github: { connected: true } }), 'https://github.com/owner/client.git'));
  assert.throws(() => guardPush(validateConfig({ store: storeA, themeRole: 'live' }), 'https://github.com/owner/client.git'));
  assert.throws(() => guardPush(config(), 'https://github.com/owner/shopguard-starter.git'));
});
test('24. Theme structure validation requires the complete Shopify layout', () => {
  const root = tempDir();
  try {
    for (const dir of ['layout', 'sections', 'snippets', 'templates', 'config', 'assets']) mkdirSync(join(root, dir));
    writeFileSync(join(root, 'layout/theme.liquid'), '');
    assert.deepEqual(verifyThemeStructure(root), []);
    assert.deepEqual(checkProject(root), ['Missing .shopguard/project.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('25. Failed child commands are returned as nonzero and secrets are redacted', () => {
  const result = run(process.execPath, ['-e', "process.stderr.write('failed shpat_123456789') ; process.exit(3)"], process.cwd(), true);
  assert.equal(result.ok, false); assert.match(result.output, /\[REDACTED\]/); assert.doesNotMatch(result.output, /shpat_123456789/);
});
test('26. Release preflight reports protected customizer JSON and dirty work', () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, 'config')); writeFileSync(join(root, 'config/settings_data.json'), '{}');
    const runner = (command, args) => command === 'git' && args[0] === 'rev-parse' ? { ok: true, output: 'true' } : command === 'git' && args[0] === 'status' ? { ok: true, output: ' M config/settings_data.json' } : command === 'git' && args[0] === 'diff' ? { ok: true, output: 'config/settings_data.json' } : { ok: false, output: '' };
    const result = preflight(root, runner); assert.equal(result.dirty, true); assert.ok(result.protectedFiles.includes('config/settings_data.json')); assert.ok(result.issues.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('28. Changed-file selection includes tracked and untracked theme files only', () => {
  const root = tempDir();
  try {
    const runner = (_command, args) => args[0] === 'diff'
      ? { ok: true, output: 'sections/header.liquid\nREADME.md\n' }
      : { ok: true, output: 'assets/theme.css\nnode_modules/x.js\n' };
    assert.deepEqual(changedThemeFiles(root, runner), ['assets/theme.css', 'sections/header.liquid']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('29. Remote preflight reports ahead/behind and protected Shopify-originated JSON', () => {
  const root = tempDir();
  try {
    const runner = (_command, args) => {
      if (args[0] === 'rev-list') return { ok: true, output: args[3].startsWith('master') ? '1\t2' : '0\t1' };
      if (args[0] === 'diff' && args[2] === 'master..origin/master') return { ok: true, output: 'config/settings_data.json\n' };
      if (args[0] === 'diff' && args[2] === 'dev..origin/dev') return { ok: true, output: 'assets/theme.css\n' };
      if (args[0] === 'diff') return { ok: true, output: 'templates/index.json\n' };
      return { ok: false, output: '' };
    };
    const result = remotePreflight(root, 'master', 'dev', runner);
    assert.deepEqual(result.branches.map(({ name, ahead, behind }) => ({ name, ahead, behind })), [
      { name: 'master', ahead: 1, behind: 2 }, { name: 'dev', ahead: 0, behind: 1 },
    ]);
    assert.deepEqual(result.branches[0].protectedFiles, ['config/settings_data.json']);
    assert.deepEqual(result.releaseProtectedFiles, ['templates/index.json']);
    assert.deepEqual(result.issues, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('30. Manual push captures a baseline, uploads selected staging files, and verifies before advancing baseline', async () => {
  const { root, remote, stagingConfig } = stagingRepo(); const deps = fakeStagingShopify(root, remote);
  try {
    await pushThemeBaseline(root, stagingConfig, deps);
    const uploaded = await pushTheme(root, stagingConfig, undefined, deps);
    assert.deepEqual(uploaded, ['assets/theme.css']);
    assert.equal(readFileSync(join(remote, 'assets/theme.css'), 'utf8'), 'body { color: navy; }');
    assert.equal(readFileSync(join(remote, 'config/settings_data.json'), 'utf8'), '{"current":"merchant"}');
    const command = deps.calls.find((call) => call.command === 'shopify' && call.args[1] === 'push');
    assert.ok(command.args.includes('--theme') && command.args.includes('456'));
    assert.ok(command.args.includes('--nodelete') && command.args.includes('--only') && command.args.includes('assets/theme.css'));
    assert.equal(command.args.includes('--allow-live'), false); assert.equal(command.args.includes('--publish'), false);
    assert.deepEqual(deps.prompts, [`BASELINE ${storeA} 456`, `PUSH ${storeA} 456 1`]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});
test('31. Manual push stops on selected remote drift before upload', async () => {
  const { root, remote, stagingConfig } = stagingRepo(); const deps = fakeStagingShopify(root, remote);
  try {
    await pushThemeBaseline(root, stagingConfig, deps);
    writeFileSync(join(remote, 'assets/theme.css'), 'body { color: maroon; }');
    await assert.rejects(pushTheme(root, stagingConfig, undefined, deps), /Remote drift conflicts/);
    assert.equal(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'push'), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});
test('32. Manual push stops if the target changes during confirmation', async () => {
  const { root, remote, stagingConfig } = stagingRepo(); const deps = fakeStagingShopify(root, remote, { driftAfterReview: true });
  try {
    await pushThemeBaseline(root, stagingConfig, deps);
    await assert.rejects(pushTheme(root, stagingConfig, undefined, deps), /changed after review/);
    assert.equal(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'push'), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});
test('33. Manual push refuses missing explicit unconnected confirmation and protected JSON', async () => {
  const { root, remote, stagingConfig } = stagingRepo(); const deps = fakeStagingShopify(root, remote);
  try {
    await pushThemeBaseline(root, stagingConfig, deps);
    const unknown = validateConfig({ ...stagingConfig, github: undefined });
    await assert.rejects(pushTheme(root, unknown, undefined, deps), /github.connected=false/);
    writeFileSync(join(root, 'config/settings_data.json'), '{"current":"local-edit"}');
    await assert.rejects(pushTheme(root, stagingConfig, ['config/settings_data.json'], deps), /cannot be protected/);
    assert.equal(deps.calls.some((call) => call.command === 'shopify' && call.args[1] === 'push'), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});
test('34. Manual push refuses a newly Live target and a declined upload', async () => {
  const { root, remote, stagingConfig } = stagingRepo(); const deps = fakeStagingShopify(root, remote);
  try {
    await pushThemeBaseline(root, stagingConfig, deps);
    const live = validateConfig({ ...stagingConfig, themeId: '123' });
    await assert.rejects(pushThemeBaseline(root, live, deps), /configured target is Live/);
    const declined = fakeStagingShopify(root, remote, { decline: true });
    await assert.rejects(pushTheme(root, stagingConfig, undefined, declined), /Upload declined/);
    assert.equal(declined.calls.some((call) => call.command === 'shopify' && call.args[1] === 'push'), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});
test('27. CI is offline and does not have deploy permissions', () => {
  const workflow = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
  assert.match(workflow, /contents: read/); assert.match(workflow, /npm run lint/); assert.match(workflow, /npm test/); assert.match(workflow, /npm run test:e2e/); assert.doesNotMatch(workflow, /shopify theme push|npm publish|contents: write/);
});
test('35. setup adds shared VS Code and Theme Check defaults without overwriting existing files', () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, '.vscode'), { recursive: true });
    writeFileSync(join(root, '.vscode/settings.json'), '{"custom":true}\n');
    const first = setupLocal(root);
    const second = setupLocal(root);
    assert.ok(first.includes('.vscode/extensions.json'));
    assert.ok(first.includes('.github/workflows/theme-check.yml'));
    assert.equal(readFileSync(join(root, '.vscode/settings.json'), 'utf8'), '{"custom":true}\n');
    assert.deepEqual(second, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('36. setup detects only missing tooling and optional browser dependencies', () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { eslint: '^9', prettier: '^3' } }));
    const baseMissing = missingSetupDependencies(root);
    assert.ok(baseMissing.includes('stylelint'));
    assert.ok(!baseMissing.includes('eslint'));
    assert.ok(missingSetupDependencies(root, true).includes('@playwright/test'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('37. local pre-commit hook is reversible, idempotent, and preserves existing hooks', () => {
  const root = tempDir();
  try {
    git(root, ['init', '--initial-branch', 'main']);
    assert.equal(managePreCommitHook(root), 'installed');
    assert.equal(managePreCommitHook(root), 'unchanged');
    const hook = join(root, '.git/hooks/pre-commit');
    assert.match(readFileSync(hook, 'utf8'), /sgd format --check --staged/);
    assert.equal(managePreCommitHook(root, true), 'removed');
    writeFileSync(hook, '#!/bin/sh\necho custom\n', { mode: 0o755 });
    assert.throws(() => managePreCommitHook(root), /left untouched/);
    assert.throws(() => managePreCommitHook(root, true), /left untouched/);
    assert.match(readFileSync(hook, 'utf8'), /custom/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('38. setup follows the repository package manager and stops on ambiguous lockfiles', () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    assert.deepEqual(packageManagerCommand(root), { command: 'pnpm', installArgs: ['add', '--save-dev'] });
    writeFileSync(join(root, 'yarn.lock'), '');
    assert.throws(() => packageManagerCommand(root), /Several package-manager lockfiles/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    assert.deepEqual(packageManagerCommand(root), { command: 'yarn', installArgs: ['add', '--dev'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('39. interactive Shopify dev process has no timeout and inherits terminal output', async () => {
  const root = tempDir();
  try {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    let invocation;
    const fakeSpawn = (command, args, options) => {
      invocation = { command, args, options };
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    };
    const result = await runInteractive('shopify', ['theme', 'dev'], root, fakeSpawn);
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    assert.equal(invocation.command, 'shopify');
    assert.equal(invocation.options.stdio, 'inherit');
    assert.equal(invocation.options.shell, false);
    assert.equal('timeout' in invocation.options, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('40. interactive Shopify dev reports Ctrl+C as a normal operator stop', async () => {
  const root = tempDir();
  try {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    const fakeSpawn = () => { process.nextTick(() => child.emit('exit', null, 'SIGINT')); return child; };
    const result = await runInteractive('shopify', ['theme', 'dev'], root, fakeSpawn);
    assert.equal(result.code, null); assert.equal(result.signal, 'SIGINT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
