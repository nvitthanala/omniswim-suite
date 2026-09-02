/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The scored-event boundary binds both scoring paths, not just one.
 *
 * `backend/point_calculator.py` has two ways to reach a team total. The
 * calculated path ranks each event and pays from the scoring table. The
 * PDF-place-points path is taken when the source PDF already prints a points
 * column — `calculate_points` sees `_effective_pdf_place_points_mode`, scores
 * every row through `_pdf_place_points_for_row`, and returns immediately.
 *
 * `scoredEventNumberMax` is the meet's own statement of which events count. It
 * comes from the official "Team Rankings - Through Event N" block, read by
 * `team_rankings_parser` and handed to scoring by `parse_meet.py`. HyTek numbers
 * post-meet extra sessions above the program — the 2026 NSISC results print
 * "Event 938 Women 100 Yard Breaststroke" and "Event 939 Boys 100 Yard
 * Breaststroke" after the time trials, with nothing but the number to give them
 * away. The meet's rankings run "Through Event 42".
 *
 * The calculated path honours that boundary through `is_unscored_round_or_event`.
 * The PDF path did not: its row scorer checked exhibition, time trial, finite
 * and non-negative, and never the event number. So a meet whose PDF prints a
 * points column paid out events its own published totals exclude.
 *
 * The boundary is not redundant with the time-trial check, and event 939 is why.
 * `is_championship_gender_event` deliberately exempts a "Boys"/"Girls" label
 * from time-trial exclusion, so a post-program event carrying that word is
 * invisible to every check except the number.
 *
 * Nor can the extractor pre-filter these rows. `pdf_parser` sets
 * `meet_has_pdf_points` once, from a results header, then reads `pdf_points` off
 * any row ending in a points integer. It never sees an event boundary — the
 * team rankings are not read until after extraction.
 *
 * Every scenario below proves the defect still reproduces without the boundary
 * before proving the boundary closes it, so none of them can pass vacuously.
 *
 * Skips when Python is unavailable — the scorer is Python and the runner is
 * Node. Absent is not passing: the skip line says so.
 *
 * Test: npx tsx scripts/test_pdf_place_points_boundary.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const PYTHONS = ['python', 'python3', 'py'];

function python(code, input) {
  for (const exe of PYTHONS) {
    const run = spawnSync(exe, ['-c', code], {
      cwd: repoRoot,
      encoding: 'utf8',
      input,
    });
    if (run.error) continue;
    return run;
  }
  return null;
}

const probe = python('import sys; print(sys.version_info[0])');
if (!probe || probe.status !== 0) {
  console.log('SKIP  test_pdf_place_points_boundary (python not available)');
  process.exit(0);
}

const IN_PROGRAM = 'Event 25 Women 100 Yard Breaststroke';
const AT_BOUNDARY = 'Event 42 Women 400 Yard Freestyle Relay';
const PAST_PROGRAM = 'Event 938 Women 100 Yard Breaststroke';
const PAST_PROGRAM_BOYS = 'Event 939 Boys 100 Yard Breaststroke';
const UNNUMBERED = '100 Yard Butterfly';

/**
 * Place points as the PDF prints them. The in-program values are deliberately
 * not values the scoring table can produce (8.5, 6.5) — if the calculated path
 * ran instead, these rows would come back 20/17 and the assertions below would
 * catch it. That is what keeps this test honest about which path it exercised.
 */
let n = 0;
const row = (event, pdfPoints, extra = {}) => ({
  id: `r${++n}`,
  event,
  name: `Swimmer ${n}`,
  team: n % 2 ? 'Delta State University' : 'Ouachita Baptist University',
  gender: 'Women',
  rank: '1',
  finals_time: '1:03.53',
  prelims_time: 'NT',
  round_swam: 'A Final',
  pdf_points: pdfPoints,
  ...extra,
});

/**
 * Ten rows carry printed points, which clears `_results_have_pdf_place_points`
 * (threshold `max(8, ceil(n * 0.01))`). That lets the same fixture exercise the
 * auto-detected mode, not only the explicitly flagged one.
 */
const RESULTS = [
  row(IN_PROGRAM, 8.5),
  row(IN_PROGRAM, 6.5),
  row(IN_PROGRAM, 5),
  row(IN_PROGRAM, 4),
  row(AT_BOUNDARY, 7),
  row(AT_BOUNDARY, 3),
  row(UNNUMBERED, 11),
  row(UNNUMBERED, 2),
  // Past the program. The meet's own rankings stop at 42; the PDF still prints
  // a points column for these, and one entrant each makes them worth a win.
  row(PAST_PROGRAM, 9),
  row(PAST_PROGRAM_BOYS, 9, { gender: 'Men' }),
];

