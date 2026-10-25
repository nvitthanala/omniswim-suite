/** @license SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function python(harness, args = []) {
  const run = spawnSync('python', ['-I', '-c', harness, ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, `python harness failed:\n${run.stderr}`);
  return run.stdout.trim();
}

// 1. A missing table raises. It does not fall back to a short list of teams.
const missing = `
import sys
sys.path.insert(0, 'backend')
import pdf_parser
pdf_parser._ALIASES_JSON = 'does-not-exist-team-abbreviations.json'
try:
    pdf_parser._load_abbrev_teams()
except OSError:
    print('raised')
else:
    raise AssertionError('missing abbreviation table silently fell back')
`;
assert.equal(python(missing), 'raised');
console.log('PASS  missing PDF abbreviation table raises instead of using fallback teams');

// 2. A table without HSU does not get HSU back. The old setdefault fallbacks
//    (UMSL, HSU, DSU, OUAC, UWF) made a deleted row look present.
const dir = mkdtempSync(join(tmpdir(), 'omni-abbrev-'));
try {
  const tablePath = join(dir, 'table.json');
  writeFileSync(tablePath, JSON.stringify({ SBU: 'Southwest Baptist University' }));
  const withoutFallbacks = `
import sys
sys.path.insert(0, 'backend')
import pdf_parser
pdf_parser._ALIASES_JSON = sys.argv[1]
table = pdf_parser._load_abbrev_teams()
for code in ('UMSL', 'HSU', 'DSU', 'OUAC', 'UWF'):
    assert code not in table, code + ' came back from a fallback'
assert table.get('HSU') is None
assert table['SBU'] == 'Southwest Baptist University'
try:
    table['HSU']
except KeyError as err:
    print(str(err))
else:
    raise AssertionError('an unknown abbreviation did not raise')
`;
  const message = python(withoutFallbacks, [tablePath]);
  assert.match(message, /Unknown team abbreviation 'HSU'/, 'the error must name the abbreviation');
  assert.match(message, /table\.json|teamAbbreviations\.json/, 'the error must name the table');
  console.log('PASS  an unknown abbreviation raises and names the abbreviation; no fallback restores HSU');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 3. The five codes the fallbacks held are in the real table, so they still resolve.
const realTable = `
import sys
sys.path.insert(0, 'backend')
import pdf_parser
expected = {
    'UMSL': 'University of Missouri-St. Louis',
    'HSU': 'Henderson State University',
    'DSU': 'Delta State University',
    'OUAC': 'Ouachita Baptist University',
    'UWF': 'University of West Florida',
}
for code, name in expected.items():
    assert pdf_parser.ABBREV_TEAMS[code] == name, code
    assert pdf_parser._resolve_team_code(code) == name, code
assert pdf_parser._resolve_team_code('NOTACODE') is None
print('resolved')
`;
assert.equal(python(realTable), 'resolved');
console.log('PASS  UMSL, HSU, DSU, OUAC and UWF resolve from the archived table');

// 4. A refused result row names the code the table lacks, and stays quiet about a recorded one.
const refusal = `
import sys
sys.path.insert(0, 'backend')
import pdf_parser
note = pdf_parser._unrecorded_team_code_note('52 Drew E Baker ZZQ 2:00.60')
assert "'ZZQ'" in note and 'teamAbbreviations.json' in note, note
assert pdf_parser._unrecorded_team_code_note('52 Drew E Baker UWF 2:00.60') == ''
assert pdf_parser._unrecorded_team_code_note('52 Drew E Baker 2:00.60') == ''
print('named')
`;
assert.equal(python(refusal), 'named');
console.log('PASS  a refused row names the team code the abbreviation table lacks');
