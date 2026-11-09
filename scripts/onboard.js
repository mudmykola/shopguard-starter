import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ora from 'ora';
import pc from 'picocolors';

export function parseStoreArgument(args) {
  const index = args.indexOf('--store');
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('Вкажи магазин: npm start -- --store назва-магазину.myshopify.com');
  }
  const store = args[index + 1];
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(store)) {
    throw new Error('Вкажи домен магазину у форматі назва-магазину.myshopify.com без https://.');
  }
  if (args.length !== 2) throw new Error('Підтримується лише параметр --store <назва-магазину.myshopify.com>.');
  return store;
}

function executeProcess(command, args, options) {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell,
      stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => resolveProcess({ status: 1, output: `${output}\n${error.message}`, error }));
    child.once('exit', (code) => resolveProcess({ status: code ?? 1, output }));
  });
}

export async function runOnboarding(store, {
  cwd = process.cwd(),
  execute = executeProcess,
  platform = process.platform,
  spinnerFactory = ora,
  log = console.log,
  warn = console.warn,
} = {}) {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const shopify = platform === 'win32' ? 'shopify.cmd' : 'shopify';
  const cli = join(cwd, 'dist', 'cli.js');
  log(`\n${pc.bold(pc.cyan('🛡️  ShopGuard'))} ${pc.dim('Початкове налаштування теми')}`);
  log(`${pc.dim('Магазин')} ${pc.bold(store)}`);

  log(`\n${pc.cyan('◆ 1/4')} ${pc.bold('Встановлення, перевірки та підключення ShopGuard')}`);
  const spinner = spinnerFactory({ text: 'Готую середовище розробки', color: 'cyan', spinner: 'dots' }).start();
  const bootstrap = await execute(npm, ['run', 'bootstrap'], { cwd, stdio: 'pipe', shell: platform === 'win32' });
  if (bootstrap.error || bootstrap.status !== 0) {
    spinner.fail('Не вдалося підготувати середовище');
    if (bootstrap.output) log(bootstrap.output.trim());
    return bootstrap.status ?? 1;
  }
  const passed = bootstrap.output.match(/ℹ pass (\d+)/)?.[1];
  const skipped = bootstrap.output.match(/ℹ skipped (\d+)/)?.[1];
  spinner.succeed(`Середовище готове${passed ? ` · ${passed} тестів` : ''}${skipped && Number(skipped) ? ` · браузерні пропущені: ${skipped}` : ''}`);
  const vulnerabilities = bootstrap.output.match(/(\d+ (?:low|moderate|high|critical) severity vulnerabilities?)/i)?.[1];
  if (vulnerabilities) warn(`${pc.yellow('⚠')} npm audit: ${vulnerabilities}`);

  const steps = [
    ['Вхід у Shopify', shopify, ['auth', 'login'], true],
    ['Збереження магазину', process.execPath, [cli, 'configure', '--store', store, '--path', cwd], true],
    ['Ініціалізація теми', process.execPath, [cli, 'init', '--path', cwd], true],
  ];

  for (let index = 0; index < steps.length; index += 1) {
    const [title, command, args, interactive] = steps[index];
    log(`\n${pc.cyan(`◆ ${index + 2}/4`)} ${pc.bold(title)}`);
    const result = await execute(command, args, { cwd, stdio: interactive ? 'inherit' : 'pipe', shell: platform === 'win32' });
    if (result.error || result.status !== 0) {
      log(`${pc.red('✖')} ${title} зупинено. Наступні кроки не виконувалися.`);
      if (result.output) log(result.output.trim());
      return result.status ?? 1;
    }
    if (index < steps.length - 1) log(`${pc.green('✔')} ${title} завершено.`);
  }
  log(`\n${pc.green('✔')} Готово. Далі керуй темою командами ShopGuard.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runOnboarding(parseStoreArgument(process.argv.slice(2)));
  } catch (error) {
    console.error(`${pc.red('✖')} Помилка ShopGuard: ${error instanceof Error ? error.message : 'не вдалося запустити початкове налаштування'}`);
    process.exitCode = 1;
  }
}
