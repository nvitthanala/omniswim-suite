/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Zod 3 -> 4 compatibility pins (improvement plan R9 step 3).
 *
 * Zod 4 changed what a handful of builders accept. The schemas keep the Zod 3
 * accept/reject behaviour with small shims, and none of them is visible in the
 * rest of the suite. Each case below names the shim it guards.
 *
 * Mutation map (revert the shim, the named case turns red):
 *  - `numberAllowingInfinity` -> z.number()           -> "createdAt of Infinity"
 *  - `wholeNumber()` -> z.number().int()              -> "a whole number past 2^53"
 *  - `maxUnits(...)` -> z.string().max(...)           -> "label length in UTF-16 units"
 *  - `json: z.unknown().optional()` -> z.unknown()    -> "rosterBulkImportSchema without json"
 *  - `error:` fn in storedPlaceTableSchema removed    -> the two message cases
 *  - `error:` fn in pointsTableSchema removed         -> "pointsTableSchema names a non-finite value"
 */
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceSchema,
  rosterBulkImportSchema,
} from '../packages/core/src/schemas/workspace';
import { pointsTableSchema, storedPlaceTableSchema } from '../packages/core/src/lib/scoringPlaceTables';
import { scoringPresetWriteSchema } from '../apps/shell/lib/routes/scoringPresetRoutes';

const SETTINGS = {
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: false,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 2,
};
const preset = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
  id: 'zod-compat',
  label: 'Zod compat',
  settings: { ...SETTINGS, ...settings },
  ...over,
});

describe('workspace create: createdAt', () => {
  it('createdAt of Infinity (from a body of 1e999) is accepted, as under Zod 3', () => {
    const body = JSON.parse('{"createdAt":1e999,"name":"w"}');
    expect(body.createdAt).toBe(Infinity);
    expect(createWorkspaceSchema.safeParse(body).success).toBe(true);
  });

  it('createdAt of NaN, a string and null are refused', () => {
    for (const createdAt of [Number.NaN, '5', null]) {
      expect(createWorkspaceSchema.safeParse({ createdAt }).success).toBe(false);
    }
  });
});

describe('scoring preset: whole numbers and label length', () => {
  const parse = (value: unknown) => scoringPresetWriteSchema.safeParse(value);

  it('a whole number past 2^53 is accepted and a fraction is refused', () => {
    expect(parse(preset({}, { maxTotalEntriesPerSwimmer: 1e20 })).success).toBe(true);
    expect(parse(preset({}, { maxTotalEntriesPerSwimmer: 1.5 })).success).toBe(false);
    expect(parse(preset({}, { aFinalBracketSize: 0 })).success).toBe(false);
    expect(parse(preset({}, { maxTotalEntriesPerSwimmer: Infinity })).success).toBe(false);
  });

  it('a non-finite multiplier is refused', () => {
    expect(parse(preset({}, { relayMultiplier: Infinity })).success).toBe(false);
    expect(parse(preset({}, { relayMultiplier: Number.NaN })).success).toBe(false);
  });

  it('label length is counted in UTF-16 units: 60 emoji pass, 61 do not', () => {
    expect(parse(preset({ label: '\u{1F600}'.repeat(60) })).success).toBe(true);
    expect(parse(preset({ label: '\u{1F600}'.repeat(61) })).success).toBe(false);
    expect(parse(preset({ label: 'x'.repeat(120) })).success).toBe(true);
    expect(parse(preset({ label: 'x'.repeat(121) })).success).toBe(false);
  });

  it('description length is counted in UTF-16 units: 500 emoji pass, 501 do not', () => {
    expect(parse(preset({ description: '\u{1F600}'.repeat(500) })).success).toBe(true);
    expect(parse(preset({ description: '\u{1F600}'.repeat(501) })).success).toBe(false);
  });

  it('an unknown settings key is refused and named', () => {
    const result = parse(preset({}, { relayPoint: 1 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.code === 'unrecognized_keys' && i.message.includes('relayPoint'))).toBe(true);
    }
  });
});

describe('roster bulk import', () => {
  it('rosterBulkImportSchema without json is accepted, as under Zod 3', () => {
    expect(rosterBulkImportSchema.safeParse({}).success).toBe(true);
    expect(rosterBulkImportSchema.safeParse({ json: null }).success).toBe(true);
  });
});

describe('place-table messages written by this repo', () => {
  const messages = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, v: unknown) => {
    const r = schema.safeParse(v);
    expect(r.success).toBe(false);
    return r.error?.issues.map(i => i.message) ?? [];
  };

  it('storedPlaceTableSchema says "not blank" for null and "finite" for Infinity', () => {
    const schema = storedPlaceTableSchema('relayPoints');
    expect(messages(schema, [3, null])).toEqual(['relayPoints: every place value must be a number, not blank.']);
    expect(messages(schema, [3, Infinity])).toEqual(['relayPoints: every place value must be a finite number.']);
    expect(messages(schema, [3, -1])).toEqual(['relayPoints: place values cannot be negative.']);
    expect(messages(schema, [])).toEqual(['relayPoints must list at least one place value.']);
  });

  it('pointsTableSchema names a non-finite value', () => {
    expect(messages(pointsTableSchema('scoringPoints'), [3, Infinity])).toEqual([
      'scoringPoints: every place value must be a finite number.',
    ]);
  });
});
