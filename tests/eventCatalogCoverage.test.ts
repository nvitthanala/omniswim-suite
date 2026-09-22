/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Anything the app can convert, a coach must be able to enter.
 *
 * ## The drift this catches
 *
 * `CONVERSION_FACTORS` knew `800 Freestyle` and `1500 Freestyle`.
 * `INDIVIDUAL_EVENTS` — the list behind every event dropdown in Manager — had
 * neither. So the app could convert a time it gave no way to enter, and a coach
 * planning a long-course meet could not pick either of the two signature
 * distance events.
 *
 * Nothing failed. Both lists were internally consistent, every test passed, and
 * the gap only showed up by reading the two side by side. That is the shape of
 * defect this file exists for: two tables that must agree, kept in separate
 * files, with nothing asserting the agreement.
 *
 * The list is deliberately both courses at once — 500/1000/1650 are yards,
 * 400/800/1500 are metres — because a coach plans in whichever course the meet
 * is contested in, and the catalogue does not know the meet.
 */

import { describe, expect, it } from 'vitest';
import { CONVERSION_FACTORS } from '../packages/core/src/constants';
import { ALL_PLAN_EVENTS, INDIVIDUAL_EVENTS } from '../packages/core/src/lib/eventCatalog';
import { normalizeEventLabel } from '../packages/core/src/lib/athleteHistory';

const plannable = new Set(ALL_PLAN_EVENTS.map((e) => normalizeEventLabel(e)));

describe('every convertible event is also plannable', () => {
  it('leaves no event in the conversion table that cannot be entered', () => {
    const missing = Object.keys(CONVERSION_FACTORS).filter(
      (event) => !plannable.has(normalizeEventLabel(event)),
    );
    expect(missing).toStrictEqual([]);
  });

  it('includes the long-course distance events specifically', () => {
    // Named rather than left to the loop above, because these two are the ones
    // that were missing and the loop would go quiet again if someone removed
    // them from BOTH tables at once.
    expect(INDIVIDUAL_EVENTS).toContain('800 Freestyle');
    expect(INDIVIDUAL_EVENTS).toContain('1500 Freestyle');
  });

  it('keeps the short-course distance events too', () => {
    // The control: adding metres events must not have displaced the yards
    // ones, which are what every NCAA dual and championship meet is swum in.
    for (const event of ['500 Freestyle', '1000 Freestyle', '1650 Freestyle']) {
      expect(INDIVIDUAL_EVENTS, event).toContain(event);
    }
  });

  it('lists the freestyle distances in ascending order', () => {
    // The list is rendered straight into a dropdown, so its order is what a
    // coach scrolls. A 1500 sitting between 100 and 200 is a usability bug
    // rather than a correctness one, which is exactly the kind that survives.
    const distances = INDIVIDUAL_EVENTS.filter((e) => e.endsWith(' Freestyle')).map((e) =>
      Number(e.split(' ')[0]),
    );
    expect(distances).toStrictEqual([...distances].sort((a, b) => a - b));
  });

  it('has no duplicates', () => {
    expect(new Set(INDIVIDUAL_EVENTS).size).toBe(INDIVIDUAL_EVENTS.length);
    expect(new Set(ALL_PLAN_EVENTS).size).toBe(ALL_PLAN_EVENTS.length);
  });
});
