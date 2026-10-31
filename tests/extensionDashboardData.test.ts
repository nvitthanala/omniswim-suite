/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The data behind the dashboard shell (U-a): the F1 rival default, the settings store and a saved snapshot.
 * The snapshot test uses the recorded simulator config C (tests/helpers/autoBuilderFixtures.ts) and a real HiGHS: the stored
 * lineup, results and facts must pass the storage validator and the engine parsers, and the tags are recorded as the coach had them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { parseReportFacts, parseResults } from '@omniswim/engine';
import type { Results, TeamId } from '@omniswim/engine';
import { closestTeam, resolveRival } from '../apps/extension/src/dashboard/rival';
import { clearAccent, readRival, readThemeSettings, saveAccent, saveRival, saveTheme } from '../apps/extension/src/dashboard/settingsStore';
import { buildSnapshotRecord, saveSnapshot } from '../apps/extension/src/dashboard/snapshotSave';
import { meetKeyForSnapshot } from '../apps/extension/src/dashboard/meetKey';
import { createStorageRepo, openOmniDb, saveScorerRulePreset } from '../apps/extension/src/storage';
import type { StorageRepo } from '../apps/extension/src/storage';
import { configCWorld, RULE_REF, realSolveLp } from './helpers/autoBuilderFixtures';
import type { ConfigCWorld } from './helpers/autoBuilderFixtures';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';

const team = (teamId: string, points: number, rank: number): Results['teams'][number] => ({ teamId: teamId as TeamId, points, rank });
const resultsOf = (teams: Results['teams']): Results => ({ payloadVersion: 1, teams, events: [], violations: [], rosterUnknown: [] });

describe('the rival default (F1)', () => {
  it('is the team closest to yours on final points', () => {
    const r = resultsOf([team('a', 100, 1), team('b', 90, 2), team('own', 60, 3), team('d', 20, 4)]);
    expect(closestTeam(r, 'own' as TeamId)).toBe('b');
  });
  it('is the team above yours when two teams are equally near', () => {
    const r = resultsOf([team('a', 70, 1), team('own', 60, 2), team('c', 50, 3)]);
    expect(closestTeam(r, 'own' as TeamId)).toBe('a');
  });
  it('does not depend on the order of the teams', () => {
    const r = resultsOf([team('c', 50, 3), team('a', 70, 1), team('own', 60, 2)]);
    expect(closestTeam(r, 'own' as TeamId)).toBe('a');
  });
  it('is null when yours is the only team or is not in the results', () => {
    expect(closestTeam(resultsOf([team('own', 1, 1)]), 'own' as TeamId)).toBeNull();
    expect(closestTeam(resultsOf([team('a', 1, 1)]), 'own' as TeamId)).toBeNull();
  });
  it('gives the coach choice first, and falls back and says so when the chosen team is gone', () => {
    const r = resultsOf([team('a', 100, 1), team('b', 90, 2), team('own', 60, 3)]);
    expect(resolveRival(r, 'own' as TeamId, { kind: 'team', teamId: 'a' as TeamId })).toStrictEqual({ teamId: 'a', chosen: true });
    expect(resolveRival(r, 'own' as TeamId, { kind: 'team', teamId: 'zz' as TeamId })).toStrictEqual({ teamId: 'b', chosen: false });
    expect(resolveRival(r, 'own' as TeamId, { kind: 'team', teamId: 'own' as TeamId }), 'you cannot be your own rival').toStrictEqual({ teamId: 'b', chosen: false });
    expect(resolveRival(r, 'own' as TeamId, { kind: 'closest' })).toStrictEqual({ teamId: 'b', chosen: false });
    expect(resolveRival(r, 'own' as TeamId, undefined)).toStrictEqual({ teamId: 'b', chosen: false });
  });
});

async function freshRepo(): Promise<{ repo: StorageRepo; close: () => void }> {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('shell') });
  return { repo: createStorageRepo(db, { now: steppingClock() }), close: () => db.close() };
}

describe('the settings store', () => {
  it('reads light with no accent from an empty store', async () => {
    const { repo, close } = await freshRepo();
    expect(await readThemeSettings(repo)).toStrictEqual({ preference: 'light' });
    close();
  });
  it('round-trips the theme and the accent, and clears the accent', async () => {
    const { repo, close } = await freshRepo();
    await saveTheme(repo, 'dark');
    await saveAccent(repo, '#12ab34');
    expect(await readThemeSettings(repo)).toStrictEqual({ preference: 'dark', accent: '#12ab34' });
    await saveTheme(repo, 'system');
    expect((await readThemeSettings(repo)).preference).toBe('system');
    await clearAccent(repo);
    expect(await readThemeSettings(repo)).toStrictEqual({ preference: 'system' });
    await clearAccent(repo);
    close();
  });
  it('writes an accent only as #rrggbb and stores nothing for another form', async () => {
    const { repo, close } = await freshRepo();
    for (const bad of ['red', '#fff', 'url(x)', '#12345g']) await expect(saveAccent(repo, bad)).rejects.toThrow(RangeError);
    expect((await readThemeSettings(repo)).accent).toBeUndefined();
    close();
  });
  it('stores a rival per meet and removes it with undefined', async () => {
    const { repo, close } = await freshRepo();
    await saveRival(repo, 'meet-1', { kind: 'team', teamId: '11' as TeamId });
    await saveRival(repo, 'meet-2', { kind: 'closest' });
    expect(await readRival(repo, 'meet-1')).toStrictEqual({ kind: 'team', teamId: '11' });
    expect(await readRival(repo, 'meet-2')).toStrictEqual({ kind: 'closest' });
    await saveRival(repo, 'meet-1', undefined);
    expect(await readRival(repo, 'meet-1')).toBeUndefined();
    expect(await readRival(repo, 'meet-2')).toStrictEqual({ kind: 'closest' });
    close();
  });
});

