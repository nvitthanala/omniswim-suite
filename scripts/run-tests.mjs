/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test runner for the Omni Swim Suite. Runs the self-contained scoring /
 * persistence / chart-data checks via tsx and reports a summary. Tests that
 * require local-only fixtures (not committed to the repo) are skipped when the
 * fixture is absent so `npm test` stays green on a clean checkout.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Per-script ceiling. Override with OMNI_TEST_TIMEOUT_MS for a slow machine.
 * See the `timeout` note at the spawn site for why this exists.
 */
const SCRIPT_TIMEOUT_MS = Number(process.env.OMNI_TEST_TIMEOUT_MS ?? 300_000);

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
const TESTS = [  ['test_alias_scorer_roster.mjs'],
  ['test_arbitrage_never_loses.mjs'],
  ['test_arbitrage_units.mjs'],
  ['test_athlete_aliases.mjs'],
  ['test_athlete_autolink.mjs'],
  ['test_athlete_history.mjs'],
  ['test_chart_bundle.mjs'],
  ['test_chart_data.mjs'],
  ['test_compact_event_label.mjs'],
  ['test_conversion_keys.mjs'],
  ['test_course_conversion.mjs'],
  ['test_cross_course_arbitrage.mjs'],
  ['test_cut_division_absent.mjs'],
  ['test_cutline_tags.mjs'],
  ['test_cutlines.mjs'],
  ['test_dq_scoring.mjs'],
  ['test_drop_add_analysis.mjs'],
  ['test_duplicate_athletes.mjs'],
  ['test_entry_limits.mjs'],
  ['test_entry_limits_aliases.mjs'],
  ['test_entry_limits_prelims_finals.mjs'],
  ['test_entry_limits_time_trials.mjs'],
  ['test_event_identity_scoring.mjs'],
  ['test_event_quality_ranking.mjs'],
  ['test_fast_swap_context.mjs'],
  ['test_history_import_roster.mjs'],
  ['test_individual_scoring.mjs', 'tests/test_nsisc_output.json'],
  ['test_lineup_audit.mjs'],
  ['test_meet_program_events.mjs'],
  ['test_meet_source.mjs'],
  ['test_momentum_series.mjs'],
  ['test_multi_profile_import.mjs'],
  ['test_nsisc_team_totals.mjs'],
  ['test_optimizer_never_loses.mjs'],
  ['test_parse_plausibility.mjs'],
  ['test_prelims_projection.mjs'],
  ['test_projection_roster_gates.mjs'],
  ['test_psych_projection.mjs'],
  ['test_recruit_placement_grid.mjs'],
  ['test_relay_overrides.mjs', 'data/meets.json'],
  ['test_relay_scoring.mjs', 'tests/test_nsisc_output.json'],
  ['test_relay_splits.mjs'],
  ['test_relay_swaps.mjs'],
  ['test_roster_arbitrage.mjs'],
  ['test_roster_identity_match.mjs'],
  ['test_roster_optimizer.mjs'],
  ['test_roster_removal.mjs'],
  ['test_scenario_diff.mjs'],
  ['test_scored_event_boundary.mjs'],
  ['test_scorer_gender_default.mjs'],
  ['test_scorer_pool_cap.mjs'],
  ['test_scoring_settings_effect.mjs'],
  ['test_scoring_theory.mjs'],
  ['test_season_analytics_official_zero.mjs'],
  ['test_settings_lock.mjs'],
  ['test_swim_editor.mjs'],
  ['test_team_aliases.mjs'],
  ['test_team_colors.mjs'],
  ['test_team_matching_ambiguity.mjs'],
  ['test_theme_css.mjs'],
  ['test_tie_group_scoring.mjs'],
  ['test_vacate_relay_alias.mjs'],
  ['test_working_copy_changes.mjs'],
  ['test_workspace_naming.mjs'],
  ['test_workspace_scoring_debounce.mjs'],
];

/**
 * Scripts named `test_*.mjs` that deliberately do not run in this suite, each with
 * the reason it cannot. A script that is in neither TESTS nor here fails the run
 * (the check below), so a new test cannot sit unregistered and read as coverage.
 *
 * Manual probes live in `scripts/probes/` instead and need no entry.
 */
