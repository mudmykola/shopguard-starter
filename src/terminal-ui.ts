import { spawn } from 'node:child_process';
import { stdin, stdout, stderr } from 'node:process';
import { select } from '@inquirer/prompts';
import ora from 'ora';
import pc from 'picocolors';
import { redactOutput, safeEnvironment, type CommandResult, type ShopifyTheme } from './core.js';

export const numberedSelectionTheme = { indexMode: 'number' as const };

export function printWelcome(store?: string): void {
  console.log(`\n${pc.bold(pc.cyan('🛡️  ShopGuard'))} ${pc.dim('Shopify theme setup')}`);
  if (store) console.log(`${pc.dim('Магазин')} ${pc.bold(store)}`);
  console.log(pc.dim('────────────────────────────────────────'));
}

export function printStep(index: number, total: number, message: string): void {
  console.log(`\n${pc.cyan(`◆ ${index}/${total}`)} ${pc.bold(message)}`);
}

export function printInfo(message: string): void { console.log(`${pc.blue('ℹ')} ${message}`); }
export function printSuccess(message: string): void { console.log(`${pc.green('✔')} ${message}`); }
export function printWarning(message: string): void { console.warn(`${pc.yellow('⚠')} ${message}`); }
export function printError(message: string): void { console.error(`${pc.red('✖')} ${message}`); }

export function confirmationDetails(action: string): string {
  const [verb, ...parts] = action.split(' ');
  switch (verb) {
    case 'RENAME': return 'Локально: origin → starter · віддалені зміни: немає';
    case 'LIST': return `Магазин: ${parts.join(' ')} · лише перегляд`; 
    case 'PULL': return `Тема ID: ${parts.join(' ')} · файли завантажаться тільки локально`;
    case 'IMPORT': return `Магазин: ${parts.join(' ')} · копіюються лише нові файли`;
    case 'SKELETON': return `Магазин: ${parts.join(' ')} · шаблон завантажиться локально`;
    case 'INIT': return `Магазин: ${parts.slice(1).join(' ')} · локальні гілки, без remote і push`;
    case 'STAGE': return `Магазин: ${parts.join(' ')} · вибрані файли потраплять у Git index`;
    case 'COMMIT': return `Магазин: ${parts.join(' ')} · створити локальний baseline commit`;
    case 'BASELINE': return `Магазин: ${parts[0]} · тема ID: ${parts[1]} · лише локальна копія для порівняння`;
    case 'PUSH': return `⚠ Shopify upload · магазин: ${parts[0]} · тема ID: ${parts[1]} · файлів: ${parts[2]}`;
    case 'DEV': return `⚠ Shopify preview · магазин: ${parts.join(' ')} · завантаження у development theme`;
    case 'FETCH': return `Git remote: ${parts.join(' ')} · отримати refs без push`;
    case 'SYNC': return `Git remote: ${parts[0]} · гілка: ${parts[1]} · лише fast-forward`;
    case 'INSTALL': return `Встановити ${parts[0]} пакунків у клієнтський проєкт`;
    default: return pc.dim('Операцію можна скасувати клавішею Esc.');
  }
}

export async function confirmAction(message: string, action: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  console.log(`\n${pc.bold(message)}\n${pc.dim(`Деталі: ${confirmationDetails(action)}`)}`);
  try {
    return await select({
      message: 'Вибери дію · цифра + Enter або стрілки + Enter',
      choices: [
        { name: '↩ Скасувати', value: false },
        { name: '✓ Продовжити', value: true },
      ],
      theme: numberedSelectionTheme,
      loop: false,
    });
  } catch {
    return false;
  }
}

export async function chooseTheme(themes: ShopifyTheme[]): Promise<string | undefined> {
  if (!stdin.isTTY || !stdout.isTTY) return undefined;
  try {
    return await select({
      message: 'Тема-джерело · цифра + Enter або стрілки + Enter',
      choices: themes.map((theme) => ({
        name: `${theme.role === 'main' ? '🟢 Live' : '🟡 Unpublished'} · ${theme.name} · ID ${theme.id}`,
        value: theme.id,
        description: theme.role === 'main' ? 'Поточна опублікована тема; завантаження буде локальним' : 'Неопублікована тема; завантаження буде локальним',
      })),
      theme: numberedSelectionTheme,
      loop: false,
    });
  } catch {
    return undefined;
  }
}

export function outputMessage(message: string): void {
  if (message.startsWith('Read-only Shopify request:')) {
    printStep(1, 5, 'Перевірка магазину · лише читання');
    console.log(pc.dim(message));
  } else if (message.startsWith('Local-only download:')) {
    printStep(2, 5, 'Завантаження теми на комп’ютер');
    console.log(pc.dim(message));
  } else if (message.startsWith('Import preview')) {
    printStep(3, 5, 'Перевірка файлів перед імпортом');
    console.log(pc.dim(message));
  } else if (message.startsWith('Git review list')) {
    printStep(4, 5, 'Перевірка baseline перед Git');
    console.log(pc.dim(message));
  } else if (message.startsWith('Staged diff')) {
    printStep(5, 5, 'Фінальна перевірка commit');
    console.log(message);
  } else if (message.startsWith('Baseline committed')) {
    printSuccess(message);
  } else if (/not confirmed|not changed|declined/i.test(message)) {
    printWarning(message);
  } else if (/Imported|Remote перейменовано|created|saved locally/i.test(message)) {
    printSuccess(message);
  } else {
    printInfo(message);
  }
}

export function runWithSpinner(command: string, args: string[], cwd: string, label: string, spinnerFactory = ora): Promise<CommandResult> {
  return new Promise((resolve) => {
    const spinner = spinnerFactory({ text: label, color: 'cyan', spinner: 'dots' }).start();
    const child = spawn(command, args, { cwd, env: safeEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (ok: boolean, detail = '') => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', interrupt);
      const clean = redactOutput(output + detail);
      if (ok) spinner.succeed(`${label} · готово`);
      else spinner.fail(`${label} · помилка`);
      resolve({ ok, output: clean, command: [command, ...args].join(' ') });
    };
    const interrupt = () => { if (child.exitCode === null) child.kill('SIGINT'); };
    process.on('SIGINT', interrupt);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', (error) => finish(false, error.message));
    child.once('exit', (code) => finish(code === 0, code === 0 ? '' : `\nProcess exited with code ${code ?? 1}.`));
  });
}
