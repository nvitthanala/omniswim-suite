/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An exhibition swim in a tied A/B-final group costs only its own points. Both
 * engines agree.
 *
 * User decision E2 (2026-10-16). The TypeScript scorer (`calculatePoints`) and
 * its Python twin (`backend/point_calculator.py`) used to zero the WHOLE tie group
 * when an exhibition swimmer sat in it. The Python twin also read the exhibition
 * flag from the group's first row only, so the answer depended on row order.
 * Now the exhibition swim scores 0 and leaves the tie count; every other row
 * earns what it would with that swimmer absent.
 *
 * This test feeds the same synthetic rows to both engines and checks the same
 * hand-worked numbers. Table: 20 17 16 15 14 13 12 11 9 7 6 5 4 3 2 1.
 *
 * Skips when Python is unavailable. Absent is not passing: the skip line says so.
 *
 * Test: npx tsx scripts/test_exhibition_tie_parity.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { calculatePoints } from '../packages/core/src/lib/calculatePoints.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CALCULATOR = join(repoRoot, 'backend', 'point_calculator.py');
const EVENT = 'Event 1 Women 100 Yard Freestyle';

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
  console.log('SKIP  test_exhibition_tie_parity (python not available)');
  process.exit(0);
}

const SETTINGS = {
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: false,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  scorerCapScope: 'event',
  aFinalBracketSize: 8,
  maxTotalEntriesPerSwimmer: 999,
};

/** One spec: [name, team, rank, time, isExhibition, round]. The round defaults to the A final. */
const tsRow = ([name, team, rank, time, ex, round = 'A Final']) => ({
  id: `${name}|${round}|${rank}`,
  name,
  team,
  rank,
  time,
  finalsTime: time,
  classYear: 'SR',
  event: EVENT,
  roundSwam: round,
  points: 0,
  gender: Gender.WOMEN,
  isRelay: false,
  isExhibition: ex === true,
  isTimeTrial: false,
  relayNames: [],
});
// The Python engine reads exhibition from the `X` marker the PDF parser leaves on the clock.
const pyRow = ([name, team, rank, time, ex, round = 'A Final']) => ({
  name,
  team,
  rank,
  year: 'SR',
  event: EVENT,
  gender: 'Women',
  round_swam: round,
  finals_time: ex === true ? `X${time}` : time,
  prelims_time: null,
  is_relay: false,
});