describe('one meet key formula', () => {
  it('is the same for the same teams and window, whatever the order of the teams', async () => {
    const world = await configCWorld();
    const reversed = { ...world.snapshot, teams: [...world.snapshot.teams].reverse() };
    expect(meetKeyForSnapshot(reversed)).toBe(meetKeyForSnapshot(world.snapshot));
    expect(meetKeyForSnapshot(world.snapshot)).toBe(world.meetKey);
    world.close();
  }, 60_000);
});

describe('saving a snapshot', () => {
  let world: ConfigCWorld;
  const clock = (): string => '2026-10-31T14:05:09.000Z';
  const deps = (newId: string, repo = (): StorageRepo => world.repo) => ({ repo: repo(), solveLp: realSolveLp, now: clock, newId: () => newId });
  beforeAll(async () => { world = await configCWorld(); }, 120_000);

  it('builds a record whose lineup, results and facts pass the engine parsers, with the tags as the coach had them', async () => {
    const built = await buildSnapshotRecord(world.snapshot, '  Config C  ', deps('snap-1'));
    if (built.kind !== 'built') throw new Error(`not built: ${built.reasons.join(' ')}`);
    const { record } = built;
    expect(record.name).toBe('Config C');
    expect(built.coachTags).toBe(world.pinned.length);
    expect(record.kind).toBe('snapshot');
    expect(record.meetKey).toBe(world.meetKey);
    expect((record.payload as { meetKey: string }).meetKey, 'the validator ties the payload key to the record key').toBe(world.meetKey);
    expect(parseResults(record.results).teams.length).toBeGreaterThan(1);
    expect(parseReportFacts(record.facts)).toBeDefined();
    expect(record.tags?.coach.map((t) => String(t.swimmerId)).sort()).toStrictEqual([...world.pinned].sort());
    expect(record.tags?.coach.every((t) => t.role === 'scorer')).toBe(true);
    expect(record.builtUnder.rulePreset).toStrictEqual(RULE_REF);
    expect(Object.keys(record.builtUnder.rulePresetValues).length).toBeGreaterThan(0);
    // Nothing is written by building.
    expect(await world.repo.list('lineups')).toStrictEqual([]);
  }, 120_000);

  it('saves a real config with dive entries and reads it back whole', async () => {
    const outcome = await saveSnapshot(world.snapshot, 'Config C', deps('snap-2'));
    if (outcome.kind !== 'saved') throw new Error(`not saved: ${outcome.reasons.join(' ')}`);
    expect(outcome.lineupId).toBe('snap-2');
    const stored = await world.repo.get('lineups', 'snap-2');
    if (!stored.found) throw new Error('the record is not in the store');
    const record = stored.value;
    expect(record.kind).toBe('snapshot');
    const diveTexts = Object.entries(record.payload.display?.entryTimes ?? {}).filter(([key]) => /\|(1|3)-Meter Diving\|/.test(key));
    expect(diveTexts.length, 'the stored lineup keeps its dive seed scores').toBeGreaterThan(0);
    for (const [, time] of diveTexts) expect(Number(time.text.replace('.', ''))).toBe(time.hundredths);
    expect(parseResults(record.results).teams.length).toBeGreaterThan(1);
    expect(parseReportFacts(record.facts)).toBeDefined();
    // The opponents' suggested roster is stored as tags with the three keys the validator allows (the category says "suggested").
    expect(record.tags?.suggested.length).toBeGreaterThan(0);
    expect(record.tags?.suggested.every((t) => Object.keys(t).sort().join() === 'role,swimmerId,teamId')).toBe(true);
  }, 120_000);

  it('names the snapshot from the time when the name is blank', async () => {
    const built = await buildSnapshotRecord(world.snapshot, '   ', deps('snap-4'));
    expect(built.kind === 'built' ? built.record.name : built.reasons.join(' ')).toBe('Snapshot 2026-10-31 14:05');
  }, 120_000);

  it('refuses, and stores nothing, when no scoring rules have been chosen', async () => {
    const empty = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('no-rules') });
    const repo = createStorageRepo(empty, { now: steppingClock() });
    const outcome = await saveSnapshot(world.snapshot, 'x', deps('never', () => repo));
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' ? outcome.reasons.join(' ') : '').toMatch(/scoring rules/);
    expect(await repo.list('lineups')).toStrictEqual([]);
    // Choosing the rules is all it needs, even without an own team: the tags are then empty, not invented.
    await saveScorerRulePreset(repo, world.meetKey, RULE_REF);
    const again = await buildSnapshotRecord(world.snapshot, 'x', deps('later', () => repo));
    expect(again.kind === 'built' ? again.record.tags : again).toStrictEqual({ coach: [], suggested: [] });
    empty.close();
  }, 120_000);
});
