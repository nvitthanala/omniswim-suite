/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The live model (plans/2026-10-25/D7-LIVEMODEL-SPEC.md sections 1 and 5), pure part: T1 to T4 and the tag partition and key rules of T5.
 *
 * SYNTHETIC rosters over the committed simulator fixture, config C (men; teams 58, 48, 412). Swimmer ids are numeric (D7 decision I), and each
 * test that needs a loaded roster asserts `status === 'members'`, so a non-numeric id fails the test instead of taking the not-loaded path.
 */
import { describe, expect, it } from 'vitest';
import { requireComplete, scoreMeet } from '@omniswim/engine';
import type { ScorerTag } from '@omniswim/engine';
import { rescoreSimulator, SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import { buildLiveModel, partitionTags, rosterSeasonNote } from '../apps/extension/src/dashboard/liveModel';
import { meetKeyForSnapshot } from '../apps/extension/src/dashboard/meetKey';
import { toSwimCloudId } from '../apps/extension/src/storage';
import type { ClassYearOverrideRecord } from '../apps/extension/src/storage';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { adaptedOf, AT, classYearsFor, CURRENT, emptyStored, liveOf, numericSnapshot, PAST, rosterRecord, storedOf, swimmersOf } from './helpers/liveFixtures';

const snapshot = numericSnapshot('C');
const meetKey = meetKeyForSnapshot(snapshot);
const raw = adaptedOf(snapshot);
const teamStatus = (live: ReturnType<typeof liveOf>, teamId: string): string => live.enrichment.teams.find((t) => t.teamId === teamId)?.status ?? 'missing';
const resultsOf = (live: ReturnType<typeof liveOf>) => scoreMeet(live.model, live.lineup, [], requireComplete(live.adapted.preset.preset), live.sourcing);

/** Team 58's roster minus two swimmers: one in an individual entry, one in a relay leg. The two are read from the fixture. */
function pickNotMembers() {
  const ids58 = swimmersOf(snapshot, '58');
  const relay = raw.lineup.entries.find((e) => e.kind === 'relay' && String(e.teamId) === '58');
  if (relay?.kind !== 'relay') throw new Error('the fixture has no team 58 relay');
  const legSwimmer = String(relay.legs[0]!.swimmerId);
  const individual = raw.lineup.entries.find((e) => e.kind === 'individual' && String(e.teamId) === '58' && String(e.swimmerId) !== legSwimmer);
  if (individual?.kind !== 'individual') throw new Error('the fixture has no team 58 individual entry');
  const individualSwimmer = String(individual.swimmerId);
  return { ids58, relay, legSwimmer, individualSwimmer, members: ids58.filter((id) => id !== legSwimmer && id !== individualSwimmer) };
}

describe('T1: Simulator (current) changes nothing', () => {
  it('with empty stores the model, the lineup and the results equal the adapter and rescoreSimulator', () => {
    const live = liveOf(snapshot);
    expect(live.model).toStrictEqual(raw.model);
    expect(live.lineup).toStrictEqual(raw.lineup);
    expect(live.adapted).toStrictEqual(raw);
    expect(live.sourcing).toBe(SIMULATOR_SOURCING);
    expect(live.enrichment.removedEntries).toEqual([]);
    const rescored = rescoreSimulator(snapshot, { meetKey, snapshotId: 'live-snapshot' });
    expect(rescored.kind).toBe('scored');
    if (rescored.kind !== 'scored') return;
    expect(resultsOf(live)).toStrictEqual(rescored.results);
  });

  it('a stored roster that omits swimmers is a cross-check only: nobody becomes not_member and no entry is removed', () => {
    const { members } = pickNotMembers();
    const stored = storedOf({ membership: [rosterRecord('58', CURRENT, members)] });
    const live = liveOf(snapshot, { currentLabel: CURRENT, stored });
    expect(teamStatus(live, '58')).toBe('members');
    expect(live.enrichment.teams.find((t) => t.teamId === '58')!.notOnRoster.length).toBe(2);
    expect(live.model.swimmers.every((s) => s.roster === 'member')).toBe(true);
    expect(live.lineup).toStrictEqual(raw.lineup);
    expect(live.enrichment.removedEntries).toEqual([]);
    const rescored = rescoreSimulator(snapshot, { meetKey, snapshotId: 'live-snapshot' });
    if (rescored.kind !== 'scored') throw new Error('not scored');
    expect(resultsOf(live)).toStrictEqual(rescored.results);
  });
});

describe('T2: class years reach every team', () => {
  it('both teams with a current roster get a class year for each listed swimmer, an override wins, and the results do not change', () => {
    const ids58 = swimmersOf(snapshot, '58');
    const ids48 = swimmersOf(snapshot, '48');
    const override: ClassYearOverrideRecord = { swimmerId: toSwimCloudId(ids48[0]!), seasonId: CURRENT, classYear: 'GR', origin: { kind: 'local' }, rev: 3, createdAt: AT, updatedAt: AT };
    const stored = storedOf({
      membership: [rosterRecord('58', CURRENT, ids58), rosterRecord('48', CURRENT, ids48)],
      current: [rosterRecord('58', CURRENT, ids58, { classYears: classYearsFor(ids58) }), rosterRecord('48', CURRENT, ids48, { classYears: classYearsFor(ids48, ['SR', 'JR']) })],
      overrides: [override],
    });
    const live = liveOf(snapshot, { currentLabel: CURRENT, stored });
    expect(teamStatus(live, '58')).toBe('members');
    expect(teamStatus(live, '48')).toBe('members');
    const yearOf = (id: string) => live.model.swimmers.find((s) => s.swimmerId === id)!.classYear;
    expect(ids58.map(yearOf).every((y) => y !== null)).toBe(true);
    expect(ids48.map(yearOf).every((y) => y !== null)).toBe(true);
    expect(yearOf(ids58[1]!)).toBe('SO');
    expect(yearOf(ids48[1]!)).toBe('JR');
    expect(yearOf(ids48[0]!)).toBe('GR'); // the override beats SwimCloud's SR
    expect(swimmersOf(snapshot, '412').map(yearOf).every((y) => y === null)).toBe(true); // no roster: absent, never guessed
    const rescored = rescoreSimulator(snapshot, { meetKey, snapshotId: 'live-snapshot' });
    if (rescored.kind !== 'scored') throw new Error('not scored');
    expect(resultsOf(live)).toStrictEqual(rescored.results);
  });

  it('without the current season label no class year is resolved', () => {
    const ids58 = swimmersOf(snapshot, '58');
    const stored = storedOf({ current: [rosterRecord('58', CURRENT, ids58, { classYears: classYearsFor(ids58) })] });
    const live = liveOf(snapshot, { currentLabel: null, stored });
    expect(live.model.swimmers.every((s) => s.classYear === null)).toBe(true);
  });
});

describe('T3: a roster season removes entries of a not_member swimmer', () => {
  it('removes the individual entry, and a relay with one not_member leg whole; the other teams stay unknown and keep every entry', () => {
    const { members, legSwimmer, individualSwimmer, relay } = pickNotMembers();
    const live = liveOf(snapshot, { choice: { kind: 'season', label: PAST }, currentLabel: CURRENT, stored: storedOf({ membership: [rosterRecord('58', PAST, members)] }) });
    expect(teamStatus(live, '58')).toBe('members');
    const roster = (id: string) => live.model.swimmers.find((s) => s.swimmerId === id)!.roster;
    expect(roster(legSwimmer)).toBe('not_member');
    expect(roster(individualSwimmer)).toBe('not_member');
    // No individual entry of a not_member swimmer is left.
    expect(live.lineup.entries.filter((e) => e.kind === 'individual' && (String(e.swimmerId) === individualSwimmer || String(e.swimmerId) === legSwimmer))).toEqual([]);
    // The relay is gone whole: no entry with that key, and none with the three other legs only.
    const relayKey = removedKeyOf(live, 'relay', relay.eventKey, legSwimmer);
    expect(live.lineup.entries.some((e) => e.kind === 'relay' && e.legs.some((l) => String(l.swimmerId) === legSwimmer))).toBe(false);
    expect(live.lineup.entries.filter((e) => e.kind === 'relay').length).toBe(raw.lineup.entries.filter((e) => e.kind === 'relay').length - raw.lineup.entries.filter((e) => e.kind === 'relay' && e.legs.some((l) => [legSwimmer, individualSwimmer].includes(String(l.swimmerId)))).length);
    expect(relayKey).toBeDefined();
    // Every removed entry is listed, and each lists the not_member swimmer that caused it.
    const expectedRemoved = raw.lineup.entries.filter((e) => (e.kind === 'individual' ? [String(e.swimmerId)] : e.legs.map((l) => String(l.swimmerId))).some((id) => id === legSwimmer || id === individualSwimmer));
    expect(live.enrichment.removedEntries.length).toBe(expectedRemoved.length);
    expect(live.lineup.entries.length).toBe(raw.lineup.entries.length - expectedRemoved.length);
    // Teams without a loaded roster: unknown, nothing removed.
    for (const team of ['48', '412']) {
      expect(teamStatus(live, team)).toBe('not-loaded');
      expect(live.model.swimmers.filter((s) => String(s.teamId) === team).every((s) => s.roster === 'unknown')).toBe(true);
      expect(live.enrichment.removedEntries.filter((r) => String(r.teamId) === team)).toEqual([]);
      expect(live.lineup.entries.filter((e) => String(e.teamId) === team).length).toBe(raw.lineup.entries.filter((e) => String(e.teamId) === team).length);
    }
    // The scored season-mode meet still scores: nothing is left that scoreMeet would refuse.
    expect(() => resultsOf(live)).not.toThrow();
  });

  it('the Score note names the season and the number of removed entries', () => {
    const { members } = pickNotMembers();
    const live = liveOf(snapshot, { choice: { kind: 'season', label: PAST }, currentLabel: CURRENT, stored: storedOf({ membership: [rosterRecord('58', PAST, members)] }) });
    expect(rosterSeasonNote(live)).toBe(`Roster season ${PAST} applies to Build, Plan and scorer tags (${live.enrichment.removedEntries.length} entries removed). This table is SwimCloud's own lineup, scored as SwimCloud scores it.`);
    expect(rosterSeasonNote(liveOf(snapshot))).toBeNull();
  });
});

function removedKeyOf(live: ReturnType<typeof liveOf>, kind: 'relay', eventKey: string, swimmerId: string): string | undefined {
  return live.enrichment.removedEntries.find((r) => r.kind === kind && r.eventKey === eventKey && r.swimmerIds.includes(swimmerId as never))?.entryKey;
}

describe('T4: a missing roster is unknown, never not_member', () => {
  it('a team with no record is not-loaded: every swimmer unknown, zero removals', () => {
    const live = liveOf(snapshot, { choice: { kind: 'season', label: PAST }, currentLabel: CURRENT, stored: emptyStored() });
    for (const team of ['58', '48', '412']) expect(teamStatus(live, team)).toBe('not-loaded');
    expect(live.model.swimmers.every((s) => s.roster === 'unknown')).toBe(true);
    expect(live.model.swimmers.some((s) => s.roster === 'not_member')).toBe(false);
    expect(live.enrichment.removedEntries).toEqual([]);
    expect(live.lineup.entries.length).toBe(raw.lineup.entries.length);
  });

  it('numeric roster ids over a simulator with non-numeric swimmer ids join nothing: the team is id-join-suspect and unknown, not not_member', () => {
    const sanitized = buildSnapshot('C').snapshot;
    const ids = swimmersOf(snapshot, '58');
    const live = liveOf(sanitized, { choice: { kind: 'season', label: PAST }, currentLabel: CURRENT, stored: storedOf({ membership: [rosterRecord('58', PAST, ids)] }) });
    expect(teamStatus(live, '58')).toBe('id-join-suspect');
    expect(live.model.swimmers.filter((s) => String(s.teamId) === '58').every((s) => s.roster === 'unknown')).toBe(true);
    expect(live.enrichment.removedEntries).toEqual([]);
  });

  it('a roster of the wrong gender is an error outcome with a reason, not a throw', () => {
    const ids = swimmersOf(snapshot, '58');
    const out = buildLiveModel({ snapshot, choice: { kind: 'season', label: PAST }, currentLabel: CURRENT, stored: storedOf({ membership: [rosterRecord('58', PAST, ids, { gender: 'Women' })] }), sourcing: SIMULATOR_SOURCING });
    expect(out.kind).toBe('error');
  });

  it('a snapshot SwimCloud has not loaded is not_loaded and lists what is missing', () => {
    const out = buildLiveModel({ snapshot: { ...snapshot, swimmers: null } as never, choice: { kind: 'simulator-current' }, currentLabel: null, stored: emptyStored(), sourcing: SIMULATOR_SOURCING });
    expect(out.kind).toBe('not_loaded');
    if (out.kind === 'not_loaded') expect(out.missing).toContain('swimmers');
  });
});

describe('T5 (pure part): tags of not_member swimmers are partitioned, unknown ones are kept', () => {
  it('drops only the not_member swimmer\'s tag, keeps an unknown swimmer\'s tag and an untouched one, and never mutates the input', () => {
    const { members, legSwimmer } = pickNotMembers();
    const live = liveOf(snapshot, { choice: { kind: 'season', label: PAST }, currentLabel: CURRENT, stored: storedOf({ membership: [rosterRecord('58', PAST, members)] }) });
    const unknownSwimmer = swimmersOf(snapshot, '48')[0]!; // team 48 has no roster: unknown
    const memberSwimmer = members[0]!;
    const tags: ScorerTag[] = [
      { teamId: '58' as never, swimmerId: legSwimmer as never, role: 'scorer' },
      { teamId: '48' as never, swimmerId: unknownSwimmer as never, role: 'scorer' },
      { teamId: '58' as never, swimmerId: memberSwimmer as never, role: 'non-scorer' },
    ];
    const before = JSON.stringify(tags);
    const { kept, notMember } = partitionTags(live, tags);
    expect(notMember.map((t) => t.swimmerId)).toEqual([legSwimmer]);
    expect(kept.map((t) => t.swimmerId)).toEqual([unknownSwimmer, memberSwimmer]);
    expect(JSON.stringify(tags)).toBe(before);
  });

  it('in Simulator (current) nothing is dropped', () => {
    const live = liveOf(snapshot);
    const tags: ScorerTag[] = swimmersOf(snapshot, '58').slice(0, 3).map((id) => ({ teamId: '58' as never, swimmerId: id as never, role: 'scorer' as const }));
    expect(partitionTags(live, tags)).toEqual({ kept: tags, notMember: [] });
  });
});

describe('the live key', () => {
  const base = { snapshot, choice: { kind: 'simulator-current' } as const, currentLabel: CURRENT as string | null, stored: emptyStored(), sourcing: SIMULATOR_SOURCING };
  const keyOf = (patch: Partial<typeof base>) => {
    const out = buildLiveModel({ ...base, ...patch });
    if (out.kind !== 'ready') throw new Error('not ready');
    return out.live.key;
  };
  it('is the same whatever the order of the stored rows, and changes with each thing that changes the output', () => {
    const a = rosterRecord('58', CURRENT, swimmersOf(snapshot, '58'));
    const b = rosterRecord('48', CURRENT, swimmersOf(snapshot, '48'));
    expect(keyOf({ stored: storedOf({ membership: [a, b] }) })).toBe(keyOf({ stored: storedOf({ membership: [b, a] }) }));
    const k0 = keyOf({});
    expect(keyOf({ choice: { kind: 'season', label: PAST } as never })).not.toBe(k0);
    expect(keyOf({ stored: storedOf({ membership: [a] }) })).not.toBe(k0); // team 58 goes from not-loaded to members
    const ids58 = swimmersOf(snapshot, '58');
    // A class year that SwimCloud shows changes the output, so it changes the key.
    expect(keyOf({ stored: storedOf({ current: [rosterRecord('58', CURRENT, ids58, { classYears: classYearsFor(ids58) })] }) })).not.toBe(k0);
    const override: ClassYearOverrideRecord = { swimmerId: toSwimCloudId(ids58[0]!), seasonId: CURRENT, classYear: 'SR', origin: { kind: 'local' }, rev: 1, createdAt: AT, updatedAt: AT };
    expect(keyOf({ stored: storedOf({ overrides: [override] }) })).not.toBe(k0);
    expect(keyOf({ stored: storedOf({ overrides: [{ ...override, classYear: 'FR' }] }) })).not.toBe(keyOf({ stored: storedOf({ overrides: [override] }) }));
    expect(keyOf({ snapshot: { ...snapshot, teams: [...snapshot.teams] } })).toBe(k0);
  });

  it('does not change when only the raw inputs change: the season list arriving, a refetch of the same roster, an override edit that leaves the class year', () => {
    const k0 = keyOf({ currentLabel: null });
    expect(keyOf({ currentLabel: CURRENT })).toBe(k0); // the season list arrived; nothing is stored, so nothing in the output moved
    expect(keyOf({ currentLabel: PAST })).toBe(k0);
    const a = rosterRecord('58', CURRENT, swimmersOf(snapshot, '58'));
    expect(keyOf({ stored: storedOf({ membership: [a] }) })).toBe(keyOf({ stored: storedOf({ membership: [{ ...a, fetchedAt: '2026-11-07T00:00:00.000Z' }] }) }));
    const override: ClassYearOverrideRecord = { swimmerId: toSwimCloudId(swimmersOf(snapshot, '58')[0]!), seasonId: CURRENT, classYear: 'SR', origin: { kind: 'local' }, rev: 1, createdAt: AT, updatedAt: AT };
    expect(keyOf({ stored: storedOf({ overrides: [{ ...override, rev: 2 }] }) })).toBe(keyOf({ stored: storedOf({ overrides: [override] }) }));
  });
});
