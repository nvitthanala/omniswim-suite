/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Words for a team whose prelims or psych projection has seeds past the end of
 * the place-point table.
 *
 * Core carries these as `ProjectedTeamScore.expected: null` and
 * `withoutExpectationCount` (see `@omniswim/core/types`). A seed the table has
 * no row for has no expectation: it is not 0 points. These helpers only word
 * the count. They compute no points.
 */

/** "3 seeds past table" / "1 seed past table". */
export function seedsPastTableLabel(count: number): string {
  return count === 1 ? '1 seed past table' : `${count} seeds past table`;
}

/**
 * The text shown where the expected figure would be, when no seed of the team
 * has an expectation: "— (3 seeds past table)".
 */
export function noExpectationText(count: number): string {
  return `— (${seedsPastTableLabel(count)})`;
}
