/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a (plans/2026-10-25/D7-DATA-SOURCING.md section 4): T-R4, the membership table row by row, and T-R5, the class-year order.
 *
 * Data. The meet is the recorded simulator config B (58, 48 and 412, men, SCY; `tests/fixtures/swimcloud/simulator/`), whose swimmer
 * ids are sanitized (`T58-S01`). A real roster page carries real SwimCloud ids, so a real roster cannot be joined to these ids
 * (D7 decision I). The ROSTER EVIDENCE in this file is therefore SYNTHETIC: it is built from the sanitized model's own ids and
 * says so. The one real-data check is the last test: the real 2025-2026 roster of team 58 against the sanitized ids must come out
 * `id-join-suspect`, never `not_member`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { adaptSimulatorSnapshot, enrichRosterMembership, parityReport, rescoreSimulator, readRosterFetch } from '@omniswim/swimcloud/browser';
import type { AdaptedSimulator, EnrichInput, RosterEvidence } from '@omniswim/swimcloud/browser';
import { entryKey, requireComplete, scoreMeet } from '@omniswim/engine';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import { resolveClassYear } from '../apps/extension/src/storage/classYear';
import { toSwimCloudId } from '../apps/extension/src/storage/schema';
import type { ClassYearOverrideRecord, RosterRecord } from '../apps/extension/src/storage/schema';

const built = buildSnapshot('B');
const outcome = adaptSimulatorSnapshot(built.snapshot, { meetKey: 'enrich-B', snapshotId: 'fixture' });
if (outcome.kind !== 'ready') throw new Error('config B did not adapt');
const adapted: AdaptedSimulator = outcome.adapted;
const { model, lineup } = adapted;

const idsOf = (teamId: string): string[] => model.swimmers.filter((s) => s.teamId === teamId).map((s) => s.swimmerId);
const T58 = '58';
const ids58 = idsOf(T58);
const withEntries = (teamId: string): string[] => [...new Set(lineup.entries.filter((e) => e.kind === 'individual' && e.teamId === teamId).map((e) => (e as { swimmerId: string }).swimmerId))];
const members = (ids: readonly string[]): RosterEvidence => ({ state: 'members', gender: 'Men', memberIds: ids });
const seasonMode = (rosters: EnrichInput['rosters']): EnrichInput => ({ mode: 'season', rosters });
const rosterOf = (r: ReturnType<typeof enrichRosterMembership>, id: string): string => r.model.swimmers.find((s) => s.swimmerId === id)?.roster ?? 'missing';
const teamOf = (r: ReturnType<typeof enrichRosterMembership>, id: string) => r.teams.find((t) => t.teamId === id)!;

describe('the fixture meet', () => {
  it('has three teams with swimmers, individual entries and relay entries (so every test below has something to remove)', () => {
    expect(ids58.length).toBeGreaterThan(10);
    expect(withEntries(T58).length).toBeGreaterThan(2);
    expect(lineup.entries.some((e) => e.kind === 'relay' && e.teamId === T58)).toBe(true);
    expect(model.swimmers.every((s) => s.roster === 'member' && s.classYear === null)).toBe(true);
  });
});

