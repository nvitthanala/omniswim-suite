#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Skip budget for the vitest suite.
 *
 * Several tests skip themselves when a local-only fixture (gitignored capture data, data/meets.json)
 * or a tool (pdftotext, a Postgres URL) is absent. A skip is not a failure, so a suite can lose
 * coverage and stay green. This script runs `vitest run`, counts skipped tests per file, and fails
 * when a file skips more than tests/skip-budget.json allows.
 *
 * Usage:
 *   node scripts/check_skip_budget.mjs                 run vitest, then check
 *   node scripts/check_skip_budget.mjs --from report.json   check an existing vitest JSON report
 *   SKIP_BUDGET_ENV=ci|local                            choose the column (default: ci when CI is set)
 *
 * It does not change which tests skip. It exits 1 when vitest fails or the budget is exceeded.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const budget = JSON.parse(readFileSync(join(repoRoot, 'tests', 'skip-budget.json'), 'utf8'));
const env = process.env.SKIP_BUDGET_ENV ?? (process.env.CI ? 'ci' : 'local');
if (env !== 'ci' && env !== 'local') {
  console.error(`SKIP_BUDGET_ENV must be "ci" or "local", got "${env}".`);
  process.exit(2);
}

const fromIndex = process.argv.indexOf('--from');
let reportPath = fromIndex >= 0 ? process.argv[fromIndex + 1] : undefined;
let tempDir;
let vitestStatus = 0;

if (!reportPath) {
  tempDir = mkdtempSync(join(tmpdir(), 'skip-budget-'));
  reportPath = join(tempDir, 'vitest.json');
  const bin = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [bin, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  vitestStatus = run.status ?? 1;
}

if (!existsSync(reportPath)) {
  console.error(`No vitest JSON report at ${reportPath}. Vitest probably crashed before it wrote one.`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (tempDir) rmSync(tempDir, { recursive: true, force: true });

const skippedByFile = new Map();
for (const file of report.testResults ?? []) {
  const rel = relative(repoRoot, file.name).split(sep).join('/');
  for (const t of file.assertionResults ?? []) {
    if (t.status === 'skipped' || t.status === 'pending') skippedByFile.set(rel, (skippedByFile.get(rel) ?? 0) + 1);
  }
}

const allowedFor = file => budget.files[file]?.[env] ?? 0;
const totalSkipped = [...skippedByFile.values()].reduce((a, b) => a + b, 0);
const totalAllowed = Object.keys(budget.files).reduce((sum, f) => sum + allowedFor(f), 0);

const over = [];
const under = [];
for (const [file, count] of skippedByFile) {
  if (count > allowedFor(file)) over.push(`${file}: ${count} skipped, budget ${allowedFor(file)}${budget.files[file] ? '' : ' (file not in tests/skip-budget.json)'}`);
}
for (const file of Object.keys(budget.files)) {
  const count = skippedByFile.get(file) ?? 0;
  if (count < allowedFor(file)) under.push(`${file}: ${count} skipped, budget ${allowedFor(file)}`);
}

console.log(`\n[skip-budget] env=${env}: ${totalSkipped} skipped, budget ${totalAllowed}`);
for (const [file, count] of [...skippedByFile].sort()) console.log(`  ${String(count).padStart(3)}  ${file}`);
if (under.length) {
  console.log('[skip-budget] Under budget. Lower these numbers in tests/skip-budget.json:');
  for (const line of under) console.log(`  ${line}`);
}

let failed = false;
if (vitestStatus !== 0) {
  console.error(`[skip-budget] FAIL: vitest exited ${vitestStatus}.`);
  failed = true;
}
if (over.length) {
  console.error('[skip-budget] FAIL: skips above budget. A fixture or tool that tests need is missing:');
  for (const line of over) console.error(`  ${line}`);
  console.error('Restore the missing fixture or tool. Raise the budget only with a reason in tests/skip-budget.json.');
  failed = true;
}
process.exit(failed ? 1 : 0);