const BASE = { scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1] };

const SCENARIOS = {
  // Explicitly flagged, no boundary published: the defect.
  explicit_unbounded: { ...BASE, usePdfPlacePoints: true },
  // Explicitly flagged, boundary published.
  explicit_bounded: { ...BASE, usePdfPlacePoints: true, scoredEventNumberMax: 42 },
  // Flag absent, so the mode is auto-detected off the rows themselves.
  auto_unbounded: { ...BASE },
  auto_bounded: { ...BASE, scoredEventNumberMax: 42 },
};

const HARNESS = `
import copy, json, sys
sys.path.insert(0, 'backend')
import point_calculator

payload = json.loads(sys.stdin.read())
rows, scenarios = payload['rows'], payload['scenarios']

out = {}
for key, cfg in scenarios.items():
    athletes = copy.deepcopy(rows)
    resolved = point_calculator._resolve_scoring_settings(copy.deepcopy(cfg))
    scored = point_calculator.calculate_points(athletes, copy.deepcopy(cfg))
    by_event = {}
    for a in scored:
        pts = a.get('calculated_points')
        pts = float(pts) if isinstance(pts, (int, float)) else 0.0
        by_event[a['event']] = by_event.get(a['event'], 0.0) + pts
    out[key] = {
        'byEvent': by_event,
        'pdfMode': point_calculator._effective_pdf_place_points_mode(resolved, scored),
    }
print(json.dumps(out))
`;

const run = python(HARNESS, JSON.stringify({ rows: RESULTS, scenarios: SCENARIOS }));
if (!run || run.status !== 0) {
  console.error('python harness failed');
  console.error(run?.stdout ?? '');
  console.error(run?.stderr ?? '');
  process.exit(1);
}
const out = JSON.parse(run.stdout.trim().split('\n').pop());

const pts = (scenario, event) => out[scenario].byEvent[event] ?? 0;

// --- Both scenarios really do take the PDF-place-points path -------------------
// Without this the rest of the file could pass by scoring nothing anywhere.
for (const key of Object.keys(SCENARIOS)) {
  assert.equal(out[key].pdfMode, true, `${key} must run in PDF-place-points mode`);
  assert.equal(
    pts(key, IN_PROGRAM),
    24,
    `${key} must pay the PDF's own printed points (8.5+6.5+5+4), not the scoring table`
  );
}

// --- The defect still reproduces without the boundary --------------------------
assert.equal(
  pts('explicit_unbounded', PAST_PROGRAM),
  9,
  'fixture no longer reproduces the defect: event 938 must score its printed points when no boundary is given'
);
assert.equal(
  pts('auto_unbounded', PAST_PROGRAM),
  9,
  'the auto-detected mode reproduces it too'
);
assert.equal(
  pts('explicit_unbounded', PAST_PROGRAM_BOYS),
  9,
  'event 939 is labelled "Boys", which is exempt from time-trial exclusion — only the number can catch it'
);

// --- The boundary closes it on both entries into the mode ----------------------
for (const key of ['explicit_bounded', 'auto_bounded']) {
  assert.equal(
    pts(key, PAST_PROGRAM),
    0,
    `${key}: an event past the meet program must score nothing, printed points or not`
  );
  assert.equal(
    pts(key, PAST_PROGRAM_BOYS),
    0,
    `${key}: the "Boys" label does not buy a post-program event back in`
  );
}

// --- Nothing inside the program moves ------------------------------------------
for (const key of ['explicit_bounded', 'auto_bounded']) {
  assert.equal(pts(key, AT_BOUNDARY), 10, `${key}: the boundary is inclusive — event 42 still scores (7+3)`);
  assert.equal(
    pts(key, UNNUMBERED),
    13,
    `${key}: an unnumbered label still scores — zeroing these would empty every projection`
  );
}

const bounded = out.explicit_bounded.byEvent;
const unbounded = out.explicit_unbounded.byEvent;
for (const event of [IN_PROGRAM, AT_BOUNDARY, UNNUMBERED]) {
  assert.equal(
    bounded[event],
    unbounded[event],
    `the boundary must touch only post-program events; ${event} moved`
  );
}
assert.equal(
  Object.values(unbounded).reduce((s, v) => s + v, 0) -
    Object.values(bounded).reduce((s, v) => s + v, 0),
  18,
  'exactly the two phantom post-program wins come off (9 + 9)'
);

console.log('PASS  PDF place points respect the scored-event boundary');
