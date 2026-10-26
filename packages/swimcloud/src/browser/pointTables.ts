/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud's point tables, as the simulator's own bundle defines them (`_p` in
 * `media/webpack/simulator/index.1792676876.js`, offset about 497693; the excerpt
 * `data/swimcloud-captures/simulator/bundle-constants-excerpt.txt`, sha256 090d398e...bbc2a7c, quotes it).
 * The keys are the page's `pointSystem` values. A relay table is its own list: college relay
 * 11-4-2 is not twice the individual 9-4-3-2-1.
 *
 * These are values read from a third-party tool, not published competition standards. They are never
 * `published` provenance. `tests/swimcloudSimulatorAdapter.test.ts` compares every table to the
 * verbatim bundle text and, for `college` and `scoring16`, to the points the page recorded in the
 * parity fixtures. A `pointSystem` that is not a key here has no table: the preset leaves the points
 * `pending` and nothing falls back to another table (the 3 Day Championship preset names `scoring32`,
 * which the bundle never defines, recon Q13).
 */
export interface SimulatorPointTable {
  readonly title: string;
  readonly individual: readonly number[];
  readonly relay: readonly number[];
}

export const SIMULATOR_POINT_TABLES: Readonly<Record<string, SimulatorPointTable>> = {
  college: { title: 'College', individual: [9, 4, 3, 2, 1], relay: [11, 4, 2] },
  school4: { title: 'High School - 4 lane scoring', individual: [4, 3, 1], relay: [6, 3, 1] },
  school6: { title: 'High School - 6 lane scoring', individual: [6, 4, 3, 2, 1], relay: [8, 4, 2] },
  school8: { title: 'High School - 8 lane scoring', individual: [8, 6, 5, 4, 3, 2, 1], relay: [10, 5, 3] },
  scoring12: {
    title: 'Sectional and State Final',
    individual: [16, 13, 12, 11, 10, 9, 7, 5, 4, 3, 2, 1],
    relay: [32, 26, 24, 22, 20, 18, 14, 10, 8, 6, 4, 2],
  },
  scoring16: {
    title: '16 Place Scoring',
    individual: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    relay: [40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2],
  },
  scoring24: {
    title: '24 Place Scoring',
    individual: [32, 28, 27, 26, 25, 24, 23, 22, 20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    relay: [64, 56, 54, 52, 50, 48, 46, 44, 40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2],
  },
};

/** The table for a `pointSystem`, or `undefined`. Never a fallback. */
export function simulatorPointTable(pointSystem: string): SimulatorPointTable | undefined {
  return Object.hasOwn(SIMULATOR_POINT_TABLES, pointSystem) ? SIMULATOR_POINT_TABLES[pointSystem] : undefined;
}
