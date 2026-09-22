/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A championship relay table is the individual table doubled. A dual one is not.
 *
 * ## Why this file exists
 *
 * Six championship field sizes (6, 8, 12, 16, 18, 24) each carry an individual
 * and a relay point table, and every relay table is exactly twice its
 * individual table, place for place. That is not a coincidence to be re-typed
 * per preset — it is how NCAA Rule 7 defines relay scoring.
 *
 * Nothing asserted it. Each preset's numbers were checked individually, so a
 * single mistyped relay value — 16 where 18 belongs — would have passed every
 * test while silently mis-scoring a relay. Relays are the double-weighted
 * events, so an error there moves a team total twice as far as the same error
 * in an individual event, and a plausible-but-wrong team score is the failure
 * this repo is built to refuse.
 *
 * ## The control matters as much as the rule
 *
 * Dual meets are deliberately **not** doubled: 9-4-3-2-1 individual against
 * 11-4-2 relay, and 11 is not twice 9. A test that only checked "relays are
 * doubled" would invite someone to "fix" the dual tables into consistency and
 * silently break every dual meet in the app. Both halves are asserted here, in
 * the same file, so the exception is impossible to miss.
 *
 * Every number is read out of `NCAA_FORMAT_RULESETS` rather than copied, so
 * this asserts the relationship between the tables and not a snapshot of them.
 */

import { describe, expect, it } from 'vitest';
import {
  NCAA_CHAMPIONSHIP_FIELD_SIZES,
  NCAA_FORMAT_RULESETS,
  isNcaaHostPublishedTable,
  ncaaChampionshipFormatForFieldSize,
} from '../packages/core/src/lib/ncaaScoringRules';
import type { NcaaPointTable, NcaaTableSlot } from '../packages/core/src/lib/ncaaScoringRules';

/** A slot's places, or `undefined` when the host publishes the table instead. */
function placesOf(slot: NcaaTableSlot | undefined): readonly number[] | undefined {
  if (slot === undefined || isNcaaHostPublishedTable(slot)) return undefined;
  return (slot as NcaaPointTable).places;
}

describe('championship relay tables are the individual table doubled', () => {
  it.each([...NCAA_CHAMPIONSHIP_FIELD_SIZES])('field size %i', (size) => {
    const ruleset = NCAA_FORMAT_RULESETS[ncaaChampionshipFormatForFieldSize(size)];
    const individual = placesOf(ruleset.individual);
    const relay = placesOf(ruleset.relay);

    // Both must be real tables. A championship format that quietly became
    // host-published would make the assertion below vacuous.
    expect(individual, `field ${size} has no individual table`).toBeDefined();
    expect(relay, `field ${size} has no relay table`).toBeDefined();

    expect(relay).toStrictEqual((individual ?? []).map((points) => points * 2));
  });

  it('covers every championship field size the module declares', () => {
    // Guards the loop above from going quiet if a field size is dropped from
    // the list: six tables checked, not "however many happen to be listed".
    expect(NCAA_CHAMPIONSHIP_FIELD_SIZES).toStrictEqual([6, 8, 12, 16, 18, 24]);
  });

  it('gives each field size its own distinct table', () => {
    // Two field sizes sharing a table would pass the doubling check while
    // scoring one of them against the wrong depth.
    const seen = new Map<string, number>();
    for (const size of NCAA_CHAMPIONSHIP_FIELD_SIZES) {
      const ruleset = NCAA_FORMAT_RULESETS[ncaaChampionshipFormatForFieldSize(size)];
      const key = JSON.stringify(placesOf(ruleset.individual));
      expect(seen.has(key), `field ${size} reuses the table of field ${seen.get(key)}`).toBe(false);
      seen.set(key, size);
    }
  });
});

describe('dual meet tables are deliberately not doubled', () => {
  // double-dual-tri-quad was added on 2026-09-22 after a mutation test came
  // back inert: "fixing" its relay table into 2x consistency passed every
  // assertion here, because no test looked at it. An inert mutation is not
  // evidence of a guard, it is evidence of a gap.
  it.each([
    ['dual-six-lanes-or-more', [9, 4, 3, 2, 1, 0], [11, 4, 2, 0]],
    ['dual-five-lanes-or-fewer', [5, 3, 1, 0], [7, 0]],
    ['double-dual-tri-quad', [9, 4, 3, 2, 1], [11, 4, 2]],
  ] as const)('%s', (format, individual, relay) => {
    const ruleset = NCAA_FORMAT_RULESETS[format];
    expect(placesOf(ruleset.individual)).toStrictEqual(individual);
    expect(placesOf(ruleset.relay)).toStrictEqual(relay);

    // The point of the control: 11 is not twice 9, and 7 is not twice 5.
    // Anyone "fixing" a dual table into consistency with the championship rule
    // breaks every dual meet in the app, and fails here instead.
    expect(placesOf(ruleset.relay)).not.toStrictEqual(individual.map((p) => p * 2));
  });

  it('keeps each table exactly as its own citation prints it', () => {
    // dual-six-lanes-or-more prints "11-4-2-0" and double-dual-tri-quad prints
    // "11-4-2". The trailing zero differs between them, and that is faithful to
    // Rule 7-1-1 and Rule 7-2 respectively rather than an inconsistency. Pinned
    // so nobody tidies one into the other.
    expect(placesOf(NCAA_FORMAT_RULESETS['dual-six-lanes-or-more'].relay)).toStrictEqual([11, 4, 2, 0]);
    expect(placesOf(NCAA_FORMAT_RULESETS['double-dual-tri-quad'].relay)).toStrictEqual([11, 4, 2]);
  });

  it('scores a dual relay first place at 11, not 18', () => {
    // Named explicitly because it is the number a coach would notice, and
    // because 18 is what the championship-24 rule would produce for the same
    // swim. Getting this wrong moves a dual meet result by seven points on one
    // relay.
    expect(placesOf(NCAA_FORMAT_RULESETS['dual-six-lanes-or-more'].relay)?.[0]).toBe(11);
  });
});
