/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Architect review 2026-10-13, finding 4: one team's A and B relays on a dead
 * heat (same event, round, place and clock) are two relays, and a relay-leg
 * override belongs to one of them.
 *
 * ## Why this test exists
 *
 * `relayEntryKey` is `team|event|round|place|clock`. Commit 6cede0ae told the
 * two relays apart in the scoring group key and the roster-simulation key, but
 * not in the key an override is stored and matched under. `findRelayLegOverride`
 * therefore applied an override for a leg of A to the same leg of B, and the
 * template of a B leg was the A relay's leadoff row.
 *
 * The fix keeps every key that is not tied exactly as it was (saved overrides
 * and the keys the screens compare), and appends the named swimmers to a tied
 * relay's key. An override saved under the plain key of a tied relay still
 * applies, to both, because that is the only key it ever had.
 *
 * The cases go through the writers (`suggestBestRelayLegFill`,
 * `stableRelayEntryKey`) and the readers (`simulateRoster`,
 * `buildWhatIfProjection`, `countWorkingCopyChanges`): a hand-built key proves
 * only the matcher.
 */
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type RelayLegOverride,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { simulateRoster } from '../packages/core/src/lib/utils';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import {
  findRelayLegOverride,
  relayEntryKeyIn,
  relayTemplateFromLeg,
  stableRelayEntryKey,
  suggestBestRelayLegFill,
} from '../packages/core/src/lib/relayLegMatching';
import { buildWhatIfProjection } from '../packages/core/src/lib/whatIfProjection';
import { countWorkingCopyChanges } from '../packages/core/src/lib/workingCopyChanges';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { buildRelaysFromIndividualLineup } from '../packages/core/src/lib/relayBuilder';

const TEAM = 'Home';
const EVENT = 'Event 31 Men 4x50 Yard Freestyle Relay';
const CLOCK = '1:21.00';
const LEG = 1;

const relayLegs = (names: string[], clock = CLOCK): SwimmerResult[] =>
  names.map(
    (name, i) =>
      ({
        id: `${names[0]}-${i}`,
        rank: 2,
        name,
        classYear: 'FR',
        team: TEAM,
        time: clock,
        finalsTime: clock,
        relayTeamTime: clock,
        roundSwam: 'A Final',
        points: 0,
        event: EVENT,
        gender: Gender.MEN,
        isRelay: true,
        relayLegIndex: i,
        relayLegStroke: 'free',
        relayLegSplit: '20.00',
        relayNames: names.map(n => ({ name: n, year: 'FR' })),
      }) as SwimmerResult
  );

/** An individual 50 Free: the swim that may fill a leg of the 4x50 Free Relay. */
const fifty = (name: string, time: string): SwimmerResult =>
  ({
    id: `ind-${name}`,
    rank: 1,
    name,
    classYear: 'FR',
    team: TEAM,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event: 'Event 8 Men 50 Yard Freestyle',
    gender: Gender.MEN,
  }) as SwimmerResult;

const A = ['A1', 'A2', 'A3', 'A4'];
const B = ['B1', 'B2', 'B3', 'B4'];
const tied = [...relayLegs(A), ...relayLegs(B)];
const individuals = [fifty('X1', '20.00'), fifty('Y1', '20.50')];
const results = [...tied, ...individuals];

const aLeg = tied.find(r => r.name === 'A2') as SwimmerResult;
const bLeg = tied.find(r => r.name === 'B2') as SwimmerResult;
const aTemplate = relayTemplateFromLeg(tied, aLeg);
const bTemplate = relayTemplateFromLeg(tied, bLeg);

/** The override a coach's autofill writes for one relay's leg, through the real writer. */
function autofillFor(template: SwimmerResult): RelayLegOverride {
  const fill = suggestBestRelayLegFill(individuals, template, LEG, new Set(), new Set(), undefined, tied);
  expect(fill).not.toBeNull();
  return (fill as NonNullable<typeof fill>).override;
}

/** Both A2 and B2 leave: the same leg index is open on both relays. */
const BOTH_LEFT = new Set(['a2', 'b2']);

describe('the template of a tied relay', () => {
  it('is a row of the relay the leg belongs to, not the other relay leadoff', () => {
    expect(aTemplate.name).toBe('A1');
    expect(bTemplate.name).toBe('B1');
  });

  it('a leg of a projected relay (a swimmer replaced) still finds its own relay', () => {
    // The projection rewrites relayNames: B2 left, so the row lists '—'. Its three other names say which relay it is.
    const projected = {
      ...bLeg,
      name: '—',
      time: '1:24.00',
      relayTeamTime: '1:24.00',
      relayNames: [{ name: 'B1', year: 'FR' }, { name: '—', year: '' }, { name: 'B3', year: 'FR' }, { name: 'B4', year: 'FR' }],
    } as SwimmerResult;
    expect(relayTemplateFromLeg(tied, projected).name).toBe('B1');
    const projectedA = { ...aLeg, name: '—', relayNames: [{ name: 'A1', year: 'FR' }, { name: '—', year: '' }, { name: 'A3', year: 'FR' }, { name: 'A4', year: 'FR' }] } as SwimmerResult;
    expect(relayTemplateFromLeg(tied, projectedA).name).toBe('A1');
  });
});

