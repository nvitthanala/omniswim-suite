/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConversionFactors } from './types';

/**
 * Course-conversion factors (SCY ↔ LCM/SCM). Researched 2026-09-13, per
 * `plans/2026-08-14/02-data-quality-aliasing.md` §1's open question: **no
 * governing body publishes a directly citable, archivable primary source
 * for these values.** USA Swimming's Times & Recognition Policy Manual
 * covers when a converted time is (and is not) recognized, but does not
 * itself publish a factor table; the NCAA does not publish its own set for
 * championship seeding. The factors in circulation (this table included)
 * trace to Colorado Time Systems' internal conversion methodology, embedded
 * in timing software and reproduced by third-party calculators — not a
 * standalone published document with a URL/sha256 to archive the way
 * `data/cutlines/sources/` does for cut standards.
 *
 * This table is therefore **indicative, not official**, per this repo's own
 * `converted_estimate` cutline-tag state (`cutlineTags.ts`), which already
 * treats any conversion-derived cut comparison as visibly non-authoritative
 * rather than a real cut — the code-level consequence of the same finding.
 * Do not present a value derived from this table as an official time.
 */
export const CONVERSION_FACTORS: ConversionFactors = {
  '50 Freestyle': { men_lcm: 0.87, women_lcm: 0.881, both_scm: 0.906 },
  '100 Freestyle': { men_lcm: 0.873, women_lcm: 0.884, both_scm: 0.906 },
  '200 Freestyle': { men_lcm: 0.875, women_lcm: 0.884, both_scm: 0.906 },
  '400 Freestyle': { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  '500 Freestyle': { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  '800 Freestyle': { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  '1000 Freestyle': { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  '1500 Freestyle': { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  '1650 Freestyle': { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  '100 Backstroke': { men_lcm: 0.845, women_lcm: 0.863, both_scm: 0.906 },
  '200 Backstroke': { men_lcm: 0.859, women_lcm: 0.867, both_scm: 0.906 },
  '100 Breaststroke': { men_lcm: 0.866, women_lcm: 0.88, both_scm: 0.906 },
  '200 Breaststroke': { men_lcm: 0.868, women_lcm: 0.888, both_scm: 0.906 },
  '100 Butterfly': { men_lcm: 0.878, women_lcm: 0.887, both_scm: 0.906 },
  '200 Butterfly': { men_lcm: 0.876, women_lcm: 0.891, both_scm: 0.906 },
  // Keyed under the canonical label produced by `normalizeEventLabel` ("200 IM"
  // normalizes to "200 Individual Medley"). Both spellings are listed because
  // callers reach this table with either: keying only the abbreviation is what
  // made every IM conversion miss the table and silently fall back to the 50
  // Freestyle factor.
  '200 IM': { men_lcm: 0.867, women_lcm: 0.877, both_scm: 0.906 },
  '400 IM': { men_lcm: 0.875, women_lcm: 0.886, both_scm: 0.906 },
  '200 Individual Medley': { men_lcm: 0.867, women_lcm: 0.877, both_scm: 0.906 },
  '400 Individual Medley': { men_lcm: 0.875, women_lcm: 0.886, both_scm: 0.906 },
};

export const SCORING_POINTS = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

export const NEON_COLORS = [
  '#00F5FF', // Neon Cyan
  '#FF00FF', // Neon Magenta
  '#39FF14', // Neon Lime
  '#FFD700', // Gold
  '#FF4444', // Neon Red
  '#8A2BE2', // Neon Violet
  '#FF8C00', // Neon Orange
  '#7FFF00', // Chartreuse
];

export const TEAM_COLORS_MAP: Record<string, string> = {
  'Henderson State University': '#FF4444',
  'Ouachita Baptist University': '#8A2BE2',
  'Delta State University': '#39FF14',
  'Oklahoma Baptist University': '#00F5FF',
};