const EXCLUDED = {
  // 'test_<name>.mjs': 'why it cannot run unattended',
};

{
  const onDisk = readdirSync(scriptsDir).filter(f => /^test_.+\.mjs$/.test(f));
  const listed = new Set(TESTS.map(([file]) => file));
  const unaccounted = onDisk.filter(f => !listed.has(f) && !(f in EXCLUDED));
  const bothWays = Object.keys(EXCLUDED).filter(f => listed.has(f));
  const stale = Object.keys(EXCLUDED).filter(f => !onDisk.includes(f));
  if (unaccounted.length || bothWays.length || stale.length) {
    console.log('FAIL  scripts/test_*.mjs registration');
    for (const f of unaccounted) console.log(`  ${f} is in neither TESTS nor EXCLUDED. List it in TESTS, give it a reason in EXCLUDED, or move it to scripts/probes/.`);
    for (const f of bothWays) console.log(`  ${f} is in both TESTS and EXCLUDED. Remove one.`);
    for (const f of stale) console.log(`  ${f} is in EXCLUDED but is not on disk. Remove the entry.`);
    process.exit(1);
  }
}

/**
 * Scripts that must not overlap with any other script. Each one touches state that
 * the pool would share: a fixed port, the real `data/` folder, or the one database.
 * They run one at a time, after the pool has drained.
 */
const EXCLUSIVE = {
  'test_scoring_preset_routes.mjs': 'starts the real server on fixed port 3209 and writes data/scoring_presets/',
  'test_pg_roundtrip.mjs': 'writes to the one shared PostgreSQL database (PG_TEST_URL)',
  'test_data_dir_guard.mjs': 'starts real server processes and probes ports',
};

/** How many scripts run at once. OMNI_TEST_JOBS=1 restores the old one-at-a-time run. */
const JOBS = Math.max(1, Math.floor(Number(process.env.OMNI_TEST_JOBS ?? 4)) || 4);

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const knownFailures = [];
/** `LOCAL-ONLY SKIPPED` lines from passing scripts: parts that need the untracked data/meets.json. */
const localOnlySkips = [];

/**
 * Run one script and collect BOTH streams, even on a zero exit. That matters for the
 * `console.assert` guard in `classify`: Node's console.assert writes "Assertion failed"
 * to stderr and then keeps going, leaving the exit code at 0. Three test files used it,
 * so they reported PASS no matter what they found. Exit status alone is not enough
 * evidence.
 *
 * No script may hang the suite. Without a ceiling, one that never exits stalls
 * `npm test` until the CI job's own ceiling kills it -- which on GitHub Actions is
 * SIX HOURS, per run, billed. test_scoring_preset_routes.mjs did exactly that in
 * September 2026: it starts a server through `npx tsx`, and killing `npx` left the
 * real server running as a grandchild holding the stdio pipes open, so the script's
 * event loop never drained. Fifteen runs burned six hours each before anyone looked.
 *
 * The timer lives here, not in spawn options, because the runner is async now. After
 * the kill it also stops waiting for the pipes: a grandchild that holds them open
 * would otherwise keep `close` from ever firing, and the runner would stall the same
 * way. The ceiling is deliberately generous: the slowest legitimate script in this
 * suite finishes well inside a minute.
 */
function runScript(path) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;
    const child = spawn(process.execPath, ['--import', 'tsx', path], {
      cwd: repoRoot,
      stdio: 'pipe',
      windowsHide: true,
    });
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, 2000).unref();
    }, SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', e => {
      err.push(Buffer.from(String(e)));
      finish(null);
    });
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