describe('the key an override is stored under', () => {
  it('a relay that is not tied keeps the plain key it always had', () => {
    const onlyA = relayLegs(A);
    const key = stableRelayEntryKey(onlyA, onlyA[1]!);
    expect(key).toBe(`${TEAM}|${EVENT}|A Final|2|${CLOCK}`);
    expect(key).toBe(relayEntryKey(onlyA[1]!));
  });

  it('a tied relay carries its named swimmers, and the two relays get two keys', () => {
    const keyA = stableRelayEntryKey(tied, aLeg);
    const keyB = stableRelayEntryKey(tied, bLeg);
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith(`${TEAM}|${EVENT}|A Final|2|${CLOCK}|`)).toBe(true);
    // Every leg of one relay reads the same key.
    expect(stableRelayEntryKey(tied, tied.find(r => r.name === 'A4') as SwimmerResult)).toBe(keyA);
  });

  it('a relay that ties a different clock is not tied', () => {
    const other = relayLegs(B, '1:22.00');
    expect(stableRelayEntryKey([...relayLegs(A), ...other], relayLegs(A)[0]!)).toBe(`${TEAM}|${EVENT}|A Final|2|${CLOCK}`);
  });

  it('the writer keys the override to the relay it fills', () => {
    expect(autofillFor(aTemplate).relayEntryKey).toBe(stableRelayEntryKey(tied, aLeg));
    expect(autofillFor(bTemplate).relayEntryKey).toBe(stableRelayEntryKey(tied, bLeg));
    expect(autofillFor(aTemplate).relayEntryKey).not.toBe(autofillFor(bTemplate).relayEntryKey);
  });
});

describe('an override of one tied relay', () => {
  it('fills that relay leg and leaves the other relay leg vacant', () => {
    const override = autofillFor(aTemplate);
    expect(override.assigneeName).toBe('X1');
    const out = simulateRoster(results, [], false, BOTH_LEFT, [override]);
    const aOut = out.filter(r => r.isRelay === true && r.relayNames?.some(n => n.name === 'A1'));
    const bOut = out.filter(r => r.isRelay === true && r.relayNames?.some(n => n.name === 'B1'));
    expect(aOut).toHaveLength(4);
    expect(bOut).toHaveLength(4);
    expect(aOut.find(r => r.relayLegIndex === LEG)?.name).toBe('X1');
    const bLegOut = bOut.find(r => r.relayLegIndex === LEG) as SwimmerResult;
    expect(bLegOut.name).toBe('—');
    expect(bLegOut.relayLegVacant).toBe(true);
  });

  it('the same holds for the other relay', () => {
    const override = autofillFor(bTemplate);
    const out = simulateRoster(results, [], false, BOTH_LEFT, [override]);
    const aOut = out.filter(r => r.isRelay === true && r.relayNames?.some(n => n.name === 'A1'));
    const bOut = out.filter(r => r.isRelay === true && r.relayNames?.some(n => n.name === 'B1'));
    expect(bOut.find(r => r.relayLegIndex === LEG)?.name).toBe('X1');
    expect(aOut.find(r => r.relayLegIndex === LEG)?.relayLegVacant).toBe(true);
  });

  it('two overrides, one per relay, each fill their own leg', () => {
    const a = { ...autofillFor(aTemplate), assigneeName: 'X1' };
    const b = { ...autofillFor(bTemplate), assigneeName: 'Y1' };
    const out = simulateRoster(results, [], false, BOTH_LEFT, [a, b]);
    expect(out.find(r => r.isRelay && r.relayLegIndex === LEG && r.relayNames?.some(n => n.name === 'A1'))?.name).toBe('X1');
    expect(out.find(r => r.isRelay && r.relayLegIndex === LEG && r.relayNames?.some(n => n.name === 'B1'))?.name).toBe('Y1');
  });
});

/**
 * Architect re-review 2026-10-13, finding 1b: a key saved before the two relays
 * were told apart is not read for a tied relay any more. It is rewritten into
 * one override per relay (`migrateTiedRelayOverrides`), which the readers
 * (`simulateRoster`, the what-if projection) and the relays screen do first.
 * The fallback this block used to pin let a clear on A change B's fill.
 * `tests/relayTiedAmbiguityMigration.test.ts` holds the new-contract cases.
 */