function tsPoints(specs, settings, overrides) {
  const scored = calculatePoints(specs.map(tsRow), mergeScoringSettings(settings), {
    scorerRosterOverrides: overrides.map(o => ({ ...o, gender: Gender.WOMEN })),
  });
  return Object.fromEntries(scored.map(r => [r.name, r.points]));
}
function pyPoints(specs, settings, overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-exh-tie-'));
  try {
    const withRoster = { ...settings, scorerRosterOverrides: overrides.map(o => ({ ...o, gender: 'Women' })) };
    writeFileSync(join(dir, 'scoring_settings.json'), JSON.stringify(withRoster));
    const run = python([CALCULATOR], {
      input: JSON.stringify(specs.map(pyRow)),
      env: { ...process.env, OMNI_DATA_DIR: dir },
    });
    assert.ok(run && run.status === 0, `calculator failed:\n${run?.stderr ?? ''}`);
    const rows = JSON.parse(run.stdout.trim());
    assert.ok(Array.isArray(rows), `expected an array, got: ${run.stdout.slice(0, 200)}`);
    assert.equal(rows.length, specs.length, 'each row is emitted exactly once');
    return Object.fromEntries(rows.map(r => [r.name, r.calculated_points]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let n = 0;
function both(label, specs, expected, settings = SETTINGS, overrides = []) {
  assert.deepEqual(tsPoints(specs, settings, overrides), expected, `TypeScript: ${label}`);
  assert.deepEqual(pyPoints(specs, settings, overrides), expected, `Python: ${label}`);
  n += 1;
  console.log(`  ok ${n} — ${label}`);
}

const A = ['A', 'Team A', 1, '50.00'];
const X = ['X', 'Team X', 1, '50.00', true];
both('scorer tied for 1st with an exhibition swim scores 20', [A, X], { A: 20, X: 0 });
both('the same with the exhibition row first (order must not matter)', [X, A], { A: 20, X: 0 });

both(
  'three-way tie for 2nd with one exhibition: the scorers split 17 and 16; the entry printed 5th is 4th (15)',
  [
    ['W', 'Team W', 1, '49.50'],
    ['B', 'Team B', 2, '50.00'],
    ['X', 'Team X', 2, '50.00', true],
    ['C', 'Team C', 2, '50.00'],
    ['N', 'Team N', 5, '50.60'],
  ],
  { W: 20, B: 16.5, C: 16.5, X: 0, N: 15 }
);

both(
  'exhibition entries ahead are absent: the entry behind moves up to first (20)',
  [
    ['X1', 'Team X1', 1, '50.00', true],
    ['X2', 'Team X2', 1, '50.00', true],
    ['Z', 'Team Z', 2, '50.50'],
  ],
  { X1: 0, X2: 0, Z: 20 }
);

// The exhibition swim is listed first and sits in rank 1 with a scorer. A group
// keyed off its first row (the exhibition swim) used to sort last in Python, so
// Team A's rank-2 swimmer took the one scoring slot before the rank-1 swimmer.
both(
  'a per-team cap of 1 admits the rank-1 scorer before the rank-2 swimmer',
  [
    ['X', 'Team X', 1, '50.00', true],
    ['A1', 'Team A', 1, '50.00'],
    ['A2', 'Team A', 2, '50.50'],
  ],
  { X: 0, A1: 20, A2: 0 },
  { ...SETTINGS, maxIndividualScorersPerTeam: 1 }
);

// Roster eligibility is per swimmer. Three swimmers tie for 1st: two of Team A and one of Team B. One Team A
// swimmer is off the scoring roster. Only that swimmer loses their share; the tie share does not move.
const ROSTER = { ...SETTINGS, scorerEligibilityMode: 'roster' };
const SHARE = (20 + 17 + 16) / 3;
both(
  'a tied teammate off the scoring roster costs only their own points',
  [
    ['On', 'Team A', 1, '50.00'],
    ['Off', 'Team A', 1, '50.00'],
    ['Rival', 'Team B', 1, '50.00'],
  ],
  { On: SHARE, Off: 0, Rival: SHARE },
  ROSTER,
  [{ name: 'Off', team: 'Team A', isScorer: false }]
);

// A row past a gap in the printed ranks moves up by the exhibition entries only. R is an
// unprojected recruit at A-Final rank 12: with X removed it is 11th (6 points), not the dense
// 8th (11 points). The B final is its own tier and does not move.
both(
  'a row at rank 12 behind a gap is 11th with one exhibition entry ahead (6), not 8th',
  [
    ['F1', 'T1', 1, '50.00'],
    ['F2', 'T2', 2, '50.10'],
    ['X', 'T3', 3, '50.20', true],
    ['F4', 'T4', 4, '50.30'],
    ['F5', 'T5', 5, '50.40'],
    ['F6', 'T6', 6, '50.50'],
    ['F7', 'T7', 7, '50.60'],
    ['F8', 'T8', 8, '50.70'],
    ['R', 'T9', 12, '51.50'],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => [`G${i}`, `U${i}`, i, `52.${i}0`, false, 'B Final']),
  ],
  {
    F1: 20, F2: 17, X: 0, F4: 16, F5: 15, F6: 14, F7: 13, F8: 12, R: 6,
    G1: 9, G2: 7, G3: 6, G4: 5, G5: 4, G6: 3, G7: 2, G8: 1,
  }
);

// A disqualified row that keeps a printed rank still holds its place. Only the exhibition
// entry leaves, so S is 2nd (17) in both engines. Python used to drop the DQ row first.
both(
  'a disqualified row ahead holds its place: DQ 1st, X 2nd, S 3rd scores 17',
  [
    ['D', 'Team D', 1, 'DQ'],
    ['X', 'Team X', 2, '50.00', true],
    ['S', 'Team S', 3, '50.50'],
  ],
  { D: 0, X: 0, S: 17 }
);

// The same rule when the printed ranks run ahead of the rows: P, D (disqualified) and X
// (exhibition) share 1st, then S is printed 2nd. The disqualified row still holds its place,
// so two rows other than X are ahead of S and S is 3rd (16). Python used to drop D first and
// give S 2nd (17).
both(
  'a disqualified row in a tie still counts as ahead of the next printed rank',
  [
    ['P', 'Team P', 1, '50.00'],
    ['D', 'Team D', 1, 'DQ'],
    ['X', 'Team X', 1, '50.00', true],
    ['S', 'Team S', 2, '50.50'],
  ],
  { P: 20, D: 0, X: 0, S: 16 }
);

// Roster mode applies the per-event cap per swimmer: with a cap of 1, the rank-1 swimmer
// takes the one slot and the rank-2 teammate scores 0. Python used to skip the cap here.
both(
  'roster mode with a per-event cap of 1: the rank-2 teammate scores 0',
  [
    ['A1', 'Team A', 1, '50.00'],
    ['A2', 'Team A', 2, '50.50'],
  ],
  { A1: 20, A2: 0 },
  { ...ROSTER, maxIndividualScorersPerTeam: 1, scorerCapScope: 'event' }
);

// The meet-wide pool applies in roster mode too. Pool of 1 across two events is checked by
// the cap alone here: one slot, taken by the faster swimmer even when listed second.
both(
  'roster mode with a meet-wide pool of 1: the faster swimmer takes the slot',
  [
    ['A2', 'Team A', 1, '50.50'],
    ['A1', 'Team A', 1, '50.00'],
  ],
  { A2: 0, A1: (20 + 17) / 2 },
  { ...ROSTER, maxIndividualScorersPerTeam: 1, scorerCapScope: 'meet' }
);

console.log(`\ntest_exhibition_tie_parity OK (${n} cases, both engines)`);
