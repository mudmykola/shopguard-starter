import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStoreArgument, runOnboarding } from '../scripts/onboard.js';

test('npm start requires a valid Shopify store domain', () => {
  assert.equal(parseStoreArgument(['--store', 'my-store.myshopify.com']), 'my-store.myshopify.com');
  assert.throws(() => parseStoreArgument([]), /npm start -- --store/);
  assert.throws(() => parseStoreArgument(['--store', 'https://my-store.myshopify.com']), /без https/);
});

test('npm start runs bootstrap, Shopify login, configure, and init in order', () => {
  const calls = [];
  const result = runOnboarding('my-store.myshopify.com', {
    cwd: '/project',
    execute(command, args, options) { calls.push({ command, args, options }); return { status: 0 }; },
    platform: 'darwin',
    log() {},
  });

  assert.equal(result, 0);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['npm', ['run', 'bootstrap']],
    ['shopify', ['auth', 'login']],
    [process.execPath, ['/project/dist/cli.js', 'configure', '--store', 'my-store.myshopify.com', '--path', '/project']],
    [process.execPath, ['/project/dist/cli.js', 'init', '--path', '/project']],
  ]);
  assert.ok(calls.every(({ options }) => options.stdio === 'inherit'));
});

test('npm start stops immediately when any setup step fails', () => {
  const calls = [];
  const result = runOnboarding('my-store.myshopify.com', {
    execute(command, args) { calls.push([command, args]); return { status: calls.length === 2 ? 1 : 0 }; },
    log() {},
  });
  assert.equal(result, 1);
  assert.equal(calls.length, 2);
});