describe('a key saved before the two relays were told apart', () => {
  const plainKey = `${TEAM}|${EVENT}|A Final|2|${CLOCK}`;
  const legacy: RelayLegOverride = { relayEntryKey: plainKey, legIndex: LEG, assigneeName: 'X1', source: 'manual' };

  it('still applies to a relay that is not tied', () => {
    const onlyA = [...relayLegs(A), ...individuals];
    const out = simulateRoster(onlyA, [], false, new Set(['a2']), [legacy]);
    expect(out.find(r => r.isRelay && r.relayLegIndex === LEG)?.name).toBe('X1');
  });

  it('is not read as the own key of a tied relay', () => {
    expect(findRelayLegOverride([legacy], aTemplate, LEG, tied)).toBeUndefined();
    expect(findRelayLegOverride([legacy], bTemplate, LEG, tied)).toBeUndefined();
  });

  it('applies to both tied relays once migrated, as it did before (it named both)', () => {
    const out = simulateRoster(results, [], false, BOTH_LEFT, [legacy]);
    expect(out.filter(r => r.isRelay && r.relayLegIndex === LEG).map(r => r.name)).toStrictEqual(['X1', 'X1']);
  });

  it("an override saved under the relay's own key wins over the plain one", () => {
    const own: RelayLegOverride = { ...autofillFor(bTemplate), assigneeName: 'Y1' };
    const out = simulateRoster(results, [], false, BOTH_LEFT, [legacy, own]);
    const nameOf = (first: string) =>
      out.find(r => r.isRelay && r.relayLegIndex === LEG && r.relayNames?.some(n => n.name === first))?.name;
    expect(nameOf('B1')).toBe('Y1');
    expect(nameOf('A1')).toBe('X1');
  });

  it('is read as plain when no pool is given', () => {
    expect(relayEntryKeyIn(undefined, bTemplate)).toBe(plainKey);
    expect(findRelayLegOverride([legacy], bTemplate, LEG)).toBe(legacy);
  });
});

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-tied-relays',
    name: 'tied relays',
    createdAt: 0,
    menResults: results,
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [
      { name: 'A2', gender: Gender.MEN },
      { name: 'B2', gender: Gender.MEN },
    ],
    conference: 'NSISC',
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    ...over,
  } as Workspace;
}

describe('the readers that filter overrides by relay', () => {
  it('the what-if projection keeps an override saved under a tied relay own key', () => {
    const override = autofillFor(aTemplate);
    const rows = buildWhatIfProjection({
      workspace: workspace({ relayLegOverrides: [override] }),
      gender: Gender.MEN,
      removeSeniors: false,
    }).rows;
    const legs = rows.filter(r => r.isRelay === true && r.relayLegIndex === LEG);
    expect(legs.map(r => [r.relayNames?.[0]?.name, r.name])).toStrictEqual([
      ['A1', 'X1'],
      ['B1', '—'],
    ]);
  });

  it('the working-copy count resolves the override instead of calling it unresolved', () => {
    const counts = countWorkingCopyChanges(workspace({ relayLegOverrides: [autofillFor(aTemplate)] }), Gender.MEN);
    expect(counts.relayLegOverrides).toBe(1);
    expect(counts.unresolvedRelayLegOverrides).toBe(0);
  });
});

describe('the relay-leg swap ranking sees two relays', () => {
  it('evaluates both candidates for both relays, not for one merged entry', () => {
    const ws = workspace();
    const ranked = rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ws.scoringSettings });
    // Two vacated legs (A2 and B2), two candidates (X1, Y1). One merged entry would evaluate 2.
    expect(ranked.candidatesEvaluated).toBe(4);
  });

  it("a swimmer on one relay is a candidate for the other relay's open leg", () => {
    // B3 swims the B relay and has a 50 Free. For the A relay's open leg B3 is a third candidate. If the legs
    // of the two relays were read as one entry, B3 would count as on the A relay and be left out.
    const ws = workspace({ menResults: [...results, fifty('B3', '20.80')] });
    const ranked = rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ws.scoringSettings });
    // A open leg: X1, Y1, B3. B open leg: X1, Y1 (B3 is on it).
    expect(ranked.candidatesEvaluated).toBe(5);
  });
});

describe('the relay builder keys each tied relay fill to its own relay', () => {
  it('one fill per relay, not one fill that replaces the other', () => {
    const vacate = (rows: SwimmerResult[]) =>
      rows.map(r => (r.relayLegIndex === LEG ? { ...r, name: '—', relayLegVacant: true } : r));
    const legs = [...vacate(relayLegs(A)), ...vacate(relayLegs(B))];
    const ws = workspace({ menResults: [...legs, ...individuals], deletedSwimmers: [] });
    const fills = buildRelaysFromIndividualLineup(ws, Gender.MEN, TEAM, individuals, legs).filter(o => o.legIndex === LEG);
    expect(fills.map(o => o.relayEntryKey).sort()).toStrictEqual(
      [stableRelayEntryKey(tied, aLeg), stableRelayEntryKey(tied, bLeg)].sort()
    );
  });
});
