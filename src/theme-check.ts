import { isAbsolute, relative, resolve, sep } from 'node:path';

export type ThemeCheckSeverity = 'error' | 'warning' | 'info';

export interface ThemeCheckIssue {
  file: string;
  check: string;
  severity: ThemeCheckSeverity;
  line: number;
  column: number;
  message: string;
}

export interface ThemeCheckSummary {
  errors: number;
  warnings: number;
  info: number;
  total: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function normalizeIssue(value: unknown, root: string): ThemeCheckIssue | undefined {
  if (!isRecord(value)) return undefined;
  const { filePath, check, severity, startRow, startColumn, message } = value;
  if (typeof filePath !== 'string' || typeof check !== 'string' || !['error', 'warning', 'info'].includes(String(severity))) return undefined;
  if (typeof startRow !== 'number' || typeof startColumn !== 'number' || typeof message !== 'string') return undefined;
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const localPath = relative(root, absolutePath);
  const file = localPath && localPath !== '..' && !localPath.startsWith(`..${sep}`) ? localPath : filePath;
  return { file, check, severity: severity as ThemeCheckSeverity, line: startRow, column: startColumn, message };
}

function collectIssues(value: unknown, root: string, issues: ThemeCheckIssue[]): boolean {
  if (Array.isArray(value)) {
    let foundReport = false;
    for (const item of value) foundReport = collectIssues(item, root, issues) || foundReport;
    return foundReport;
  }
  if (!isRecord(value)) return false;
  let foundReport = false;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'issues' && Array.isArray(nested)) {
      foundReport = true;
      for (const item of nested) {
        const issue = normalizeIssue(item, root);
        if (issue) issues.push(issue);
      }
    } else if (isRecord(nested) || Array.isArray(nested)) {
      foundReport = collectIssues(nested, root, issues) || foundReport;
    }
  }
  return foundReport;
}

export function parseThemeCheckReport(output: string, root: string): ThemeCheckIssue[] | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  let report: unknown;
  try {
    report = JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first < 0 || last <= first) return undefined;
    try { report = JSON.parse(trimmed.slice(first, last + 1)); } catch { return undefined; }
  }
  const issues: ThemeCheckIssue[] = [];
  return collectIssues(report, root, issues) ? issues : undefined;
}

export function summarizeThemeCheckIssues(issues: ThemeCheckIssue[]): ThemeCheckSummary {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const info = issues.filter((issue) => issue.severity === 'info').length;
  return { errors, warnings, info, total: issues.length };
}

function ukrainianCount(count: number, forms: [string, string, string]): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const form = lastTwo >= 11 && lastTwo <= 14 ? forms[2] : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2];
  return `${count} ${form}`;
}

export function formatThemeCheckSummary(issues: ThemeCheckIssue[]): string {
  const summary = summarizeThemeCheckIssues(issues);
  if (!summary.total) return 'Theme Check: помилок і попереджень немає.';
  const parts = [
    ukrainianCount(summary.total, ['зауваження', 'зауваження', 'зауважень']),
    ukrainianCount(summary.errors, ['помилка', 'помилки', 'помилок']),
    ukrainianCount(summary.warnings, ['попередження', 'попередження', 'попереджень']),
  ];
  if (summary.info) parts.push(ukrainianCount(summary.info, ['інформаційне зауваження', 'інформаційні зауваження', 'інформаційних зауважень']));
  return `Theme Check: ${parts.join(' · ')}`;
}

export function formatThemeCheckIssue(issue: ThemeCheckIssue): string {
  return `${issue.file}:${issue.line}:${issue.column} · ${issue.check} · ${issue.severity}`;
}
