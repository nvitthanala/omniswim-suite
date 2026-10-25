/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A row with no readable swim time earns no place and no points.
 *
 * `backend/point_calculator.py` `time_to_sec` used to return 9999.99 for an
 * empty, NT or unreadable clock. The sentinel sorted like a very slow swim, and
 * nothing else looked at the clock: the place came from the printed rank. A row
 * whose time the parser could not read still scored, and a bad-clock row that
 * shared a printed rank with a real swimmer split that swimmer's points.
 *
 * `time_to_sec` now returns None. The calculator zeroes such a row, keeps it in
 * the output once, and adds a `parse_warnings` entry (code `unreadable_time`).
 *
 * This test runs the real CLI contract: rows on stdin, scored rows on stdout,
 * settings read from OMNI_DATA_DIR. It also feeds the output through the same
 * TypeScript row mapper the server uses, so a shape change would fail here.
 *
 * Every name, team and time below is synthetic.
 *
 * Skips when Python is unavailable. Absent is not passing: the skip line says so.
 *
 * Test: npx tsx scripts/test_python_bad_times.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mapAthleteRows } from '../apps/shell/lib/routes/parsingPipeline.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CALCULATOR = join(repoRoot, 'legacy', 'backend', 'point_calculator.py');

function python(args, options = {}) {
  for (const exe of ['python', 'python3', 'py']) {
    const run = spawnSync(exe, args, { cwd: repoRoot, encoding: 'utf8', ...options });
    if (run.error) continue;
    return run;
  }
  return null;
}

const probe = python(['-c', 'import sys; print(sys.version_info[0])']);
if (!probe || probe.status !== 0) {
  console.log('SKIP  test_python_bad_times (python not available)');
  process.exit(0);
}

// A complete settings file, so the test does not depend on data/.
const SETTINGS = {
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: false,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  scorerCapScope: 'event',
  aFinalBracketSize: 8,
};

function row(name, rank, finalsTime, extra = {}) {
  return {
    name,
    rank,
    team: 'Synthetic Team A',
    year: 'SR',
    event: 'Event 1 Women 100 Yard Freestyle',
    gender: 'Women',
    round_swam: 'A Final',
    finals_time: finalsTime,
    prelims_time: null,
    is_relay: false,
    ...extra,
  };
}

const dataDir = mkdtempSync(join(tmpdir(), 'omni-bad-times-'));
let scored;
try {
  writeFileSync(join(dataDir, 'scoring_settings.json'), JSON.stringify(SETTINGS));
  const input = [
    // A tie group: one real swim and one whose clock cannot be read.
    row('Alice Synthetic', 1, '50.00'),
    row('Bob Synthetic', 1, 'abc', { team: 'Synthetic Team B' }),
    // An NT row with a printed place, between two real swims.
    row('Cara Synthetic', 2, '51.00', { team: 'Synthetic Team C' }),
    row('Dana Synthetic', 3, 'NT', { team: 'Synthetic Team D' }),
    row('Eli Synthetic', 4, '52.00', { team: 'Synthetic Team E' }),
  ];
  const run = python([CALCULATOR], {
    input: JSON.stringify(input),
    env: { ...process.env, OMNI_DATA_DIR: dataDir },
  });
  assert.ok(run && run.status === 0, `calculator failed:\n${run?.stderr ?? ''}`);
  scored = JSON.parse(run.stdout.trim());
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

assert.ok(Array.isArray(scored), `expected an array, got: ${JSON.stringify(scored).slice(0, 200)}`);
const byName = new Map(scored.map(r => [r.name, r]));

// Nothing is dropped or duplicated.
assert.equal(scored.length, 5);
assert.equal(byName.size, 5);

// The real swimmers keep full, undiluted points.
assert.equal(byName.get('Alice Synthetic').calculated_points, 20);
assert.equal(byName.get('Cara Synthetic').calculated_points, 17);
assert.equal(byName.get('Eli Synthetic').calculated_points, 15);
for (const name of ['Alice Synthetic', 'Cara Synthetic', 'Eli Synthetic']) {
  assert.equal(byName.get(name).parse_warnings, undefined, `${name} must carry no warning`);
}

// The bad-clock rows earn nothing and say why. A numeric 0, never null or "N/A":
// the TypeScript mapper reads `calculated_points` as a finite number.
const bob = byName.get('Bob Synthetic');
assert.equal(bob.calculated_points, 0);
assert.equal(bob.parse_warnings.length, 1);
assert.equal(bob.parse_warnings[0].code, 'unreadable_time');
assert.equal(bob.parse_warnings[0].reason, 'unparseable');

const dana = byName.get('Dana Synthetic');
assert.equal(dana.calculated_points, 0);
assert.equal(dana.parse_warnings[0].code, 'unreadable_time');
assert.equal(dana.parse_warnings[0].reason, 'status_code');
assert.equal(dana.podium, null);
assert.equal(dana.rank, 3, 'the printed rank is source data and is not rewritten');

// The server's row mapper accepts the output unchanged.
const mapped = mapAthleteRows(scored);
assert.equal(mapped.length, 5);
assert.equal(mapped.find(r => r.name === 'Dana Synthetic').points, 0);

// --- PDF place-points mode ----------------------------------------------------
// The printed points are trusted, so a garbled clock keeps them (and warns). An
// explicit status clock beside printed points is a column drift and stops the
// import with a tagged error. The CLI prints it on stdout as JSON.
function runCalculator(rows, settings) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-bad-times-'));
  try {
    writeFileSync(join(dir, 'scoring_settings.json'), JSON.stringify(settings));
    const run = python([CALCULATOR], {
      input: JSON.stringify(rows),
      env: { ...process.env, OMNI_DATA_DIR: dir },
    });
    assert.ok(run && run.status === 0, `calculator failed: ${run?.stderr ?? ''}`);
    return JSON.parse(run.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const PDF_MODE = { ...SETTINGS, usePdfPlacePoints: true };

const kept = runCalculator(
  [
    row('Alice Synthetic', 1, '50.00', { pdf_points: 20 }),
    row('Bob Synthetic', 2, 'abc', { pdf_points: 17, team: 'Synthetic Team B' }),
  ],
  PDF_MODE
);
assert.ok(Array.isArray(kept));
const keptBob = kept.find(r => r.name === 'Bob Synthetic');
assert.equal(keptBob.calculated_points, 17, 'printed points are kept for a garbled clock');
assert.equal(keptBob.parse_warnings[0].code, 'unreadable_time');
assert.equal(mapAthleteRows(kept).length, 2);

const refused = runCalculator(
  [
    row('Alice Synthetic', 1, '50.00', { pdf_points: 20 }),
    row('Bob Synthetic', 2, 'DQ', { pdf_points: 17, team: 'Synthetic Team B' }),
  ],
  PDF_MODE
);
assert.ok(!Array.isArray(refused), 'a status clock with printed points must not score');
assert.equal(refused.code, 'points_on_status_clock');
assert.equal(refused.rows.length, 1);
assert.match(refused.rows[0], /Bob Synthetic/);
assert.match(refused.error, /columns drifted/);

console.log('OK  test_python_bad_times: unreadable and NT clocks earn no place, no points, and a warning');
