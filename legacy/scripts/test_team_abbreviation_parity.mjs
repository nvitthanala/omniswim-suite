/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/core/src/data/teamAbbreviations.json` is the single source for team
 * abbreviations. `TEAM_ABBREVIATIONS` (teamAliases.ts) imports it and
 * `backend/pdf_parser.py` loads it. They drifted once when the TypeScript side
 * was a hand-typed copy — see docs/reference/AUDIT_2026-09-02.md and the fix in
 * commit 07fb5ae5.
 *
 * This test fails when either consumer stops matching the JSON:
 *   - a hand-typed literal returns to teamAliases.ts and is edited, or
 *   - `_load_abbrev_teams` in pdf_parser.py adds a code the JSON lacks (it had
 *     hard-coded `setdefault` fallbacks that hid a deleted row; they are gone,
 *     and `test_pdf_abbreviation_table_required.mjs` pins that).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TEAM_ABBREVIATIONS } from '../../packages/core/src/data/teamAliases.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const jsonPath = path.join(repoRoot, 'packages', 'core', 'src', 'data', 'teamAbbreviations.json');
const fromJson = JSON.parse(readFileSync(jsonPath, 'utf-8'));

assert.ok(Object.keys(fromJson).length > 0, 'teamAbbreviations.json is empty');

// TypeScript side: same keys, same values, same order.
assert.deepEqual(
  Object.entries(TEAM_ABBREVIATIONS),
  Object.entries(fromJson),
  'TEAM_ABBREVIATIONS (teamAliases.ts) differs from teamAbbreviations.json'
);

// Python side: ABBREV_TEAMS must hold exactly the JSON entries.
const harness = `
import json, sys
sys.path.insert(0, 'legacy/backend')
import pdf_parser
print(json.dumps(pdf_parser.ABBREV_TEAMS, sort_keys=True))
`;
const run = spawnSync('python', ['-I', '-c', harness], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(run.status, 0, `python harness failed:\n${run.stderr}`);
const fromPython = JSON.parse(run.stdout);
const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
assert.deepEqual(
  sorted(fromPython),
  sorted(fromJson),
  'pdf_parser.ABBREV_TEAMS differs from teamAbbreviations.json (a hard-coded code in _load_abbrev_teams?)'
);

console.log(
  `OK teamAbbreviations.json, teamAliases.ts and pdf_parser.py agree (${Object.keys(fromJson).length} entries)`
);
