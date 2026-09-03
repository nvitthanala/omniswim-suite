/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Python PDF parser reads teamAbbreviations.json while TypeScript consumers
 * read TEAM_ABBREVIATIONS. These hand-maintained copies must never drift.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = join(repoRoot, 'packages/core/src/data/teamAbbreviations.json');
const tsPath = join(repoRoot, 'packages/core/src/data/teamAliases.ts');

const jsonTable = JSON.parse(readFileSync(jsonPath, 'utf8'));
const source = readFileSync(tsPath, 'utf8');
const block = source.match(/export const TEAM_ABBREVIATIONS:[^=]+?=\s*\{([\s\S]*?)\n\};/);
assert.ok(block, 'could not find TEAM_ABBREVIATIONS object in teamAliases.ts');

const tsTable = Object.fromEntries(
  [...block[1].matchAll(/^\s*(?:'([^']+)'|([A-Z][A-Z0-9&]*)):\s*'([^']+)',/gm)].map(
    ([, quotedKey, bareKey, value]) => [quotedKey ?? bareKey, value]
  )
);

const jsonKeys = new Set(Object.keys(jsonTable));
const tsKeys = new Set(Object.keys(tsTable));
const onlyJson = [...jsonKeys].filter(key => !tsKeys.has(key)).sort();
const onlyTs = [...tsKeys].filter(key => !jsonKeys.has(key)).sort();
const changed = [...jsonKeys]
  .filter(key => tsKeys.has(key) && jsonTable[key] !== tsTable[key])
  .sort()
  .map(key => `${key}: JSON=${JSON.stringify(jsonTable[key])}, TS=${JSON.stringify(tsTable[key])}`);

if (onlyJson.length || onlyTs.length || changed.length) {
  const lines = ['team abbreviation tables diverged:'];
  if (onlyJson.length) lines.push(`only in teamAbbreviations.json: ${onlyJson.join(', ')}`);
  if (onlyTs.length) lines.push(`only in teamAliases.ts: ${onlyTs.join(', ')}`);
  if (changed.length) lines.push(`different values: ${changed.join('; ')}`);
  throw new Error(lines.join('\n'));
}

console.log(`PASS  team abbreviation tables match (${jsonKeys.size} key/value pairs)`);