describe('T-R4 membership table (SYNTHETIC roster evidence), season mode', () => {
  it('season S, roster not loaded: unknown', () => {
    const r = enrichRosterMembership(adapted, seasonMode({}));
    for (const id of ids58) expect(rosterOf(r, id)).toBe('unknown');
    expect(teamOf(r, T58).status).toBe('not-loaded');
    expect(r.removedEntries).toEqual([]);
    expect(r.lineup.entries).toEqual(lineup.entries);
  });

  it('season S, members, id listed: member; id not listed: not_member', () => {
    const [listed, dropped, ...rest] = withEntries(T58);
    const roster = ids58.filter((id) => id !== dropped);
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: members(roster) }));
    expect(rosterOf(r, listed!)).toBe('member');
    expect(rosterOf(r, dropped!)).toBe('not_member');
    for (const id of rest) expect(rosterOf(r, id)).toBe('member');
    expect(teamOf(r, T58)).toMatchObject({ status: 'members', notOnRoster: [dropped], overlap: ids58.length - 1 });
  });

  it('season S, verified-empty: unknown, plus a contradiction note', () => {
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: { state: 'verified-empty', gender: 'Men' } }));
    for (const id of ids58) expect(rosterOf(r, id)).toBe('unknown');
    const team = teamOf(r, T58);
    expect(team.status).toBe('verified-empty');
    expect(team.notes.join(' ')).toMatch(/lists no roster/);
    expect(r.removedEntries).toEqual([]);
  });

  it('season S, members with zero overlap: unknown for the team plus id-join-suspect (checked BEFORE the per-id rule)', () => {
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: members(['9990001', '9990002', '9990003']) }));
    for (const id of ids58) expect(rosterOf(r, id)).toBe('unknown');
    expect(teamOf(r, T58).status).toBe('id-join-suspect');
    expect(teamOf(r, T58).notes.join(' ')).toContain('id-join-suspect');
    expect(teamOf(r, T58).notes.join(' ')).toContain('or no current swimmer was on this roster'); // zero overlap on an old season is also a real answer (L4)
    expect(r.removedEntries).toEqual([]);
    // Another team in the same meet is judged on its own.
    const other = idsOf('48');
    const r2 = enrichRosterMembership(adapted, seasonMode({ [T58]: members(['9990001']), '48': members(other.slice(1)) }));
    expect(rosterOf(r2, other[0]!)).toBe('not_member');
    expect(rosterOf(r2, other[1]!)).toBe('member');
  });

  it('roster members with no simulator swims are counted, never added', () => {
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: members([...ids58, '9990001', '9990002']) }));
    expect(teamOf(r, T58).rosterOnly).toEqual(['9990001', '9990002']);
    expect(r.model.swimmers).toHaveLength(model.swimmers.length);
    expect(r.model.swimmers.some((s) => s.swimmerId === '9990001')).toBe(false);
    expect(teamOf(r, T58).notOnRoster).toEqual([]);
  });

  it('a roster for the wrong gender throws instead of scoring a men\'s meet against a women\'s roster', () => {
    expect(() => enrichRosterMembership(adapted, seasonMode({ [T58]: { state: 'members', gender: 'Women', memberIds: ids58 } }))).toThrow(RangeError);
  });
});

describe('T-R4 simulator-current mode: a fetched roster is a cross-check only', () => {
  it('lists mismatches, applies none, removes nothing', () => {
    const dropped = withEntries(T58)[0]!;
    const r = enrichRosterMembership(adapted, { mode: 'simulator-current', rosters: { [T58]: members(ids58.filter((id) => id !== dropped)) } });
    expect(teamOf(r, T58).notOnRoster).toEqual([dropped]);
    expect(rosterOf(r, dropped)).toBe('member');
    expect(r.removedEntries).toEqual([]);
    expect(r.lineup.entries).toEqual(lineup.entries);
    expect(r.model.swimmers.map((s) => s.roster)).toEqual(model.swimmers.map((s) => s.roster));
  });
});

describe('removal of not_member lineup entries', () => {
  it('removes the swimmer\'s individual entries and lists them', () => {
    const victim = withEntries(T58)[0]!;
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: members(ids58.filter((id) => id !== victim)) }));
    const gone = lineup.entries.filter((e) => e.kind === 'individual' && e.swimmerId === victim);
    expect(gone.length).toBeGreaterThan(0);
    expect(r.removedEntries.filter((x) => x.kind === 'individual').map((x) => x.entryKey).sort()).toEqual(gone.map(entryKey).sort());
    expect(r.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === victim)).toBe(false);
    expect(r.lineup.entries.length).toBe(lineup.entries.length - r.removedEntries.length);
  });

  it('removes a relay whole when any leg is not_member, so scoreMeet does not throw roster_not_member', () => {
    const relay = lineup.entries.find((e) => e.kind === 'relay' && e.teamId === T58);
    if (relay?.kind !== 'relay') throw new Error('no relay');
    const victim = relay.legs[2].swimmerId;
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: members(ids58.filter((id) => id !== victim)) }));
    expect(r.removedEntries.map((x) => x.entryKey)).toContain(entryKey(relay));
    expect(r.lineup.entries.some((e) => e.kind === 'relay' && entryKey(e) === entryKey(relay))).toBe(false);
    const rules = requireComplete(adapted.preset.preset!);
    // It scores. Left in, the same model throws roster_not_member.
    expect(() => scoreMeet(r.model, r.lineup, [], rules, SIMULATOR_SOURCING)).not.toThrow();
    expect(() => scoreMeet(r.model, lineup, [], rules, SIMULATOR_SOURCING)).toThrow(/not on the roster|roster_not_member/);
  });

  it('prunes the removed entries\' displayed times', () => {
    const victim = withEntries(T58)[0]!;
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: members(ids58.filter((id) => id !== victim)) }));
    const times = Object.keys(r.lineup.display?.entryTimes ?? {});
    for (const removed of r.removedEntries) expect(times).not.toContain(removed.entryKey);
    expect(times.length).toBeLessThan(Object.keys(lineup.display?.entryTimes ?? {}).length);
  });

  it('does not change the input', () => {
    const before = JSON.stringify({ model, lineup });
    enrichRosterMembership(adapted, seasonMode({ [T58]: members(ids58.slice(1)) }));
    expect(JSON.stringify({ model, lineup })).toBe(before);
  });
});

