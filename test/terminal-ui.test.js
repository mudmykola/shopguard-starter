import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationDetails, runWithSpinner } from '../dist/terminal-ui.js';

test('confirmation summaries show the target and side effects without a copy-and-paste token', () => {
  const rename = confirmationDetails('RENAME STARTER REMOTE shop.myshopify.com');
  assert.match(rename, /origin → starter/);
  assert.match(rename, /віддалені зміни: немає/);

  const upload = confirmationDetails('PUSH shop.myshopify.com 12345 4');
  assert.match(upload, /shop.myshopify.com/);
  assert.match(upload, /тема ID: 12345/);
  assert.match(upload, /файлів: 4/);
  assert.doesNotMatch(upload, /PUSH shop\.myshopify\.com/);
});

test('animated command runner returns output and redacts secrets on failures', async () => {
  const quietSpinner = () => ({ start() { return this; }, succeed() { return this; }, fail() { return this; } });
  const success = await runWithSpinner(process.execPath, ['-e', 'process.stdout.write("ready")'], process.cwd(), 'test step', quietSpinner);
  assert.equal(success.ok, true);
  assert.equal(success.output, 'ready');

  const fakeToken = 'shpat_' + 'test-token-for-redaction';
  const failure = await runWithSpinner(process.execPath, ['-e', `console.error(${JSON.stringify(fakeToken)}); process.exit(1)`], process.cwd(), 'test failure', quietSpinner);
  assert.equal(failure.ok, false);
  assert.match(failure.output, /\[REDACTED\]/);
  assert.doesNotMatch(failure.output, /shpat_/);
});
