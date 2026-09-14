/** @license SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const harness = `
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
const run = spawnSync('python', ['-c', harness], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(run.status, 0, `python harness failed:\n${run.stderr}`);
assert.equal(run.stdout.trim(), 'raised');
console.log('PASS  missing PDF abbreviation table raises instead of using fallback teams');
