/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The working-copy count of relay leg overrides when the relays screen has
 * saved a legacy tied-relay key.
 *
 * `migrateTiedRelayOverrides` rewrites one legacy override of a tied pair
 * (team + event + round + place + clock) into one override per relay. The
 * relays screen writes the migrated list on every save, so one edit became two
 * overrides and the count read 2 where it read 1 before the save. One edit is
 * one change: the copies of one edit count once, whatever the list holds.
 *
 * Break it: count `workspace.relayLegOverrides` entries one by one and the
 * cases below that save a legacy key fail.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type RelayLegOverride, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import {
  migrateTiedRelayOverrides,
  relayEntryKeyIn,
  upsertRelayLegOverride,
} from '../packages/core/src/lib/relayLegMatching';
import { countWorkingCopyChanges } from '../packages/core/src/lib/workingCopyChanges';
import { workspaceFixture } from './helpers/typedFixtures';

const TEAM = 'Home';
const EVENT = 'Event 31 Men 4x50 Yard Freestyle Relay';
const CLOCK = '1:21.00';

const relayLegs = (names: string[], place = 2): SwimmerResult[] =>
  names.map(
    (name, i) =>
      ({
        id: `${names[0]}-${place}-${i}`,
        rank: place,
        name,
        classYear: 'FR',
        team: TEAM,
        time: CLOCK,
        finalsTime: CLOCK,
        relayTeamTime: CLOCK,
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

const A = ['A1', 'A2', 'A3', 'A4'];
const B = ['B1', 'B2', 'B3', 'B4'];
const C = ['C1', 'C2', 'C3', 'C4'];
// A and B tie on place and clock. C is another place: not tied.
const results = [...relayLegs(A), ...relayLegs(B), ...relayLegs(C, 5)];

const plainKey = relayEntryKey(results[0]!);
const aKey = relayEntryKeyIn(results, results.find(r => r.name === 'A1')!);
const bKey = relayEntryKeyIn(results, results.find(r => r.name === 'B1')!);
const cKey = relayEntryKey(results.find(r => r.name === 'C1')!);

const at = (key: string, legIndex: number, assigneeName: string): RelayLegOverride => ({
  relayEntryKey: key,
  legIndex,
  assigneeName,
  source: 'manual',
});

function workspaceOf(relayLegOverrides: RelayLegOverride[]): Workspace {
  return workspaceFixture({
    id: 'ws',
    name: 'ws',
    createdAt: 0,
    menResults: results,
    womenResults: [],
    relayLegOverrides,
  });
}

const count = (overrides: RelayLegOverride[]) =>
  countWorkingCopyChanges(workspaceOf(overrides), Gender.MEN).relayLegOverrides;

describe('the scenario', () => {
  it('A and B are a tied pair with three distinct keys, C is not tied', () => {
    expect(aKey).not.toBe(plainKey);
    expect(bKey).not.toBe(plainKey);
    expect(aKey).not.toBe(bKey);
    expect(cKey).not.toBe(plainKey);
  });
});

describe('one edit is one change', () => {
  const legacy = at(plainKey, 1, 'X1');

  it('a legacy key counts 1, and still 1 once the screen has split it', () => {
    expect(count([legacy])).toBe(1);
    const migrated = migrateTiedRelayOverrides([legacy], results);
    expect(migrated).toHaveLength(2);
    expect(count(migrated)).toBe(1);
  });

  it('saving another leg adds one change, not two', () => {
    const saved = migrateTiedRelayOverrides(upsertRelayLegOverride([legacy], at(aKey, 2, 'Y1')), results);
    expect(saved).toHaveLength(3);
    expect(count(saved)).toBe(2);
  });

  it("a relay's own override of the same leg is its own change", () => {
    const saved = migrateTiedRelayOverrides(upsertRelayLegOverride([legacy], at(aKey, 1, 'Y1')), results);
    expect(count(saved)).toBe(2);
    expect(count([at(aKey, 1, 'Y1'), at(bKey, 1, 'Z1')])).toBe(2);
  });

  it('an untied relay and a second leg are each their own change', () => {
    expect(count([legacy, at(cKey, 1, 'X1'), at(plainKey, 2, 'X1')])).toBe(3);
  });

  it('the count does not change when the list is migrated', () => {
    const lists: RelayLegOverride[][] = [
      [legacy],
      [legacy, at(aKey, 1, 'Y1')],
      [legacy, at(plainKey, 2, 'X2'), at(cKey, 1, 'X1')],
      [at(aKey, 1, 'X1'), at(bKey, 1, 'X1'), at(aKey, 2, 'X2')],
    ];
    for (const list of lists) {
      expect(count(migrateTiedRelayOverrides(list, results))).toBe(count(list));
    }
  });

  it('a stale key still lands in unresolved, not in the count', () => {
    const counts = countWorkingCopyChanges(workspaceOf([legacy, at('Nobody|Event|F|1|1:00.00', 0, 'X1')]), Gender.MEN);
    expect(counts.relayLegOverrides).toBe(1);
    expect(counts.unresolvedRelayLegOverrides).toBe(1);
  });
});
