/**
 * Drop Vite dependency pre-bundles so dev always serves current chart/matrix code.
 * Run from npm predev alongside free-port.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [
  path.join(root, 'node_modules', '.vite'),
  path.join(root, 'apps', 'shell', 'node_modules', '.vite'),
];

let cleared = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    cleared += 1;
    console.log(`[omniswim] Cleared Vite cache: ${path.relative(root, dir)}`);
  } catch (err) {
    console.warn(`[omniswim] Could not clear ${dir}:`, err instanceof Error ? err.message : err);
  }
}

if (cleared === 0) {
  console.log('[omniswim] No Vite cache directories to clear.');
}
