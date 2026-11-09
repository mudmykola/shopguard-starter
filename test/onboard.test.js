import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseStoreArgument, runOnboarding } from '../scripts/onboard.js';

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
});

const fakeSpinner = ({ text }) => ({
  start() { return this; },
  succeed(message) { this.completed = message; return this; },
  fail(message) { this.failed = message; return this; },
  text,
});

test('npm start runs bootstrap, Shopify login, configure, and init in order', async () => {
  const calls = [];
  const logs = [];
  const result = await runOnboarding('my-store.myshopify.com', {
    cwd: '/project', spinnerFactory: fakeSpinner, log(message) { logs.push(message); }, warn() {},
    async execute(command, args, options) { calls.push({ command, args, options }); return { status: 0, output: 'ℹ pass 53\nℹ skipped 3' }; },
    platform: 'darwin',
  });

  assert.equal(result, 0);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['npm', ['run', 'bootstrap']],
    ['shopify', ['auth', 'login']],
    [process.execPath, ['/project/dist/cli.js', 'configure', '--store', 'my-store.myshopify.com', '--path', '/project']],
    [process.execPath, ['/project/dist/cli.js', 'init', '--path', '/project']],
  ]);
  assert.equal(calls[0].options.stdio, 'pipe');
  assert.ok(calls.slice(1).every(({ options }) => options.stdio === 'inherit'));
  assert.ok(logs.some((message) => message.includes('Готово')));
});

test('npm start stops immediately when any setup step fails', async () => {
  const calls = [];
  const result = await runOnboarding('my-store.myshopify.com', {
    spinnerFactory: fakeSpinner,
    async execute(command, args) { calls.push([command, args]); return { status: calls.length === 2 ? 1 : 0, output: 'failed' }; },
    log() {},
    warn() {},
  });
  assert.equal(result, 1);
  assert.equal(calls.length, 2);
});
