/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test runner for the Omni Swim Suite. Runs the self-contained scoring /
 * persistence / chart-data checks via tsx and reports a summary. Tests that
 * require local-only fixtures (not committed to the repo) are skipped when the
 * fixture is absent so `npm test` stays green on a clean checkout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Per-script ceiling. Override with OMNI_TEST_TIMEOUT_MS for a slow machine.
 * See the `timeout` note at the spawn site for why this exists.
 */
const SCRIPT_TIMEOUT_MS = Number(process.env.OMNI_TEST_TIMEOUT_MS ?? 300_000);
/** The e2e run is one spawn covering every spec, so it gets a larger ceiling. */
const E2E_TIMEOUT_MS = Number(process.env.OMNI_E2E_TIMEOUT_MS ?? 900_000);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');

// Each entry: [file, ...requiredFixtures]. If any listed fixture is missing,
// the test is skipped rather than failed. `data/meets.json` is the local working
// store and holds real roster data, so it is untracked (f9d63c4b) and absent on CI.
//
// List `data/meets.json` here ONLY for a script whose every check needs it
// (today: `test_relay_overrides.mjs`). A script that has checks needing nothing
// local does not list it. It reads the store through `scripts/lib/localMeets.mjs`,
// runs the local-free checks everywhere, and prints a `LOCAL-ONLY SKIPPED` line for
// each part that needs the file. This runner counts those lines and prints them
// beside the PASS and in the summary, so a skipped part cannot hide in a green run.
//
// A test may also skip itself by exiting 0 with a leading `SKIP` line (used for
// checks needing a live database).
//
// A test may also report a KNOWN FAILURE by printing a line beginning `XFAIL`
// and exiting 0. That is for a check whose subject is correct but whose input is
// not — the case it was built for was the Delta State men total in
// `test_nsisc_team_totals.mjs`, where the engine was right and the committed
// fixture was missing four result rows; that fixture has since been re-extracted
// and the check is a plain assertion again. No test declares an XFAIL today. The
// summary lists every one, so a known failure stays visible instead of being
// skipped into silence. A test may not use it to excuse its own defect: the
// failing case must be named in the test file with what would close it.
const TESTS = [
  ['test_sqlite_roundtrip.mjs'],
  ['test_pg_roundtrip.mjs'],
  ['test_persistence_parity.mjs'],
  ['test_workspace_scope.mjs'],
  ['test_data_dir_guard.mjs'],
  ['test_chart_data.mjs'],
  ['test_chart_shell.mjs'],
  ['test_chart_render.mjs'],
  ['test_theme_css.mjs'],
  ['test_chart_bundle.mjs'],
  ['test_roster_optimizer.mjs'],
  ['test_optimizer_never_loses.mjs'],
  ['test_arbitrage_never_loses.mjs'],
  ['test_tie_group_scoring.mjs'],
  ['test_recruit_placement_grid.mjs'],
  ['test_scorer_pool_cap.mjs'],
  ['test_fast_swap_context.mjs'],
  ['test_entry_limits.mjs'],
  ['test_entry_limits_time_trials.mjs'],
  ['test_athlete_history.mjs'],
  ['test_course_conversion.mjs'],
  ['test_conversion_keys.mjs'],
  ['test_meet_program_events.mjs'],
  ['test_cut_division_absent.mjs'],
  ['test_workspace_naming.mjs'],
  ['test_server_binding.mjs'],
  ['test_event_quality_ranking.mjs'],
  ['test_arbitrage_units.mjs'],
  ['test_history_import_roster.mjs'],
  ['test_multi_profile_import.mjs'],
  ['test_scoring_theory.mjs'],
  ['test_scoring_settings_effect.mjs'],
  ['test_settings_lock.mjs'],
  ['test_scoring_preset_routes.mjs'],
  ['test_workspace_scoring_debounce.mjs'],
  ['test_athlete_lineup_editor.mjs'],
  ['test_meet_source.mjs'],
  ['test_working_copy_changes.mjs'],
  ['test_roster_arbitrage.mjs'],
  ['test_cross_course_arbitrage.mjs'],
  ['test_cross_course_arbitrage_view.mjs'],
  ['test_drop_add_analysis.mjs'],
  ['test_relay_swaps.mjs'],
  ['test_roster_removal.mjs'],
  ['test_projection_roster_gates.mjs'],
  ['test_swim_editor.mjs'],
  ['test_scenario_diff.mjs'],
  ['test_athlete_aliases.mjs'],
  ['test_duplicate_athletes.mjs'],
  ['test_alias_scorer_roster.mjs'],
  ['test_scorer_gender_default.mjs'],
  ['test_entry_limits_aliases.mjs'],
  ['test_entry_limits_prelims_finals.mjs'],
  ['test_parse_plausibility.mjs'],
  ['test_athlete_autolink.mjs'],
  ['test_roster_identity_match.mjs'],
  ['test_event_identity_scoring.mjs'],
  ['test_lineup_audit.mjs'],
  ['test_vacate_relay_alias.mjs'],
  ['test_relay_splits.mjs'],
  ['test_relay_overrides.mjs', 'data/meets.json'],
  ['test_dq_scoring.mjs'],
  ['test_prelims_projection.mjs'],
  ['test_momentum_series.mjs'],
  ['test_psych_projection.mjs'],
  ['test_team_aliases.mjs'],
  ['test_team_matching_ambiguity.mjs'],
  ['test_team_abbreviation_parity.mjs'],
  ['test_pdf_abbreviation_table_required.mjs'],
  ['test_scoring_settings_required.mjs'],
  ['test_season_analytics_official_zero.mjs'],
  ['test_cutlines.mjs'],
  ['test_cutline_tags.mjs'],
  ['test_team_rankings_parser.mjs'],
  ['test_yearless_result_row.mjs'],
  ['test_yearless_relay_row.mjs'],
  ['test_abbreviated_school_column.mjs'],
  ['test_scored_event_boundary.mjs'],
  ['test_pdf_place_points_boundary.mjs'],
  ['test_nsisc_team_totals.mjs'],
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
const knownFailures = [];
/** `LOCAL-ONLY SKIPPED` lines from passing scripts: parts that need the untracked data/meets.json. */
const localOnlySkips = [];

for (const [file, ...fixtures] of TESTS) {
  const path = join(scriptsDir, file);
  if (!existsSync(path)) {
    console.log(`SKIP  ${file} (missing)`);
    skipped += 1;
    continue;
  }
  const fixture = fixtures.find(f => !existsSync(join(repoRoot, f)));
  if (fixture) {
    console.log(`SKIP  ${file} (needs ${fixture})`);
    skipped += 1;
    continue;
  }
  // spawnSync rather than execFileSync so BOTH streams are captured even on a
  // zero exit. That matters for the `console.assert` guard below: Node's
  // console.assert writes "Assertion failed" to stderr and then keeps going,
  // leaving the exit code at 0. Three test files used it, so they reported PASS
  // no matter what they found. Exit status alone is not enough evidence.
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, ['--import', 'tsx', path], {
    cwd: repoRoot,
    stdio: 'pipe',
    // No script may hang the suite. Without this, one that never exits stalls
    // `npm test` until the CI job's own ceiling kills it -- which on GitHub
    // Actions is SIX HOURS, per run, billed. test_scoring_preset_routes.mjs did
    // exactly that in September 2026: it starts a server through `npx tsx`, and
    // killing `npx` left the real server running as a grandchild holding the
    // stdio pipes open, so the script's event loop never drained. Fifteen runs
    // burned six hours each before anyone looked.
    //
    // A timeout here turns that into one loud failure instead of a silent,
    // expensive stall. It is deliberately generous: the slowest legitimate
    // script in this suite finishes well inside a minute.
    timeout: SCRIPT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = run.stdout?.toString() ?? '';
  const stderr = run.stderr?.toString() ?? '';
  const combined = stdout + stderr;
  // A test that cannot fail is not a test. If a file ever reintroduces
  // console.assert, treat a tripped assertion as a failure regardless of status.
  const silentAssertion = /^Assertion failed/m.test(combined);

  if (run.status === 0 && !silentAssertion) {
    if (stdout.trimStart().startsWith('SKIP')) {
      console.log(stdout.trim().split('\n')[0]);
      skipped += 1;
    } else {
      const xfails = stdout.split('\n').filter(l => l.trimStart().startsWith('XFAIL'));
      const localSkips = stdout.split('\n').filter(l => l.startsWith('LOCAL-ONLY SKIPPED'));
      for (const line of localSkips) localOnlySkips.push(line.replace('LOCAL-ONLY SKIPPED', '').trim());
      const notes = [];
      if (xfails.length) notes.push(`${xfails.length} known failure${xfails.length > 1 ? 's' : ''}`);
      if (localSkips.length) notes.push(`${localSkips.length} local-only part${localSkips.length > 1 ? 's' : ''} skipped`);
      console.log(`PASS  ${file}${notes.length ? ` (${notes.join(', ')})` : ''}`);
      for (const line of xfails) knownFailures.push(`${file}: ${line.trim()}`);
      passed += 1;
    }
  } else {
    // Detected by elapsed time, not by the exit shape. How a timed-out
    // spawnSync reports itself is platform-dependent and not worth trusting:
    // POSIX gives status null with signal SIGKILL, while Windows was observed
    // giving status 13, no signal and no error at all. Wall time is the same
    // everywhere. Saying "timed out" matters because a bare "FAIL" over the
    // tail of a stalled script reads like an assertion failure and sends the
    // next person hunting in the wrong place.
    // The small tolerance absorbs timer granularity: the kill lands a few
    // milliseconds either side of the ceiling, and at a short ceiling that was
    // enough to leave a genuinely-stalled script labelled as a plain failure.
    const timedOut = run.error?.code === 'ETIMEDOUT' || elapsedMs >= SCRIPT_TIMEOUT_MS - 250;
    console.log(`FAIL  ${file}${timedOut ? ` (timed out after ${SCRIPT_TIMEOUT_MS} ms)` : ''}`);
    const why = timedOut
      ? `Timed out after ${SCRIPT_TIMEOUT_MS} ms and was killed. The script did not exit on its own.\n` +
        'A common cause here is spawning a server through `npx`: killing npx leaves the real\n' +
        'server running as a grandchild, holding the stdio pipes open so the event loop never drains.\n'
      : silentAssertion && run.status === 0
        ? 'console.assert tripped but exited 0 — use node:assert/strict so the failure is real\n'
        : '';
    failures.push(`--- ${file} ---\n${why}${combined.trim().split('\n').slice(-8).join('\n')}`);
    failed += 1;
  }
}

/** Ask the OS for a free TCP port. Playwright's dev server must not land on a port a user server holds. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Reduce Playwright output to what explains a failure. The dev server echoes the same
 * `[WebServer] ...` line (for example the `[scoring-presets] ignoring ...` notice) on every
 * request, and a tail of the raw output was nothing but those. Keep the first copy of each
 * WebServer line, say how many repeats were dropped, then start at the failure summary.
 */
function condensePlaywrightOutput(raw, maxLines = 60) {
  const seen = new Map();
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!/^\[WebServer\]/.test(line)) {
      kept.push(line);
      continue;
    }
    const count = seen.get(line) ?? 0;
    seen.set(line, count + 1);
    if (count === 0) kept.push(line);
  }
  const repeats = [...seen.values()].reduce((sum, n) => sum + (n - 1), 0);
  // The list reporter prints a numbered failure block ("  1) [chromium] > spec") after the run.
  const firstFailure = kept.findIndex(l => /^\s+1\) /.test(l));
  const body = firstFailure >= 0 ? kept.slice(firstFailure) : kept;
  const lines = body.join('\n').trim().split('\n');
  const shown = firstFailure >= 0 ? lines.slice(0, maxLines) : lines.slice(-maxLines);
  const note = repeats > 0 ? `(${repeats} repeated [WebServer] lines omitted)\n` : '';
  return note + shown.join('\n');
}

