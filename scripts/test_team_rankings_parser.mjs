/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HyTek "Team Rankings - Through Event N" parsing.
 *
 * pdfplumber splits HyTek's proportionally-spaced team totals at the decimal
 * point, so "1,029.50" reaches the parser as "1,029. 50". The original regex
 * found its leftmost match at that interior space and read the line as the
 * school "<name> 1,029." scoring 50 points. Every official total ending in a
 * half point was destroyed, and because the wreckage is stored under a
 * *different key* than the clean rows, nothing downstream could tell.
 *
 * Skips when Python is unavailable — the parser is Python and the runner is
 * Node. Absent ≠ passing: the skip line says so.
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
  console.log('SKIP  test_team_rankings_parser (python not available)');
  process.exit(0);
}

const HARNESS = `
import json, sys
sys.path.insert(0, 'backend')
from team_rankings_parser import extract_team_rankings_from_lines, _normalize_team_line

out = {}

# 1. The live NSISC shape: two teams whose totals pdfplumber split at the point.
out['split'] = extract_team_rankings_from_lines([
    'Team Rankings - Through Event 42',
    'Women - Team Scores',
    'Place School Points',
    '1 University of West Florida University of West Florida 1239',
    '2 Delta State University Delta State University 916',
    'Men - Team Scores',
    'Place School Points',
    '1 Henderson State University Henderson State University 1056',
    '2 Ouachita Baptist University Ouachita Baptist University 1,029. 50',
    '3 Delta State University Delta State University 875. 50',
])

# 2. The same totals when pdfplumber does NOT split them.
out['clean'] = _normalize_team_line(
    '2 Ouachita Baptist University Ouachita Baptist University 1,029.50'
)

# 3. A line the parser cannot split safely must raise, not store a guess.
try:
    _normalize_team_line('2 Cutoff University 12 34')
    out['raised'] = False
except ValueError as exc:
    out['raised'] = 'digits' in str(exc)

print(json.dumps(out))
`;

const run = python(HARNESS);
assert.equal(run.status, 0, `harness failed:\n${run.stdout}\n${run.stderr}`);
const out = JSON.parse(run.stdout.trim().split('\n').pop());

// --- 1. half-point totals survive the split -------------------------------
const men = out.split.men;
assert.equal(
  men['Ouachita Baptist University Ouachita Baptist University'],
  1029.5,
  'a total split as "1,029. 50" must parse as 1029.5'
);
assert.equal(
  men['Delta State University Delta State University'],
  875.5,
  'a total split as "875. 50" must parse as 875.5'
);
assert.equal(men['Henderson State University Henderson State University'], 1056);
assert.equal(out.split.eventThrough, 42);

// No key may carry digits: that is the signature of the split landing inside
// the number, and it is what made the corruption invisible.
for (const [gender, block] of Object.entries({ men, women: out.split.women })) {
  for (const school of Object.keys(block)) {
    assert.ok(
      !/\d/.test(school),
      `${gender} school key contains digits (split landed inside the score): ${school}`
    );
  }
}

// --- 2. the unsplit form still parses -------------------------------------
assert.deepEqual(out.clean, [
  2,
  'Ouachita Baptist University Ouachita Baptist University',
  1029.5,
]);

// --- 3. an unsplittable line fails loudly ---------------------------------
assert.equal(
  out.raised,
  true,
  'a line whose school name would carry digits must raise, not store a wrong total'
);

console.log('test_team_rankings_parser OK');
