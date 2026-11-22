import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function restartHelperArguments(): string[] {
  const emitted = fileURLToPath(new URL('./restart-transaction.js', import.meta.url));
  if (existsSync(emitted)) return [emitted];
  return [
    '--import',
    fileURLToPath(new URL('../../../scripts/register-server-sources.mjs', import.meta.url)),
    fileURLToPath(new URL('./restart-transaction.ts', import.meta.url)),
  ];
}
