/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Multi-athlete SwimCloud personal-bests paste parser (one block per swimmer,
 * separated by bare name lines). Test: npx tsx scripts/test_multi_profile_import.mjs
 */

import { Gender, HistoricalSwim, NcaaDivision } from '../types';
import {
  implausibleSwimRowWarning,
  parseSwimCloudPersonalBestsDetailed,
  splitMultiProfileBlocks,
  type RejectedSwimRow,
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
  /**
   * Rows the plausibility gate refused, across every block. Already rendered into
   * `warnings` one-per-row; exposed structured so a caller can count or group them.
   */
  rejected: RejectedSwimRow[];
};

/**
 * Split a multi-profile paste into per-athlete blocks and parse each block's rows with
 * {@link parseSwimCloudPersonalBestsDetailed}. Blocking is delegated to
 * {@link splitMultiProfileBlocks} so the parser and the format detector agree on where
 * one athlete ends and the next begins — two independent splitters is precisely how a
 * club line ends up owning another swimmer's times.
 *
 * Warns (never throws) on a name with zero parsed rows, on rows that appear before any
 * name line, and on each row the plausibility gate refused. A zero-row warning names the
 * header lines that were folded into that block, so an operator can see whether the block
 * was empty or whether the split landed in the wrong place.
 */
export function parseSwimCloudMultiProfile(
  text: string,
  opts: ParseMultiProfileOptions
): ParseMultiProfileResult {
  const warnings: string[] = [];
  const { blocks, orphanLines } = splitMultiProfileBlocks(text);
  if (orphanLines.length > 0) {
    warnings.push('Rows found before any swimmer name — ignored');
  }

  const athletes: MultiProfileAthlete[] = [];
  const rejected: RejectedSwimRow[] = [];
  for (const block of blocks) {
    const parsed = parseSwimCloudPersonalBestsDetailed(
      block.lines.join('\n'),
      block.name,
      opts.team,
      opts.gender,
      opts.division
    );
    // Report before the empty-block bail, or a block whose every row was
    // implausible would be reported as "nothing parsed" with no reason attached.
    rejected.push(...parsed.rejected);
    warnings.push(...parsed.rejected.map(implausibleSwimRowWarning));
    if (parsed.swims.length === 0) {
      const folded =
        block.absorbed.length > 0
          ? ` (header lines folded in: ${block.absorbed.map(l => `"${l}"`).join(', ')})`
          : '';
      warnings.push(`No swims parsed for "${block.name}"${folded}`);
      continue;
    }
    athletes.push({ name: block.name, swims: parsed.swims });
  }

  if (athletes.length === 0) {
    warnings.push('No athlete profiles parsed — check the paste includes name + Personal Bests rows');
  }

  return { athletes, warnings, rejected };
}