const playwrightBin = join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
if (existsSync(playwrightBin)) {
  // A free port, unless the caller chose one. playwright.config.ts and the dev server both read PORT.
  // `npm run dev` runs `predev`, which kills whatever listens on that port, so a fixed 3000 could
  // stop a user's own server on a developer machine.
  const e2ePort = process.env.PORT ?? String(await freePort());
  const e2e = spawnSync(process.execPath, [playwrightBin, 'test', `--reporter=${process.env.CI ? 'list,github' : 'list'}`], {
    cwd: repoRoot,
    stdio: 'pipe',
    env: { ...process.env, PORT: e2ePort, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--use-system-ca' },
    // Same ceiling, same reason as the per-script timeout above. Playwright's
    // own webServer will wait indefinitely for a port that never opens.
    timeout: E2E_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (e2e.status === 0) {
    console.log('PASS  playwright e2e (all specs)');
    passed += 1;
  } else {
    console.log('FAIL  playwright e2e (all specs)');
    const out = (e2e.stdout?.toString() || '') + '\n' + (e2e.stderr?.toString() || '');
    failures.push(`--- playwright e2e (PORT ${e2ePort}) ---\n${condensePlaywrightOutput(out)}`);
    failed += 1;
  }
} else if (process.env.CI) {
  // On CI a missing Playwright means the e2e specs would never run and the job would still pass.
  console.log('FAIL  playwright e2e (@playwright/test not installed, and CI=true forbids skipping it)');
  failures.push('--- playwright e2e ---\n@playwright/test is not in node_modules. Run `npm ci` before `npm test`, and `npx playwright install --with-deps chromium` for the browser.');
  failed += 1;
} else {
  console.log('SKIP  playwright e2e (@playwright/test not installed)');
  skipped += 1;
}

const knownSuffix = knownFailures.length ? `, ${knownFailures.length} known failure${knownFailures.length > 1 ? 's' : ''}` : '';
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped${knownSuffix}`);
if (localOnlySkips.length) {
  // A passing script can still have skipped the part that reads data/meets.json.
  console.log(`\nLOCAL-ONLY PARTS SKIPPED (${localOnlySkips.length}, need the untracked data/meets.json):`);
  for (const k of localOnlySkips) console.log(`  ${k}`);
}
if (knownFailures.length) {
  // Printed every run so a documented gap cannot fade into a green suite.
  console.log('\nKNOWN FAILURES (expected, documented in the test file):');
  for (const k of knownFailures) console.log(`  ${k}`);
}
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
