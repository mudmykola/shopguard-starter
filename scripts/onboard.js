import { spawn } from 'node:child_process';
import { resolve, join, basename, dirname, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// This entrypoint runs before `npm ci`, so it must not import project dependencies.
const supportsColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const style = (code, value) => supportsColor ? `\u001B[${code}m${value}\u001B[0m` : value;
const pc = {
  bold: (value) => style('1', value),
  cyan: (value) => style('36', value),
  dim: (value) => style('2', value),
  green: (value) => style('32', value),
  red: (value) => style('31', value),
  yellow: (value) => style('33', value),
};

function ora({ text }) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let interval;
  const interactive = Boolean(process.stdout.isTTY);
  const stop = (icon, message, color) => {
    if (interval) clearInterval(interval);
    if (interactive) process.stdout.write(`\r\u001B[2K${color(icon)} ${message}\n`);
  };
  return {
    start() {
      if (interactive) {
        process.stdout.write(`${pc.cyan(frames[frame])} ${text}`);
        interval = setInterval(() => {
          frame = (frame + 1) % frames.length;
          process.stdout.write(`\r\u001B[2K${pc.cyan(frames[frame])} ${text}`);
        }, 80);
        interval.unref?.();
      } else {
        console.log(`… ${text}`);
      }
      return this;
    },
    succeed(message) { stop('✔', message, pc.green); return this; },
    fail(message) { stop('✖', message, pc.red); return this; },
  };
}

export function parseStoreArgument(args) {
  const index = args.indexOf('--store');
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('Вкажи магазин: npm start -- --store назва-магазину.myshopify.com');
  }
  const store = args[index + 1];
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(store)) {
    throw new Error('Вкажи домен магазину у форматі назва-магазину.myshopify.com без https://.');
  }
  return store;
}

export function parseRepositoryUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) {
    throw new Error('Вкажи HTTPS URL порожнього GitHub-репозиторію, наприклад https://github.com/OWNER/STORE-THEME.git.');
  }
  if (/(?:shopguard-starter|shopify-theme-starter)(?:\.git)?$/i.test(value)) {
    throw new Error('Репозиторій стартера не може бути репозиторієм теми магазину.');
  }
  return value.endsWith('.git') ? value : `${value}.git`;
}

export function parseOnboardingArguments(args) {
  const store = parseStoreArgument(args);
  let repositoryUrl;
  let projectDir;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--store') { index += 1; continue; }
    if (args[index] === '--repo') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Після --repo вкажи HTTPS URL порожнього GitHub-репозиторію теми.');
      repositoryUrl = parseRepositoryUrl(args[index + 1]);
      index += 1;
      continue;
    }
    if (args[index] === '--project-dir') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Після --project-dir вкажи шлях для локальної папки теми.');
      projectDir = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Невідомий параметр: ${args[index]}. Підтримуються --store, --repo та --project-dir.`);
  }
  return { store, repositoryUrl, projectDir };
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
  repositoryUrl: requestedRepository,
  projectDir,
} = {}) {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const shopify = platform === 'win32' ? 'shopify.cmd' : 'shopify';
  const cli = join(cwd, 'dist', 'cli.js');
  log(`\n${pc.bold(pc.cyan('🛡️  ShopGuard'))} ${pc.dim('Початкове налаштування теми')}`);
  log(`${pc.dim('Магазин')} ${pc.bold(store)}`);

  log(`\n${pc.cyan('◆ 1/5')} ${pc.bold('Встановлення, перевірки та підключення ShopGuard')}`);
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

  const repositoryUrl = requestedRepository ? parseRepositoryUrl(requestedRepository) : undefined;
  const projectName = repositoryUrl
    ? basename(new URL(repositoryUrl).pathname).replace(/\.git$/i, '')
    : `${store.split('.')[0]}-theme`;
  const target = projectDir ? resolve(cwd, projectDir) : resolve(dirname(cwd), projectName);
  const starterRoot = resolve(cwd);
  if (target === starterRoot || target.startsWith(`${starterRoot}${sep}`)) {
    throw new Error('Папка теми має бути окремою від ShopGuard Starter. Вкажи інший --project-dir.');
  }
  if (existsSync(target)) throw new Error(`Папка вже існує: ${target}. Вкажи інший --project-dir або перейменуй/перемісти її вручну.`);

  log(`\n${pc.cyan('◆ 2/5')} ${pc.bold(repositoryUrl ? 'Клонування окремого репозиторію теми' : 'Створення локального проєкту теми')}`);
  if (repositoryUrl) {
    log(`${pc.dim('Репозиторій')} ${repositoryUrl}\n${pc.dim('Папка')} ${target}`);
    const cloned = await execute('git', ['clone', repositoryUrl, target], { cwd, stdio: 'inherit', shell: platform === 'win32' });
    if (cloned.error || cloned.status !== 0) {
      if (cloned.output) log(cloned.output.trim());
      return cloned.status ?? 1;
    }
    const existingCommit = await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: target, stdio: 'pipe', shell: platform === 'win32' });
    if (existingCommit.status === 0) throw new Error(`Репозиторій теми не порожній. Клон залишився для перевірки: ${target}. ShopGuard нічого не видаляв. Створи порожнє GitHub-репо без README, License і .gitignore та вкажи іншу --project-dir або перемісти цей клон вручну.`);
    log(`${pc.green('✔')} Порожній клієнтський репозиторій клоновано. ShopGuard Starter залишився окремо.`);
  } else {
    mkdirSync(target);
    log(`${pc.dim('Локальна папка')} ${target}\n${pc.yellow('GitHub поки не під’єднано; після init можна створити репо й додати origin.')}`);
  }

  const steps = [
    ['Вхід у Shopify', shopify, ['auth', 'login'], true],
    ['Збереження магазину', process.execPath, [cli, 'configure', '--store', store, '--path', target], true],
    ['Ініціалізація теми в окремому репозиторії', process.execPath, [cli, 'init', '--path', target], true],
  ];

  for (let index = 0; index < steps.length; index += 1) {
    const [title, command, args, interactive] = steps[index];
    log(`\n${pc.cyan(`◆ ${index + 3}/5`)} ${pc.bold(title)}`);
    const result = await execute(command, args, { cwd, stdio: interactive ? 'inherit' : 'pipe', shell: platform === 'win32' });
    if (result.error || result.status !== 0) {
      log(`${pc.red('✖')} ${title} зупинено. Наступні кроки не виконувалися.`);
      if (result.output) log(result.output.trim());
      return result.status ?? 1;
    }
    if (index < steps.length - 1) log(`${pc.green('✔')} ${title} завершено.`);
  }
  log(`\n${pc.green('✔')} Готово. Робоча тема: ${target}\nПерейди в цю папку для розробки; ShopGuard Starter лишається окремим.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOnboardingArguments(process.argv.slice(2));
    process.exitCode = await runOnboarding(options.store, options);
  } catch (error) {
    console.error(`${pc.red('✖')} Помилка ShopGuard: ${error instanceof Error ? error.message : 'не вдалося запустити початкове налаштування'}`);
    process.exitCode = 1;
  }
}