/** Turn one finished script into its printed line and its contribution to the summary. */
function classify(file, run) {
  const combined = run.stdout + run.stderr;
  // A test that cannot fail is not a test. If a file ever reintroduces
  // console.assert, treat a tripped assertion as a failure regardless of status.
  const silentAssertion = /^Assertion failed/m.test(combined);

  if (run.status === 0 && !run.timedOut && !silentAssertion) {
    if (run.stdout.trimStart().startsWith('SKIP')) {
      return { kind: 'skip', line: run.stdout.trim().split('\n')[0] };
    }
    const lines = run.stdout.split('\n');
    const xfails = lines.filter(l => l.trimStart().startsWith('XFAIL'));
    const localSkips = lines.filter(l => l.startsWith('LOCAL-ONLY SKIPPED'));
    const notes = [];
    if (xfails.length) notes.push(`${xfails.length} known failure${xfails.length > 1 ? 's' : ''}`);
    if (localSkips.length) notes.push(`${localSkips.length} local-only part${localSkips.length > 1 ? 's' : ''} skipped`);
    return {
      kind: 'pass',
      line: `PASS  ${file}${notes.length ? ` (${notes.join(', ')})` : ''}`,
      knownFailures: xfails.map(l => `${file}: ${l.trim()}`),
      localOnlySkips: localSkips.map(l => l.replace('LOCAL-ONLY SKIPPED', '').trim()),
    };
  }
  // Saying "timed out" matters because a bare "FAIL" over the tail of a stalled
  // script reads like an assertion failure and sends the next person hunting in the
  // wrong place.
  const why = run.timedOut
    ? `Timed out after ${SCRIPT_TIMEOUT_MS} ms and was killed. The script did not exit on its own.\n` +
      'A common cause here is spawning a server through `npx`: killing npx leaves the real\n' +
      'server running as a grandchild, holding the stdio pipes open so the event loop never drains.\n'
    : silentAssertion && run.status === 0
      ? 'console.assert tripped but exited 0 — use node:assert/strict so the failure is real\n'
      : '';
  return {
    kind: 'fail',
    line: `FAIL  ${file}${run.timedOut ? ` (timed out after ${SCRIPT_TIMEOUT_MS} ms)` : ''}`,
    failure: `--- ${file} ---\n${why}${combined.trim().split('\n').slice(-8).join('\n')}`,
  };
}

// Decide each script's lane. A missing script or fixture is a skip, resolved here and
// printed first so the order of the first lines does not depend on the pool.
const outcomes = new Array(TESTS.length);
const poolQueue = [];
const exclusiveQueue = [];
TESTS.forEach(([file, ...fixtures], index) => {
  if (!existsSync(join(scriptsDir, file))) {
    outcomes[index] = { kind: 'skip', line: `SKIP  ${file} (missing)` };
  } else {
    const fixture = fixtures.find(f => !existsSync(join(repoRoot, f)));
    if (fixture) outcomes[index] = { kind: 'skip', line: `SKIP  ${file} (needs ${fixture})` };
    else (file in EXCLUSIVE ? exclusiveQueue : poolQueue).push(index);
  }
  if (outcomes[index]) console.log(outcomes[index].line);
});

/** Take scripts off a queue until it is empty. Each worker prints a script's line the moment it finishes. */
async function drain(queue) {
  while (queue.length > 0) {
    const index = queue.shift();
    const file = TESTS[index][0];
    const run = await runScript(join(scriptsDir, file));
    outcomes[index] = { ...classify(file, run), file, elapsedMs: run.elapsedMs };
    console.log(outcomes[index].line);
  }
}

const scriptsStartedAt = Date.now();
await Promise.all(Array.from({ length: Math.min(JOBS, poolQueue.length) }, () => drain(poolQueue)));
for (const index of exclusiveQueue) await drain([index]);
const scriptsMs = Date.now() - scriptsStartedAt;
const slowest = outcomes
  .filter(o => o.elapsedMs !== undefined)
  .sort((a, b) => b.elapsedMs - a.elapsedMs)
  .slice(0, 3);
console.log(`\nscripts: ${TESTS.length} listed, run in ${(scriptsMs / 1000).toFixed(1)} s (${JOBS} at a time, ${exclusiveQueue.length} exclusive)`);
console.log(`slowest: ${slowest.map(o => `${o.file} ${(o.elapsedMs / 1000).toFixed(1)} s`).join(', ')}\n`);

// Fold the outcomes into the summary in TESTS order, so two runs list failures the same way.
for (const outcome of outcomes) {
  if (outcome.kind === 'skip') {
    skipped += 1;
  } else if (outcome.kind === 'pass') {
    passed += 1;
    knownFailures.push(...outcome.knownFailures);
    localOnlySkips.push(...outcome.localOnlySkips);
  } else {
    failed += 1;
    failures.push(outcome.failure);
  }
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
