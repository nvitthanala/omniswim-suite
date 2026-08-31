/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A result row with no class year is a result, not noise.
 *
 * HyTek prints "<place> <Name> <YR> <School> <times>", and
 * `backend/pdf_parser.py` split every individual line on that year token. An
 * athlete with no class year on file prints without one, and the parser hit
 * `if not yr_match: continue` and dropped the row without a word.
 *
 * In `2026_NSISC_Championships_Final_Results.pdf` that was Alessandro
 * Giustolisi (Delta State): eleven rows gone, four of them scoring finishes
 * worth 21 points. Delta State men computed 21 short of their published 875.50
 * total, and nothing anywhere said a row had been lost — the meet simply came
 * out small, which reads as a scoring defect rather than a parse defect.
 *
 * Recovery pivots on the school instead of the year. The class year is reported
 * UNKNOWN, never guessed: it is competition data that drives senior-removal
 * projections. A row that plainly is a result and still cannot be split raises.
 *
 * Skips when Python is unavailable — the parser is Python and the runner is
 * Node. Absent ≠ passing: the skip line says so.
 *
 * Test: npx tsx scripts/test_yearless_result_row.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function python(code) {
  for (const exe of ['python', 'python3', 'py']) {
    const run = spawnSync(exe, ['-c', code], { cwd: repoRoot, encoding: 'utf8' });
    if (run.error) continue;
    return run;
  }
  return null;
}

const probe = python('import sys; print(sys.version_info[0])');
if (!probe || probe.status !== 0) {
  console.log('SKIP  test_yearless_result_row (python not available)');
  process.exit(0);
}

const HARNESS = `
import json, sys
sys.path.insert(0, 'backend')
import pdf_parser
from point_calculator import is_outside_scored_program, parse_event_number

# The team cache is normally built from the PDF's own year-bearing lines.
# Longest first, which is how _build_team_cache sorts it.
pdf_parser._team_cache = [
    'Ouachita Baptist University',
    'Henderson State University',
    'University of West Florida',
    'Delta State University',
]

out = {}

# The real dropped row: Event 13 Men 100 Fly, B-Final, 9th place.
out['giustolisi'] = pdf_parser._split_yearless_individual_line(
    '9 Alessandro Giustolisi Delta State University 50.70 49.73'
)
# A normal row still splits on its year token, so recovery never sees it.
out['has_year_token'] = bool(
    __import__('re').search(pdf_parser.YEAR_PATTERN,
                            '10 Vince Pal SO Ouachita Baptist University 50.19 50.08')
)
# The team score table leads with a place and a school and nothing else.
out['team_score_line'] = pdf_parser._split_yearless_individual_line(
    '1 University of West Florida University of West Florida 1,239'
)
# A school that is not in this meet cannot anchor a split.
out['unknown_school'] = pdf_parser._split_yearless_individual_line(
    '9 Alessandro Giustolisi Nowhere Polytechnic 50.70 49.73'
)

out['lost_row_result'] = pdf_parser._looks_like_lost_result_row(
    '9 Alessandro Giustolisi Nowhere Polytechnic 50.70 49.73'
)
out['lost_row_page_header'] = pdf_parser._looks_like_lost_result_row(
    '2026 New South Intercollegiate Swimming Conference'
)
out['lost_row_team_score'] = pdf_parser._looks_like_lost_result_row(
    '1 University of West Florida University of West Florida 1,239'
)

out['event_number'] = [parse_event_number('Event 938 Women 100 Yard Breaststroke'),
                       parse_event_number('100 Yard Butterfly')]
out['outside'] = [is_outside_scored_program('Event 938 Women 100 Yard Breaststroke', 42),
                  is_outside_scored_program('Event 42 Men 4x100 Yard Freestyle Relay', 42),
                  is_outside_scored_program('Event 938 Women 100 Yard Breaststroke', None),
                  is_outside_scored_program('100 Yard Butterfly', 42)]

print(json.dumps(out))
`;

const run = python(HARNESS);
if (!run || run.status !== 0) {
  console.error('python harness failed');
  console.error(run?.stdout ?? '');
  console.error(run?.stderr ?? '');
  process.exit(1);
}
const out = JSON.parse(run.stdout.trim().split('\n').pop());

// --- Recovery ----------------------------------------------------------------
assert.deepEqual(
  out.giustolisi,
  ['UNKNOWN', '9 Alessandro Giustolisi', 'Delta State University 50.70 49.73'],
  'a yearless result row splits on the school, with the year reported UNKNOWN'
);
assert.notEqual(out.giustolisi[0], 'FR', 'the class year is never guessed');
assert.equal(out.has_year_token, true, 'ordinary rows still carry a year token and never reach recovery');

// --- Things that must NOT be recovered as athletes ----------------------------
assert.equal(out.team_score_line, null, 'the team score table is not a result row');
assert.equal(out.unknown_school, null, 'no known school means no anchor to split on');

// --- What raises, and what does not ------------------------------------------
assert.equal(out.lost_row_result, true, 'place + name + clock, unrecoverable: raise rather than drop it');
assert.equal(out.lost_row_page_header, false, 'page furniture leads with a number but carries no clock');
assert.equal(out.lost_row_team_score, false, 'team totals are not clocks');

// --- The scoring boundary, Python side ---------------------------------------
assert.deepEqual(out.event_number, [938, null]);
assert.deepEqual(
  out.outside,
  [true, false, false, false],
  'past the program excludes; the boundary is inclusive; no boundary and no number never exclude'
);

console.log('PASS  yearless result rows are recovered, not silently dropped');
