import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  chmodSync(cliPath, 0o755);
}
