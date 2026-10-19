/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Roster text for tests: the real local export when this machine holds it,
 * the committed invented stand-in otherwise.
 *
 * The real exports name real swimmers. They are gitignored and live in
 * `data/local-rosters/` (path set in `scripts/lib/localRosters.mjs`). A clean
 * checkout and CI do not have them. The stand-ins in
 * `tests/fixtures/synthetic-rosters/` use the same file names and the same
 * line format with invented names, so the same test body runs on both.
 *
 * `source` tells a test which one it got. A test keeps its exact real-data
 * assertions for `'real'` and uses the stand-in's own expectations for
 * `'synthetic'`. A test never skips for a missing file.
 */
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error -- plain .mjs shared with the seed scripts, deliberately untyped.
import { SYNTHETIC_ROSTER_DIR, hasLocalRoster, localRosterPath } from '../../scripts/lib/localRosters.mjs';

export type RosterSource = 'real' | 'synthetic';

export interface RosterText {
  fileName: string;
  source: RosterSource;
  text: string;
  /** `text` split on LF or CRLF. */
  lines: string[];
}

const syntheticPath = (fileName: string): string => `${SYNTHETIC_ROSTER_DIR as string}/${fileName}`;

/** Read a roster file by name. Real when present, else the stand-in. Throws when neither exists. */
export function readRosterText(fileName: string): RosterText {
  const real = (hasLocalRoster as (n: string) => boolean)(fileName);
  const path = real ? (localRosterPath as (n: string) => string)(fileName) : syntheticPath(fileName);
  if (!existsSync(path)) {
    throw new Error(`No roster stand-in for ${fileName}: expected ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  return { fileName, source: real ? 'real' : 'synthetic', text, lines: text.split(/\r?\n/) };
}

/**
 * One swimmer's block: the header line, then every line up to the next blank
 * line. Throws when the header is missing or appears twice.
 */
export function rosterBlock(roster: RosterText, header: string): string[] {
  const first = roster.lines.indexOf(header);
  if (first < 0) throw new Error(`${roster.fileName} (${roster.source}) has no block headed "${header}"`);
  if (roster.lines.lastIndexOf(header) !== first) {
    throw new Error(`${roster.fileName} (${roster.source}) has two blocks headed "${header}"`);
  }
  let end = first;
  while (end < roster.lines.length && roster.lines[end] !== '') end++;
  return roster.lines.slice(first, end);
}
