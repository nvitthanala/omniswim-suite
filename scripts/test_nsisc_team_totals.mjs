/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ground truth for the scoring engine: computed team totals against the seven
 * team scores published in `2026_NSISC_Championships_Final_Results.pdf`
 * (page 76, "Team Rankings - Through Event 42").
 *
 * Six of the seven are hard assertions. The seventh, Delta State men, is a
 * declared XFAIL — the engine is right and the committed fixture is short. Read
 * on before changing any number here.
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
 * The other seven are prelims rows and three relay legs (which cost no points —
 * a short relay splits the same team total across the legs present).
 * Fixed: `_split_yearless_individual_line` in `backend/pdf_parser.py`, which
 * pivots on the school instead and reports the year as UNKNOWN rather than
 * guessing one. Re-running the pipeline over the source PDF now reproduces all
 * seven official totals exactly.
 *
 * ## Why one assertion is still an XFAIL
 *
 * `data/meets.json` was extracted by the old parser and is missing those four
 * rows. Closing the gap means re-running `backend/parse_meet.py` over
 * `2026_NSISC_Championships_Final_Results.pdf`, which is not committed to this
 * repo. Nothing here is patched by hand: hand-typing four competition results
 * into a fixture is the practice `CLAUDE.md` bans, and a reviewer could not
 * check the transcription against a source that is not present.
 *
 * To close it: archive the results PDF, re-run the parser, then delete
 * `MEN_DELTA_STATE_XFAIL` below and let the assertion run. The guards make that
 * hard to forget — this test fails if the fixture stops being short, or if it is
 * short by any amount other than these four swims.
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
 * The one total the committed fixture cannot reach, and by exactly how much.
 * Delete this block once the fixture is re-extracted — see the header.
 */
const MEN_DELTA_STATE_XFAIL = {
  key: 'Men|Delta State University',
  /** Alessandro Giustolisi's four scoring finishes, absent from the fixture. */
  missingPoints: 21,
  missingAthlete: 'Alessandro Giustolisi',
  why: 'fixture predates the pdf_parser.py yearless-row fix; needs re-extraction from the results PDF',
};

let failed = false;
let xfailed = 0;
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
 * The fixture gap must still be the gap this test documents. If Giustolisi is
 * present the fixture has been re-extracted and the XFAIL must be promoted to a
 * real assertion, so say so rather than quietly keeping the allowance.
 */
const fixtureHasMissingAthlete = [...(ws.menResults ?? []), ...(ws.womenResults ?? [])].some(
  r => String(r.name ?? '').toLowerCase().includes('giustolisi')
);
if (fixtureHasMissingAthlete) {
  fail(
    `${MEN_DELTA_STATE_XFAIL.missingAthlete} is now in data/meets.json, so the ` +
      'fixture gap is closed. Delete MEN_DELTA_STATE_XFAIL in this file and let ' +
      'the Delta State men assertion run.'
  );
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

    if (key === MEN_DELTA_STATE_XFAIL.key) {
      const expected = -MEN_DELTA_STATE_XFAIL.missingPoints;
      if (Math.abs(delta - expected) < 0.01) {
        xfailed += 1;
        console.log(
          `XFAIL ${row} — short by exactly ${MEN_DELTA_STATE_XFAIL.missingPoints} ` +
            `(${MEN_DELTA_STATE_XFAIL.missingAthlete}: ${MEN_DELTA_STATE_XFAIL.why})`
        );
      } else {
        fail(
          `${row} — expected the documented fixture gap of ${expected.toFixed(2)}. ` +
            'The engine or the fixture moved; re-read this file\'s header before ' +
            'changing any number in it.'
        );
      }
      continue;
    }

    if (Math.abs(delta) < 0.01) {
      console.log('OK', row);
    } else {
      fail(row);
    }
  }
}

if (xfailed > 0 && !failed) {
  // Not an `XFAIL` line: the runner counts those, and the one above is the count.
  console.log(`(${xfailed} documented fixture gap, not a scoring defect)`);
}

process.exit(failed ? 1 : 0);
