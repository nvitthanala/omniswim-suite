/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test runner for the Omni Swim Suite. Runs the self-contained scoring /
 * persistence / chart-data checks via tsx and reports a summary. Tests that
 * require local-only fixtures (not committed to the repo) are skipped when the
 * fixture is absent so `npm test` stays green on a clean checkout.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');

// Each entry: [file, requiredFixture?]. If the fixture is listed and missing,
// the test is skipped rather than failed. A test may also skip itself by exiting
// 0 with a leading `SKIP` line (used for checks needing a live database).
const TESTS = [
  ['test_sqlite_roundtrip.mjs'],
  ['test_pg_roundtrip.mjs'],
  ['test_persistence_parity.mjs'],
  ['test_workspace_scope.mjs'],
  ['test_chart_data.mjs'],
  ['test_chart_shell.mjs'],
  ['test_chart_render.mjs'],
  ['test_theme_css.mjs'],
  ['test_chart_bundle.mjs'],
  ['test_roster_optimizer.mjs'],
  ['test_entry_limits.mjs'],
  ['test_athlete_history.mjs'],
  ['test_history_import_roster.mjs'],
  ['test_multi_profile_import.mjs'],
  ['test_scoring_theory.mjs'],
  ['test_workspace_scoring_debounce.mjs'],
  ['test_meet_source.mjs'],
  ['test_roster_arbitrage.mjs'],
  ['test_cross_course_arbitrage.mjs'],
  ['test_drop_add_analysis.mjs'],
  ['test_relay_swaps.mjs'],
  ['test_roster_removal.mjs'],
  ['test_swim_editor.mjs'],
  ['test_scenario_diff.mjs'],
  ['test_athlete_aliases.mjs'],
  ['test_athlete_autolink.mjs'],
  ['test_event_identity_scoring.mjs'],
  ['test_lineup_audit.mjs'],
  ['test_relay_splits.mjs'],
  ['test_relay_overrides.mjs'],
  ['test_dq_scoring.mjs'],
  ['test_prelims_projection.mjs'],
  ['test_momentum_series.mjs'],
  ['test_psych_projection.mjs'],
  ['test_team_aliases.mjs'],
  ['test_cutlines.mjs'],
  ['test_cutline_tags.mjs'],
  ['test_nsisc_psych.mjs', 'tests/fixtures/nsisc_psych_sheet.pdf'],
  ['test_compact_event_label.mjs'],
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
    const out = execFileSync(process.execPath, ['--import', 'tsx', path], {
      cwd: repoRoot,
      stdio: 'pipe',
    }).toString();
    if (out.trimStart().startsWith('SKIP')) {
      console.log(out.trim().split('\n')[0]);
      skipped += 1;
    } else {
      console.log(`PASS  ${file}`);
      passed += 1;
    }
  } catch (err) {
    console.log(`FAIL  ${file}`);
    const out = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
    failures.push(`--- ${file} ---\n${out.trim().split('\n').slice(-8).join('\n')}`);
    failed += 1;
  }
}

const playwrightBin = join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
if (existsSync(playwrightBin)) {
  const e2e = spawnSync(process.execPath, [playwrightBin, 'test'], {
    cwd: repoRoot,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--use-system-ca' },
  });
  if (e2e.status === 0) {
    console.log('PASS  playwright matrix-chart e2e');
    passed += 1;
  } else {
    console.log('FAIL  playwright matrix-chart e2e');
    const out = (e2e.stdout?.toString() || '') + (e2e.stderr?.toString() || '');
    failures.push(`--- playwright e2e ---\n${out.trim().split('\n').slice(-40).join('\n')}`);
    failed += 1;
  }
} else {
  console.log('SKIP  playwright e2e (@playwright/test not installed)');
  skipped += 1;
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
