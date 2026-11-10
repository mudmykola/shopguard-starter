import test from 'node:test';
import assert from 'node:assert/strict';
import { formatThemeCheckIssue, formatThemeCheckSummary, parseThemeCheckReport, summarizeThemeCheckIssues } from '../dist/theme-check.js';

const root = '/workspace/store-theme';
const issue = (severity, filePath = `${root}/sections/main-product.liquid`) => ({
  filePath,
  check: 'LiquidTag',
  severity,
  startRow: 18,
  startColumn: 4,
  endRow: 18,
  endColumn: 20,
  message: 'Avoid this Liquid pattern.',
});

test('Theme Check JSON report parses severity, file, location and message', () => {
  const parsed = parseThemeCheckReport(JSON.stringify({
    valid: false,
    issues: [issue('error'), issue('warning', 'snippets/card-product.liquid')],
    errorCount: 1,
    warningCount: 1,
    infoCount: 0,
  }), root);

  assert.deepEqual(parsed, [
    { file: 'sections/main-product.liquid', check: 'LiquidTag', severity: 'error', line: 18, column: 4, message: 'Avoid this Liquid pattern.' },
    { file: 'snippets/card-product.liquid', check: 'LiquidTag', severity: 'warning', line: 18, column: 4, message: 'Avoid this Liquid pattern.' },
  ]);
});

test('Theme Check parser collects all environment reports and tolerates CLI text around JSON', () => {
  const output = `Shopify CLI event\n${JSON.stringify({ environments: [
    { environment: 'default', result: { issues: [issue('error')], valid: false } },
    { environment: 'production', result: { issues: [issue('warning')], valid: true } },
  ] })}\n`;
  assert.equal(parseThemeCheckReport(output, root)?.length, 2);
  assert.equal(parseThemeCheckReport('Theme Check failed: could not load config', root), undefined);
});

test('Theme Check summary counts severities and diagnostic label stays compact', () => {
  const issues = parseThemeCheckReport(JSON.stringify({ issues: [issue('error'), issue('warning'), issue('info')] }), root);
  assert.ok(issues);
  assert.deepEqual(summarizeThemeCheckIssues(issues), { errors: 1, warnings: 1, info: 1, total: 3 });
  assert.equal(formatThemeCheckSummary(issues), 'Theme Check: 3 зауваження · 1 помилка · 1 попередження · 1 інформаційне зауваження');
  assert.equal(formatThemeCheckIssue(issues[0]), 'sections/main-product.liquid:18:4 · LiquidTag · error');
});
