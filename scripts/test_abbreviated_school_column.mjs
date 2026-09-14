/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A yearless result row whose school column prints an abbreviation.
 *
 * `_split_yearless_individual_line` in `backend/pdf_parser.py` recovers a result
 * row that carries no class year by pivoting on the school instead of the year
 * token. It took the school from the team cache built out of the same PDF, and
 * that cache harvests school names from rows that DO carry a class year.
 *
 * `glvc_results26.pdf` prints the school column as a HyTek team code throughout
 * — "52 Drew E Baker SBU 2:00.60" — and Southwest Baptist prints no class year
 * for anyone. So SBU never entered the cache, no SBU row could be split, and the
 * first one raised. The raise is deliberate ("refuse rather than silently short
 * a meet"), so one unrecoverable row aborted the whole Great Lakes Valley
 * Conference meet: 0 rows out, not 2348.
 *
 * 83 lines raised. They were two different defects:
 *
 *   (a) 72 genuine yearless individual results whose school column is a team
 *       code. Fixed by pivoting on the code, expanded through ABBREV_TEAMS —
 *       the same archived table `match_abbrev_team` already uses to resolve the
 *       school on every year-bearing row in this PDF. No second table, and no
 *       code is invented: an unrecorded code still returns None and still
 *       raises, which is how a new conference's abbreviation gets added with a
 *       source instead of guessed.
 *
 *   (b) 11 relay entry rows — "16 UMSL B 6:53.13" — that were never individual
 *       results. `_looks_like_lost_result_row` counted the team code and the
 *       relay squad letter as two name words. Fixed by recognising the shape,
 *       not by forcing the rows through: they reach the individual branch only
 *       through column bleed, so the event header in hand is not their event,
 *       and filing them would put a relay under a diving event.
 *
 * Every fixture below is a verbatim line from an archived meet PDF, as
 * pdfplumber extracts it. Sources:
 *   GLVC   glvc_results26.pdf
 *   NSISC  2026_NSISC_Championships_Final_Results.pdf
 *
 * Skips when Python is unavailable — the parser is Python and the runner is
 * Node. Absent ≠ passing: the skip line says so.
 *
 * Test: npx tsx scripts/test_abbreviated_school_column.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function python(code, input) {
  for (const exe of ['python', 'python3', 'py']) {
    const run = spawnSync(exe, ['-c', code], {
      cwd: repoRoot,
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
    });
    if (run.error) continue;
    return run;
  }
  return null;
}

const probe = python('import sys; print(sys.version_info[0])');
if (!probe || probe.status !== 0) {
  console.log('SKIP  test_abbreviated_school_column (python not available)');
  process.exit(0);
}

const HARNESS = `
import json, sys
sys.path.insert(0, 'backend')
import pdf_parser

# The team cache is normally built from the PDF's own year-bearing lines. These
# are the four NSISC schools, longest first, which is how _build_team_cache
# sorts it. No GLVC code appears here, and that is the point: the GLVC school
# column is an abbreviation, so the cache can never hold it.
pdf_parser._team_cache = [
    'Ouachita Baptist University',
    'Henderson State University',
    'University of West Florida',
    'Delta State University',
]

# getattr, not a direct call: on the pre-fix parser these helpers do not exist,
# and this test has to fail on its assertions rather than crash on an
# AttributeError. A crash proves the module changed; only an assertion proves
# the behaviour did.
_relay = getattr(pdf_parser, '_looks_like_relay_entry_row', lambda line: None)
_code = getattr(pdf_parser, '_resolve_team_code', lambda token: None)

lines = json.loads(sys.stdin.read())
out = {'split': {}, 'relay': {}, 'lost': {}, 'code': {}, 'loose': {}}
for key, line in lines.items():
    out['split'][key] = pdf_parser._split_yearless_individual_line(line)
    out['relay'][key] = _relay(line)
    out['lost'][key] = pdf_parser._looks_like_lost_result_row(line)

for token in ['SBU', 'QU', 'MS&T', 'ROCK', 'Rock', 'Baker', 'Manlu', 'B', 'ZZZ']:
    out['code'][token] = _code(token)
    out['loose'][token] = pdf_parser.match_abbrev_team(token)

print(json.dumps(out))
`;

/** Verbatim lines, one per case the parser must get right. */
const LINES = {
  // GLVC, women's 200 free prelims. The row that the cache cannot split: no
  // class year, and "SBU" is a code the PDF never spells out.
  glvc_code_school: '52 Drew E Baker SBU 2:00.60',
  // GLVC, men's 100 breaststroke. A two-letter code, below the cache's own
  // three-character floor even if a year-bearing SBU row had existed.
  glvc_two_letter_code: '28 Santi Leiva QU 59.20',
  // GLVC, men's 50 free prelims. The trailing "B" is an NCAA DII B-cut tag on
  // the qualifying column, not a relay squad letter and not a school.
  glvc_cut_tag_tail: '10 Santi Leiva QU 20.31 B',
  // GLVC. Two result columns landed on one line. Barone swam the 100
  // breaststroke in 1:18.26; 55.88 is Marco Flores's swim in another event.
  glvc_two_columns: '41 Eliana Barone SBU 1:18.26 18 Marco Flores MS&T 55.88',
  // GLVC relay entry rows. Not individual results. Each reached the individual
  // branch under a diving or distance-freestyle event header.
  glvc_relay_entry: '16 UMSL B 6:53.13',
  glvc_relay_entry_two_letter: '19 LU B 1:26.08',
  glvc_relay_entry_ampersand: '15 MS&T B 6:48.52',
  // NSISC, men's 100 fly B-final. The original yearless row, school spelled out
  // in full. It must still split on the cache, exactly as before.
  nsisc_full_school: '9 Alessandro Giustolisi Delta State University 50.70 49.73',
  // A code that is not in the archived abbreviation table. Nothing may be
  // guessed from it, so the row stays unrecoverable and the caller raises.
  unrecorded_code: '52 Drew E Baker ZZZ 2:00.60',
  // Page furniture. Leads with a number, carries no clock.
  page_header: '2026 New South Intercollegiate Swimming Conference',
  // The team score table. A place and a school and nothing else.
  team_score_line: '1 University of West Florida University of West Florida 1,239',
};

const run = python(HARNESS, JSON.stringify(LINES));
if (!run || run.status !== 0) {
  console.error('python harness failed');
  console.error(run?.stdout ?? '');
  console.error(run?.stderr ?? '');
  process.exit(1);
}
const out = JSON.parse(run.stdout.trim().split('\n').pop());

// --- (a) The bug: an abbreviated school column is still a school -------------
assert.deepEqual(
  out.split.glvc_code_school,
  ['UNKNOWN', '52 Drew E Baker', 'SBU 2:00.60'],
  'a yearless row splits on its team code when the PDF never spells the school out'
);
assert.equal(
  out.split.glvc_code_school[0],
  'UNKNOWN',
  'the class year is never guessed — the PDF does not carry one'
);
assert.deepEqual(
  out.split.glvc_two_letter_code,
  ['UNKNOWN', '28 Santi Leiva', 'QU 59.20'],
  'a two-letter code is a school; the team cache drops anything under three characters'
);
assert.deepEqual(
  out.split.glvc_cut_tag_tail,
  ['UNKNOWN', '10 Santi Leiva', 'QU 20.31 B'],
  'the cut tag after the clock is not a school, and does not stop the row splitting'
);

// --- A row keeps its own clock, never the next column's ----------------------
assert.deepEqual(
  out.split.glvc_two_columns,
  ['UNKNOWN', '41 Eliana Barone', 'SBU 1:18.26'],
  'a recovered row is cut where the next result column starts on the same line'
);
assert.ok(
  !String(out.split.glvc_two_columns[2]).includes('55.88'),
  "55.88 is another swimmer's time in another event; carrying it in fabricates a result"
);

// --- (b) A relay entry row is not a lost individual result -------------------
for (const key of ['glvc_relay_entry', 'glvc_relay_entry_two_letter', 'glvc_relay_entry_ampersand']) {
  assert.equal(out.relay[key], true, `${key}: "<place> <TEAM> <A|B> <clock>" is a relay entry`);
  assert.equal(
    out.lost[key],
    false,
    `${key}: the team code and the squad letter are not two name words`
  );
  assert.equal(out.split[key], null, `${key}: a relay squad is never recovered as a swimmer`);
}

// --- The common case must not move -------------------------------------------
assert.deepEqual(
  out.split.nsisc_full_school,
  ['UNKNOWN', '9 Alessandro Giustolisi', 'Delta State University 50.70 49.73'],
  'a school the PDF spells out still splits on the team cache, unchanged'
);
assert.equal(out.relay.nsisc_full_school, false, 'a result row is not a relay entry row');
assert.equal(out.split.page_header, null, 'page furniture is not a result row');
assert.equal(out.lost.page_header, false, 'page furniture leads with a number but carries no clock');
assert.equal(out.split.team_score_line, null, 'the team score table is not a result row');
assert.equal(out.lost.team_score_line, false, 'team totals are not clocks');

// --- An unrecorded code is refused, not guessed ------------------------------
assert.equal(
  out.split.unrecorded_code,
  null,
  'a code that is not in the archived abbreviation table resolves to nothing'
);
assert.equal(
  out.lost.unrecorded_code,
  true,
  'and the row still raises, so the code gets added with a source rather than guessed'
);
assert.equal(out.code.ZZZ, null, 'no school is invented for an unrecorded code');

// --- The strict resolver, against the loose one it sits beside ----------------
assert.equal(out.code.SBU, 'Southwest Baptist University');
assert.equal(out.code.QU, 'Quincy University');
assert.equal(out.code['MS&T'], 'Missouri S&T');
assert.equal(out.code.Baker, null, 'a surname is not a school');
assert.equal(out.code.B, null, 'a relay squad letter is not a school');
assert.equal(
  out.code.Rock,
  null,
  'a title-case word is a name; a HyTek team code is printed in capitals'
);
// ROCK and LU below are fixtures for the *matching mechanism*, not claims about
// either school. Each asserts which resolver fires, so the expected value is
// whatever `teamAbbreviations.json` records — read the value from the table, do
// not pin it to a school by hand. Both were pinned to the wrong school until
// 2026-09-01: ROCK to the University of Indianapolis, which scores separately
// from Rockhurst in the same GLVC meet, and LU to Lindenwood, whose program was
// cut after 2023-2024. See the sourcing block in
// `packages/core/src/data/teamAliases.ts`.
assert.equal(out.code.ROCK, 'Rockhurst University', 'the same word in capitals is a code');
// `match_abbrev_team` accepts a code as a *suffix* of any word, which is why the
// pivot may not use it: it would split a row in the middle of a swimmer's name.
// "Manlu" ends in LU, so the loose matcher returns LU's school.
assert.equal(
  out.loose.Manlu,
  'Lewis University',
  'the loose matcher resolves a surname ending in a code — the reason for the strict one'
);
assert.equal(out.code.Manlu, null, 'the strict resolver requires the token to BE the code');

console.log('PASS  an abbreviated school column is a school, and a relay entry row is not a swimmer');
