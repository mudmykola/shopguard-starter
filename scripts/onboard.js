import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function runOnboarding(store, { cwd = process.cwd(), execute = spawnSync, platform = process.platform, log = console.log } = {}) {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const shopify = platform === 'win32' ? 'shopify.cmd' : 'shopify';
  const cli = join(cwd, 'dist', 'cli.js');
  const steps = [
    ['Встановлення, перевірки та підключення ShopGuard', npm, ['run', 'bootstrap']],
    ['Вхід у Shopify', shopify, ['auth', 'login']],
    ['Налаштування магазину', process.execPath, [cli, 'configure', '--store', store, '--path', cwd]],
    ['Ініціалізація теми', process.execPath, [cli, 'init', '--path', cwd]],
  ];

  for (const [title, command, args] of steps) {
    log(`\n${title}...`);
    const result = execute(command, args, { cwd, stdio: 'inherit', shell: platform === 'win32' });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runOnboarding(parseStoreArgument(process.argv.slice(2)));
  } catch (error) {
    console.error(`Помилка ShopGuard: ${error instanceof Error ? error.message : 'не вдалося запустити початкове налаштування'}`);
    process.exitCode = 1;
  }
}