describe('decision P: parity reads the raw snapshot only', () => {
  it('rescoring the snapshot and the parity report are identical whatever roster is loaded', () => {
    const before = rescoreSimulator(built.snapshot, { meetKey: 'enrich-B', snapshotId: 'fixture' });
    enrichRosterMembership(adapted, seasonMode({ [T58]: members(ids58.slice(1)) }));
    const after = rescoreSimulator(built.snapshot, { meetKey: 'enrich-B', snapshotId: 'fixture' });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    if (after.kind !== 'scored') throw new Error('not scored');
    expect(parityReport(after.adapted, after.results)).toEqual((before as { parity: unknown }).parity);
  });
});

describe('T-R5 class year: override > sourced > absent', () => {
  const swimmerId = toSwimCloudId('1130590');
  const seasonId = '2025-2026';
  const roster = (classYears?: Record<string, 'FR' | 'SO' | 'JR' | 'SR' | 'GR'>): RosterRecord => ({
    teamId: toSwimCloudId('58'), seasonId, gender: 'Men', memberIds: [swimmerId, toSwimCloudId('2352628')], ...(classYears ? { classYears } : {}),
    sourceUrl: '/team/58/roster/?page=1&gender=M&season_id=29&sort=name', fetchedAt: '2026-11-06T00:00:00.000Z', parser: { name: 'readRosterFetch', confidence: 'real-capture-verified' },
  });
  const override: ClassYearOverrideRecord = { swimmerId, seasonId, classYear: 'JR', origin: { kind: 'local' }, rev: 1, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' };

  it('the user override wins over the sourced value', () => {
    expect(resolveClassYear({ swimmerId, seasonId, override, roster: roster({ [swimmerId]: 'SR' }) })).toMatchObject({ state: 'user', classYear: 'JR' });
  });
  it('the sourced value is used when there is no override', () => {
    expect(resolveClassYear({ swimmerId, seasonId, roster: roster({ [swimmerId]: 'SR' }) })).toMatchObject({ state: 'sourced', classYear: 'SR' });
  });
  it('a roster with no class year for the swimmer, or no roster, is absent, and absent becomes null in the model', () => {
    expect(resolveClassYear({ swimmerId, seasonId, roster: roster({ '2352628': 'FR' }) })).toEqual({ state: 'absent' });
    expect(resolveClassYear({ swimmerId, seasonId, roster: roster() })).toEqual({ state: 'absent' });
    expect(resolveClassYear({ swimmerId, seasonId })).toEqual({ state: 'absent' });
    const ids = ids58.slice(0, 2);
    const resolved = { [ids[0]!]: 'SR' as const, [ids[1]!]: null };
    const r = enrichRosterMembership(adapted, { mode: 'simulator-current', rosters: {}, classYears: resolved });
    expect(r.model.swimmers.find((s) => s.swimmerId === ids[0])?.classYear).toBe('SR');
    expect(r.model.swimmers.find((s) => s.swimmerId === ids[1])?.classYear).toBeNull();
    expect(r.model.swimmers.find((s) => s.swimmerId === ids58[2])?.classYear).toBeNull();
  });
});

describe('real roster against sanitized simulator ids', () => {
  it('the real team 58 roster shares no id with the sanitized fixture, so the team is id-join-suspect and nobody is removed', () => {
    const html = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'swimcloud-real-team-roster-58-gender-m.html'), 'utf8');
    const reqPath = '/team/58/roster/?page=1&gender=M&season_id=29&sort=name';
    const o = readRosterFetch(html, { target: { teamId: '58', gender: 'M', season: { kind: 'option', value: '29', label: '2025-2026' } }, requestedPath: reqPath, finalPath: reqPath, fetchedAt: '2026-11-06T00:00:00.000Z' });
    if (o.kind !== 'members') throw new Error(o.kind);
    const r = enrichRosterMembership(adapted, seasonMode({ [T58]: { state: 'members', gender: 'Men', memberIds: o.memberIds } }));
    expect(teamOf(r, T58)).toMatchObject({ status: 'id-join-suspect', overlap: 0 });
    for (const id of ids58) expect(rosterOf(r, id)).toBe('unknown');
    expect(r.removedEntries).toEqual([]);
  });
});
