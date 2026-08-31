/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ground truth for the scoring engine: computed team totals against the seven
 * team scores published in `2026_NSISC_Championships_Final_Results.pdf`
 * (page 76, "Team Rankings - Through Event 42").
 *
 * All seven are hard assertions and all seven match exactly. Read on before
 * changing any number here.
 *
 * ## What the two original mismatches were
 *
 * The engine used to report Delta State women 936 against an official 916, and
 * Delta State men 874.50 against an official 875.50. Two unrelated defects,
 * which nearly cancelled on the men's side and so looked like a rounding slip.
 *
 * **+20 to each Delta State squad — scoring.** The results PDF prints two real
 * events after the time trials: "Event 938 Women 100 Yard Breaststroke" (Kiera
 * Cloete, 1:05.16) and "Event 939 Boys 100 Yard Breaststroke" (Jacob Hamblen,
 * 53.66R). Both are genuine event headers with records, qualifying standards
 * and an A-Final section, so the extraction was faithful. HyTek scored neither:
 * the team rankings run "Through Event 42". The engine scored both, because its
 * non-scoring gate keyed on the literal string "TIME TRIAL" in the event name
 * and the meet host left that suffix off. One entrant per event, so each won it
 * outright — 20 points from nothing, to the same team in both genders.
 * Fixed: `ScoringSettings.scoredEventNumberMax`, fed here and by
 * `scoringEngine.ts` from `officialTeamScores.eventThrough`.
 *
 * **-21 to Delta State men — extraction.** Alessandro Giustolisi (Delta State)
 * has no class year in the PDF, so his rows print as
 * "9 Alessandro Giustolisi Delta State University 50.70 49.73" while every other
 * row carries "FR"/"SO"/"JR"/"SR" between the name and the school.
 * `backend/pdf_parser.py` pivoted on that year token and dropped, without a
 * word, all eleven of his rows. Four were scoring finishes:
 *
 *   Event  8 Men  50 Free   B-Final 14th   3
 *   Event 13 Men 100 Fly    B-Final  9th   9
 *   Event 28 Men 200 Fly    B-Final 10th   7
 *   Event 35 Men 100 Free   B-Final 15th   2
 *                                        ---
 *                                         21
 *
 * His other three rows are relay legs, which cost no points — a short relay
 * splits the same team total across the legs present.
 * Fixed: `_split_yearless_individual_line` in `backend/pdf_parser.py`, which
 * pivots on the school instead and reports the year as UNKNOWN rather than
 * guessing one. Its relay twin, `_parse_relay_leg_line`, put Giustolisi back
 * on the three Delta State relays he swam — see
 * `scripts/test_yearless_relay_row.mjs`.
 *
 * ## The fixture
 *
 * `data/meets.json` was extracted by the old parser and carried that gap as a
 * declared XFAIL until 2026-08-31, when the workspace was re-extracted from the
 * source PDF by `scripts/reextract_meet_workspace.mjs`. Nothing here is patched
 * by hand: hand-typing four competition results into a fixture is the practice
 * `CLAUDE.md` bans, and a reviewer could not check the transcription against a
 * source that is not present.
 *
 * The four scoring swims are asserted below by name and by their point total, so
 * a fixture re-extracted with a broken parser fails with a message that says
 * what is missing, instead of only a total that comes out 21 short.
 */
import { readFileSync } from 'fs';
import {
  calculatePoints,
  mergeScoringSettings,
  looksLikeInstitutionTeamName,
} from '../packages/core/src/lib/utils.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets.find(m => m.conference === 'NSISC');
if (!ws) {
  console.error('NSISC workspace not found');
  process.exit(1);
}

const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });

/** PDF page 76: "Team Rankings - Through Event 42". */
const official = {
  'Women|University of West Florida': 1239,
  'Women|Delta State University': 916,
  'Women|Ouachita Baptist University': 536,
  'Women|Henderson State University': 476,
  'Men|Henderson State University': 1056,
  'Men|Ouachita Baptist University': 1029.5,
  'Men|Delta State University': 875.5,
};

/**
 * The four B-final swims the old parser dropped, and what each is worth. They
 * are why Delta State men used to compute 21 short. Verbatim from the PDF.
 */
const RECOVERED_SWIMS = {
  athlete: 'Alessandro Giustolisi',
  team: 'Delta State University',
  points: 21,
  swims: [
    { event: 'Event 8 Men 50 Yard Freestyle', rank: 14, points: 3 },
    { event: 'Event 13 Men 100 Yard Butterfly', rank: 9, points: 9 },
    { event: 'Event 28 Men 200 Yard Butterfly', rank: 10, points: 7 },
    { event: 'Event 35 Men 100 Yard Freestyle', rank: 15, points: 2 },
  ],
};

