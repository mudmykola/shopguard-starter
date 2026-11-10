import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOnboardingArguments, parseRepositoryUrl, parseStoreArgument, runOnboarding } from '../scripts/onboard.js';

test('npm start entrypoint loads before dependencies are installed', () => {
  const coldCheckout = mkdtempSync(join(tmpdir(), 'shopguard-cold-start-'));
  try {
    writeFileSync(join(coldCheckout, 'package.json'), '{"type":"module"}');
    copyFileSync(new URL('../scripts/onboard.js', import.meta.url), join(coldCheckout, 'onboard.js'));
    const result = spawnSync(process.execPath, ['onboard.js'], { cwd: coldCheckout, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Вкажи магазин/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(coldCheckout, { recursive: true, force: true });
  }
});

test('npm start requires a valid Shopify store domain', () => {
  assert.equal(parseStoreArgument(['--store', 'my-store.myshopify.com']), 'my-store.myshopify.com');
  assert.throws(() => parseStoreArgument([]), /npm start -- --store/);
  assert.throws(() => parseStoreArgument(['--store', 'https://my-store.myshopify.com']), /без https/);
  assert.deepEqual(parseOnboardingArguments(['--store', 'my-store.myshopify.com', '--repo', 'https://github.com/example/my-store-theme']), {
    store: 'my-store.myshopify.com', repositoryUrl: 'https://github.com/example/my-store-theme.git', projectDir: undefined,
  });
  assert.equal(parseRepositoryUrl('https://github.com/example/my-store-theme.git'), 'https://github.com/example/my-store-theme.git');
  assert.throws(() => parseRepositoryUrl('git@github.com:example/my-store-theme.git'), /HTTPS URL/);
  assert.throws(() => parseRepositoryUrl('https://github.com/mudmykola/shopguard-starter.git'), /стартера/);
});

const fakeSpinner = ({ text }) => ({
  start() { return this; },
  succeed(message) { this.completed = message; return this; },
  fail(message) { this.failed = message; return this; },
  text,
});

test('npm start clones a separate empty theme repo and initializes it without copying starter files', async () => {
  const calls = [];
  const logs = [];
  const cwd = mkdtempSync(join(tmpdir(), 'shopguard-starter-onboard-'));
  const projectDir = '../shopguard-client-theme-test';
  const themeRoot = resolve(cwd, projectDir);
  try {
  const result = await runOnboarding('my-store.myshopify.com', {
    cwd, projectDir, repositoryUrl: 'https://github.com/example/client-theme.git',
    spinnerFactory: fakeSpinner, log(message) { logs.push(message); }, warn() {},
    async execute(command, args, options) {
      calls.push({ command, args, options });
      if (command === 'git' && args[0] === 'rev-parse') return { status: 1, output: '' };
      return { status: 0, output: 'ℹ pass 56\nℹ skipped 3' };
    },
    platform: 'darwin',
  });

  assert.equal(result, 0);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['npm', ['run', 'bootstrap']],
    ['git', ['clone', 'https://github.com/example/client-theme.git', themeRoot]],
    ['git', ['rev-parse', '--verify', 'HEAD']],
    ['shopify', ['auth', 'login']],
    [process.execPath, [join(cwd, 'dist/cli.js'), 'configure', '--store', 'my-store.myshopify.com', '--path', themeRoot]],
    [process.execPath, [join(cwd, 'dist/cli.js'), 'init', '--path', themeRoot]],
  ]);
  assert.equal(calls[0].options.stdio, 'pipe');
  assert.ok(calls.slice(1, 2).every(({ options }) => options.stdio === 'inherit'));
  assert.ok(calls.slice(3).every(({ options }) => options.stdio === 'inherit'));
  assert.ok(logs.some((message) => message.includes('Starter залишився окремо')));
  assert.ok(logs.some((message) => message.includes('Готово')));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('npm start without --repo creates a separate local-only theme workspace', async () => {
  const calls = [];
  const logs = [];
  const cwd = mkdtempSync(join(tmpdir(), 'shopguard-local-onboard-'));
  const projectDir = `../${basename(cwd)}-theme`;
  const themeRoot = resolve(cwd, projectDir);
  try {
    const result = await runOnboarding('my-store.myshopify.com', {
      cwd, projectDir, spinnerFactory: fakeSpinner, log(message) { logs.push(message); }, warn() {},
      async execute(command, args, options) { calls.push({ command, args, options }); return { status: 0, output: 'ℹ pass 58' }; },
      platform: 'darwin',
    });
    assert.equal(result, 0);
    assert.equal(calls.some(({ command }) => command === 'git'), false);
    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
      ['npm', ['run', 'bootstrap']],
      ['shopify', ['auth', 'login']],
      [process.execPath, [join(cwd, 'dist/cli.js'), 'configure', '--store', 'my-store.myshopify.com', '--path', themeRoot]],
      [process.execPath, [join(cwd, 'dist/cli.js'), 'init', '--path', themeRoot]],
    ]);
    assert.equal(existsSync(themeRoot), true);
    assert.ok(logs.some((message) => message.includes('GitHub поки не під’єднано')));
  } finally { rmSync(themeRoot, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test('npm start stops immediately when any setup step fails', async () => {
  const calls = [];
  const result = await runOnboarding('my-store.myshopify.com', {
    projectDir: '../shopguard-onboarding-failure-test', repositoryUrl: 'https://github.com/example/client-theme.git',
    spinnerFactory: fakeSpinner,
    async execute(command, args) { calls.push([command, args]); return { status: calls.length === 2 ? 1 : 0, output: 'failed' }; },
    log() {},
    warn() {},
  });
  assert.equal(result, 1);
  assert.equal(calls.length, 2);
});

test('npm start refuses a non-empty theme repository before Shopify login', async () => {
  const calls = [];
  await assert.rejects(runOnboarding('my-store.myshopify.com', {
    cwd: process.cwd(), projectDir: '../shopguard-nonempty-theme-test', repositoryUrl: 'https://github.com/example/client-theme.git',
    spinnerFactory: fakeSpinner, log() {}, warn() {},
    async execute(command, args) {
      calls.push([command, args]);
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, output: 'existing-commit' };
      return { status: 0, output: 'ℹ pass 55' };
    },
  }), /Репозиторій теми не порожній/);
  assert.equal(calls.some(([command]) => command === 'shopify'), false);
});
