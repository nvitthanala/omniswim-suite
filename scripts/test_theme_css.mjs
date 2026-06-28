/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the shell and verifies the production CSS still contains utilities
 * and tokens that Tailwind can drop if workspace @source coverage regresses.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');

console.log('building production CSS for regression checks...');
if (process.platform === 'win32') {
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm run build'], { cwd: repoRoot, stdio: 'pipe' });
} else {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
}

const assetsDir = join(repoRoot, 'dist', 'assets');
if (!existsSync(assetsDir)) {
  throw new Error('dist/assets was not created by the production build');
}

const cssFiles = readdirSync(assetsDir).filter(file => file.endsWith('.css'));
if (cssFiles.length === 0) {
  throw new Error('production build did not emit a CSS asset');
}

const css = cssFiles
  .map(file => readFileSync(join(assetsDir, file), 'utf8'))
  .join('\n');

const requiredChecks = [
  ['chart utility .h-64', /\.h-64\{/],
  ['chart utility .h-72', /\.h-72\{/],
  ['chart shell .chart-shell--md', /\.chart-shell--md\{/],
  ['chart shell .chart-shell--lg', /\.chart-shell--lg\{/],
  ['chart shell .chart-shell--fluid', /\.chart-shell--fluid\{/],
  ['chart shell viewport', /\.chart-shell__viewport\{/],
  ['chart shell viewport absolute', /\.chart-shell__viewport\{[^}]*position:\s*absolute/],
  ['chart shell viewport fill', /\.chart-shell__viewport\{[^}]*(?:inset:\s*0|top:\s*0[^}]*left:\s*0)/],
  ['chart shell display block', /\.chart-shell\{[^}]*display:\s*block/],
  ['chart shell viewport size', /\.chart-shell__viewport\{[^}]*width:\s*100%/],
  ['chart shell chart frame', /\.chart-shell__chart\{/],
  ['matrix data grid', /\.matrix-data-grid\{/],
  ['text utility .text-ui-micro', /\.text-ui-micro\{/],
  ['text scale token', /--text-scale:/],
  ['text micro token', /--text-ui-micro:/],
  ['theme preset blocks', /\[data-theme-preset=(?:"|')?midnight(?:"|')?\]/],
  ['custom theme preset', /\[data-theme-preset=(?:"|')?custom(?:"|')?\]/],
  ['large text scale block', /\[data-text-scale=(?:"|')?large(?:"|')?\]/],
  ['custom accent token', /--custom-accent:/],
];

const missing = requiredChecks.filter(([, pattern]) => !pattern.test(css)).map(([label]) => label);

if (missing.length > 0) {
  throw new Error(`production CSS is missing required selectors/tokens: ${missing.join(', ')}`);
}

console.log(`theme CSS regression checks passed (${cssFiles.join(', ')})`);
