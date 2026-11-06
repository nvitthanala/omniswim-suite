import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsconfigPathAliases } from '../scripts/lib/tsconfigAliases.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root,
  test: {
    globals: true,
    environment: 'node',
    include: ['legacy/tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/happyDomDialogs.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: tsconfigPathAliases(path.join(root, 'tsconfig.base.json')),
  },
});
