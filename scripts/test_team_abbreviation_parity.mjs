/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * teamAbbreviations.json (what backend/pdf_parser.py loads) and
 * TEAM_ABBREVIATIONS in teamAliases.ts (the hand-maintained TypeScript twin)
 * are duplicated by hand with nothing else enforcing they match. They already
 * drifted once — see docs/reference/AUDIT_2026-09-02.md and the fix in
 * commit 07fb5ae5 — so this pins them to each other going forward.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TEAM_ABBREVIATIONS } from '../packages/core/src/data/teamAliases.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(
  __dirname,
  '..',
  'packages',
  'core',
  'src',
  'data',
  'teamAbbreviations.json'
);
const fromJson = JSON.parse(readFileSync(jsonPath, 'utf-8'));

const jsonKeys = new Set(Object.keys(fromJson));
const tsKeys = new Set(Object.keys(TEAM_ABBREVIATIONS));

const onlyInJson = [...jsonKeys].filter(k => !tsKeys.has(k)).sort();
const onlyInTs = [...tsKeys].filter(k => !jsonKeys.has(k)).sort();
const valueMismatches = [...jsonKeys]
  .filter(k => tsKeys.has(k) && fromJson[k] !== TEAM_ABBREVIATIONS[k])
  .sort()
  .map(k => `${k}: json=${JSON.stringify(fromJson[k])} ts=${JSON.stringify(TEAM_ABBREVIATIONS[k])}`);

if (onlyInJson.length || onlyInTs.length || valueMismatches.length) {
  console.error('FAIL teamAbbreviations.json and teamAliases.ts have drifted apart:');
  if (onlyInJson.length) console.error(`  keys only in teamAbbreviations.json: ${onlyInJson.join(', ')}`);
  if (onlyInTs.length) console.error(`  keys only in teamAliases.ts: ${onlyInTs.join(', ')}`);
  for (const line of valueMismatches) console.error(`  value mismatch — ${line}`);
  process.exit(1);
}

console.log(`OK teamAbbreviations.json and teamAliases.ts match (${jsonKeys.size} entries)`);