let failed = false;
const fail = msg => {
  console.log('FAIL', msg);
  failed = true;
};

// The engine must be told where the meet stopped scoring. Without it the two
// post-meet events score and both Delta State squads read 20 points high.
const eventThrough = ws.officialTeamScores?.eventThrough;
if (eventThrough !== 42) {
  fail(
    `officialTeamScores.eventThrough is ${JSON.stringify(eventThrough)}; the ` +
      'published NSISC team rankings run through event 42. Without the boundary ' +
      'this test cannot tell a scoring defect from a missing input.'
  );
}

/**
 * The rows the old parser lost must be in the fixture. A re-extraction with a
 * regressed parser would otherwise show up only as a total 21 short, which
 * reads as a scoring defect rather than the parse defect it is.
 */
const recovered = (ws.menResults ?? []).filter(
  r =>
    String(r.name ?? '').trim() === RECOVERED_SWIMS.athlete &&
    r.team === RECOVERED_SWIMS.team &&
    !r.isRelay
);
for (const swim of RECOVERED_SWIMS.swims) {
  const row = recovered.find(r => r.event === swim.event && r.roundSwam === 'B Final');
  if (!row) {
    fail(
      `${RECOVERED_SWIMS.athlete} has no ${swim.event} B-final row in data/meets.json. ` +
        'He swims with no class year printed, so a parser that pivots on the year token ' +
        'drops him; re-extract with scripts/reextract_meet_workspace.mjs.'
    );
  } else if (row.rank !== swim.rank) {
    fail(`${RECOVERED_SWIMS.athlete} ${swim.event}: rank ${row.rank}, PDF says ${swim.rank}`);
  }
}
if (recovered.some(r => r.classYear !== 'UNKNOWN')) {
  fail(
    `${RECOVERED_SWIMS.athlete} carries a class year in data/meets.json. The PDF prints ` +
      'none, and a class year drives senior-removal projections — it is never guessed.'
  );
}

/** And they must still be worth what the PDF's place points say they are. */
{
  const declared = RECOVERED_SWIMS.swims.reduce((sum, s) => sum + s.points, 0);
  if (declared !== RECOVERED_SWIMS.points) {
    fail(`RECOVERED_SWIMS lists ${declared} points but claims ${RECOVERED_SWIMS.points}`);
  }
  const scoredMen = calculatePoints(ws.menResults ?? [], settings, {
    scorerRosterOverrides: ws.scorerRosterOverrides,
    scoredEventNumberMax: eventThrough,
  });
  for (const swim of RECOVERED_SWIMS.swims) {
    const row = scoredMen.find(
      r =>
        String(r.name ?? '').trim() === RECOVERED_SWIMS.athlete &&
        r.event === swim.event &&
        r.roundSwam === 'B Final'
    );
    if (row && row.points !== swim.points) {
      fail(
        `${RECOVERED_SWIMS.athlete} ${swim.event}: scored ${row.points}, ` +
          `${swim.rank}th place pays ${swim.points}`
      );
    }
  }
}

function teamTotals(results) {
  const scored = calculatePoints(results ?? [], settings, {
    scorerRosterOverrides: ws.scorerRosterOverrides,
    scoredEventNumberMax: eventThrough,
  });
  const byTeam = {};
  for (const r of scored) {
    const tName = String(r.name ?? '').trim().toLowerCase();
    const tTeam = String(r.team ?? '').trim().toLowerCase();
    if (tName && tTeam === tName && !looksLikeInstitutionTeamName(r.team)) continue;
    const t = r.team;
    if (!t) continue;
    byTeam[t] = (byTeam[t] ?? 0) + (typeof r.points === 'number' ? r.points : 0);
  }
  return byTeam;
}

for (const [label, results] of [
  ['Women', ws.womenResults],
  ['Men', ws.menResults],
]) {
  const byTeam = teamTotals(results);
  for (const [key, off] of Object.entries(official)) {
    if (!key.startsWith(label + '|')) continue;
    const school = key.slice(label.length + 1);
    const calc = byTeam[school] ?? 0;
    const delta = Math.round((calc - off) * 100) / 100;
    const row = `${label} ${school}: ${calc.toFixed(2)} official ${off} delta ${delta.toFixed(2)}`;

    if (Math.abs(delta) < 0.01) {
      console.log('OK', row);
    } else {
      fail(row);
    }
  }
}

if (!failed) {
  console.log(
    `OK ${RECOVERED_SWIMS.athlete}'s ${RECOVERED_SWIMS.swims.length} scoring swims ` +
      `(${RECOVERED_SWIMS.points} points) are in the fixture, class year UNKNOWN`
  );
}

process.exit(failed ? 1 : 0);
