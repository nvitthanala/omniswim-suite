/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Multi-athlete SwimCloud personal-bests paste parser (one block per swimmer,
 * separated by bare name lines). Test: npx tsx scripts/test_multi_profile_import.mjs
 */

import { Gender, HistoricalSwim, NcaaDivision } from '../types';
import {
  isProfileNameLine,
  parseSwimCloudPersonalBests,
} from './athleteHistory';

export type ParseMultiProfileOptions = {
  team: string;
  gender: Gender;
  division?: NcaaDivision;
};

export type MultiProfileAthlete = {
  /** Name exactly as pasted (diacritics preserved). */
  name: string;
  swims: HistoricalSwim[];
};

export type ParseMultiProfileResult = {
  athletes: MultiProfileAthlete[];
  warnings: string[];
};

type RawBlock = { name: string; lines: string[] };

/**
 * Split a multi-profile paste into per-athlete blocks and parse each block's rows with
 * {@link parseSwimCloudPersonalBests}. Blocks are delimited by bare name lines; header/junk
 * and blank lines are ignored. Warns (never throws) on a name with zero parsed rows and on
 * rows that appear before any name line.
 */
export function parseSwimCloudMultiProfile(
  text: string,
  opts: ParseMultiProfileOptions
): ParseMultiProfileResult {
  const warnings: string[] = [];
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  let warnedOrphanRows = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    if (isProfileNameLine(t)) {
      if (current) blocks.push(current);
      current = { name: t, lines: [] };
      continue;
    }
    if (!current) {
      if (!warnedOrphanRows) {
        warnings.push('Rows found before any swimmer name — ignored');
        warnedOrphanRows = true;
      }
      continue;
    }
    current.lines.push(rawLine);
  }
  if (current) blocks.push(current);

  const athletes: MultiProfileAthlete[] = [];
  for (const block of blocks) {
    const swims = parseSwimCloudPersonalBests(
      block.lines.join('\n'),
      block.name,
      opts.team,
      opts.gender,
      opts.division
    );
    if (swims.length === 0) {
      warnings.push(`No swims parsed for "${block.name}"`);
      continue;
    }
    athletes.push({ name: block.name, swims });
  }

  if (athletes.length === 0) {
    warnings.push('No athlete profiles parsed — check the paste includes name + Personal Bests rows');
  }

  return { athletes, warnings };
}
