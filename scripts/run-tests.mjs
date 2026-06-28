/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test runner for the Omni Swim Suite. Runs the self-contained scoring /
 * persistence / chart-data checks via tsx and reports a summary. Tests that
 * require local-only fixtures (not committed to the repo) are skipped when the
 * fixture is absent so `npm test` stays green on a clean checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');

// Each entry: [file, requiredFixture?]. If the fixture is listed and missing,
// the test is skipped rather than failed.
const TESTS = [
  ['test_sqlite_roundtrip.mjs'],
  ['test_chart_data.mjs'],
  ['test_chart_shell.mjs'],
  ['test_theme_css.mjs'],
  ['test_roster_optimizer.mjs'],
  ['test_entry_limits.mjs'],
  ['test_athlete_history.mjs'],
  ['test_relay_splits.mjs'],
  ['test_relay_overrides.mjs'],
  ['test_dq_scoring.mjs'],
  ['test_team_colors.mjs'],
  ['test_individual_scoring.mjs', 'tests/test_nsisc_output.json'],
  ['test_relay_scoring.mjs', 'tests/test_nsisc_output.json'],
];

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

for (const [file, fixture] of TESTS) {
  const path = join(scriptsDir, file);
  if (!existsSync(path)) {
    console.log(`SKIP  ${file} (missing)`);
    skipped += 1;
    continue;
  }
  if (fixture && !existsSync(join(repoRoot, fixture))) {
    console.log(`SKIP  ${file} (needs ${fixture})`);
    skipped += 1;
    continue;
  }
  try {
    execFileSync(process.execPath, ['--import', 'tsx', path], { cwd: repoRoot, stdio: 'pipe' });
    console.log(`PASS  ${file}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  ${file}`);
    const out = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
    failures.push(`--- ${file} ---\n${out.trim().split('\n').slice(-8).join('\n')}`);
    failed += 1;
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
