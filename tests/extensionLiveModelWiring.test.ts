/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The live model wired into the dashboard (plans/2026-10-25/D7-LIVEMODEL-SPEC.md section 5): T3 (request and planner side), T4 (loader), T5 (scoring,
 * suggestions, request), T6, T7, T9 (storage half) and T10. The pure rules are in `extensionLiveModel.test.ts`; T8 and the Rosters tab half of T9 are in
 * `extensionSnapshotSaveSourcing.test.ts` and `extensionRosterTab.test.ts`.
 *
 * SYNTHETIC rosters over the committed simulator fixture, config C (men; teams 58, 48, 412), in a fresh IndexedDB. The setup asserts
 * `status === 'members'` for the own team, so a non-numeric id fails the setup instead of passing on the not-loaded path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_SESSION_PRESETS, builtinRulePreset } from '@omniswim/engine';
import type { RulePreset, ScorerTag, SessionPreset } from '@omniswim/engine';
import { rescoreSimulator, SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import { swimmerLabel } from '../apps/extension/src/shared/names';
import { validateRecord } from '../apps/extension/src/storage/validate';
import { defaultLoadPreference } from '../apps/extension/src/storage/sessionPreference';
import { toSwimCloudId } from '../apps/extension/src/storage';
import { readCoachTags, prepareRequest, defaultControls } from '../apps/extension/src/dashboard/autoBuilderRequest';
import { acceptProposal, SEASON_ACCEPT_REFUSED } from '../apps/extension/src/dashboard/autoBuilderAccept';
import { buildPlannerState, rosterErrorState } from '../apps/extension/src/dashboard/plannerState';
import { buildLiveModel, loadLiveStored } from '../apps/extension/src/dashboard/liveModel';
import { scoreScorerTags } from '../apps/extension/src/dashboard/scorerTagScoring';
import { suggestedTags, suggestOpponentRosters } from '../apps/extension/src/dashboard/suggestedRosters';
import { readRosterSeason, saveRosterSeason } from '../apps/extension/src/dashboard/settingsStore';
import { viewOf } from '../apps/extension/src/dashboard/liveView';
import { configCWorld, nodeScore, realSolveLp, runWorld } from './helpers/autoBuilderFixtures';
import type { ConfigCWorld } from './helpers/autoBuilderFixtures';
import { adaptedOf, CURRENT, liveOf, PAST, readyLive, repoLoader, rosterRecord, storedOf, swimmersOf } from './helpers/liveFixtures';

const RULES = builtinRulePreset('nsisc', 5) as RulePreset;
const SCHEDULE = (BUILTIN_SESSION_PRESETS[0] as { preset: SessionPreset }).preset;
const worlds: ConfigCWorld[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });

/** The not_member swimmers: a coach-tagged own swimmer (`pinned[0]`) and a swimmer on a team 58 relay who is not tagged. */
async function seasonWorld() {
  const w = await configCWorld();
  worlds.push(w);
  const raw = adaptedOf(w.snapshot);
  const pinnedOut = w.pinned[0] as string;
  const relay = raw.lineup.entries.find((e) => e.kind === 'relay' && String(e.teamId) === '58' && e.legs.every((l) => !w.pinned.includes(String(l.swimmerId))));
  if (relay?.kind !== 'relay') throw new Error('the fixture has no team 58 relay without a tagged swimmer');
  const legOut = String(relay.legs[0]!.swimmerId);
  const members = swimmersOf(w.snapshot, '58').filter((id) => id !== pinnedOut && id !== legOut);
  await w.repo.putCache('rosters', rosterRecord('58', PAST, members));
  await saveRosterSeason(w.repo, w.meetKey, { kind: 'season', label: PAST });
  const unknownSwimmer = swimmersOf(w.snapshot, '48')[0] as string;
  await w.repo.put('tags', { meetKey: w.meetKey, teamId: toSwimCloudId('48'), swimmerId: toSwimCloudId(unknownSwimmer), role: 'scorer' }, 'new');
  const live = await readyLive(w.loadLive, w.snapshot);
  // The guard: a loaded roster, so a non-numeric id cannot slip onto the not-loaded path.
  expect(live.enrichment.teams.find((t) => t.teamId === '58')?.status).toBe('members');
  expect(live.choice).toEqual({ kind: 'season', label: PAST });
  return { w, raw, live, pinnedOut, legOut, relay, unknownSwimmer, members };
}

const entryTouches = (e: ReturnType<typeof adaptedOf>['lineup']['entries'][number], ids: readonly string[]): boolean =>
  (e.kind === 'individual' ? [String(e.swimmerId)] : e.legs.map((l) => String(l.swimmerId))).some((id) => ids.includes(id));

/** What the panel does: suggestions first, then the planner with the coach's tags plus the suggested ones. */
async function plannerOf(l: Awaited<ReturnType<typeof seasonWorld>>['live'], coach: readonly ScorerTag[]) {
  const suggestions = await suggestOpponentRosters(l, '58', coach, RULES, realSolveLp);
  return buildPlannerState(l, RULES, SCHEDULE, defaultLoadPreference(), [...coach, ...suggestedTags(suggestions)]);
}

describe('the planner under NSISC (finding 1: it was pending for every NSISC meet)', () => {
  it('scores with the coach tags and the suggested opponents, so the session load is not pending; without tags it is', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const live = await readyLive(w.loadLive, w.snapshot);
    const coach = await readCoachTags(w.repo, w.meetKey);
    const planned = await plannerOf(live, coach);
    expect(planned?.violations.some((v) => v.startsWith('Session load is pending'))).toBe(false);
    expect(planned?.perSwimmer.length).toBeGreaterThan(0);
    // The old call had no tags. NSISC cannot score a meet without a scoring roster, so the planner could only say pending.
    const untagged = buildPlannerState(live, RULES, SCHEDULE, defaultLoadPreference(), []);
    expect(untagged?.perSwimmer).toEqual([]);
    expect(untagged?.violations[0]).toMatch(/^Session load is pending: no scoring roster tagged/);
  }, 120_000);

  it('under a points_pool preset a stored tag is not passed, so the session load is still computed', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const live = await readyLive(w.loadLive, w.snapshot);
    const coach = await readCoachTags(w.repo, w.meetKey);
    expect(coach.length).toBeGreaterThan(0);
    // SwimCloud's own preset scores a points pool: scoreMeet refuses any tag there (tags_need_roster_mode).
    const pool = live.adapted.preset.preset;
    expect(pool.scorers.eligibility).toMatchObject({ state: 'set', value: 'points_pool' });
    const planned = buildPlannerState(live, pool, SCHEDULE, defaultLoadPreference(), coach);
    expect(planned?.violations.some((v) => v.startsWith('Session load is pending'))).toBe(false);
    expect(planned?.perSwimmer.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('L1: a live model that cannot be built posts the real tags and a roster-specific error', () => {
  it('rosterErrorState keeps the stored tags and names the roster, not "Could not load saved scorer tags"', async () => {
    const w = await configCWorld();
    worlds.push(w);
    // A Women roster for a men's meet is the enrichment's RangeError: the outcome is an error with a reason.
    const stored = storedOf({ membership: [rosterRecord('58', PAST, swimmersOf(w.snapshot, '58'), { gender: 'Women' })] });
    const out = buildLiveModel({ snapshot: w.snapshot, choice: { kind: 'season', label: PAST }, currentLabel: CURRENT, stored, sourcing: SIMULATOR_SOURCING });
    if (out.kind !== 'error') throw new Error('expected an error outcome');
    const tags = (await readCoachTags(w.repo, w.meetKey)).map((t) => ({ teamId: String(t.teamId), swimmerId: String(t.swimmerId), role: t.role }));
    expect(tags.length).toBeGreaterThan(0);
    const state = rosterErrorState({ meetKey: w.meetKey, teams: [], swimmers: [], tags, ownTeamId: '58' }, out.reason);
    expect(state.tags).toEqual(tags);
    expect(state.ownTeamId).toBe('58');
    expect(state.error).toBe(`The roster season could not be applied: ${out.reason}`);
    expect(state.error).not.toContain('Could not load saved scorer tags');
    const main = readFileSync(path.join(process.cwd(), 'apps', 'extension', 'src', 'dashboard', 'main.tsx'), 'utf8');
    expect(main).toContain("if (loaded.kind === 'error') { postPanelMessage(rosterErrorState(base, loaded.reason)); return; }");
    expect(main).not.toContain('throw new Error(loaded.reason)');
  }, 120_000);
});

describe('T3: the request and the planner read the live model', () => {
  it('the request lineup has no entry of a not_member swimmer and no relay with a not_member leg; the planner does not count them', async () => {
    const { w, raw, live, pinnedOut, legOut, relay } = await seasonWorld();
    const out = [pinnedOut, legOut];
    expect(raw.lineup.entries.some((e) => e.kind === 'individual' && String(e.swimmerId) === pinnedOut)).toBe(true); // the premise: he is entered
    const prepared = await prepareRequest({ live, repo: w.repo, solveLp: realSolveLp, controls: defaultControls() });
    if (prepared.kind !== 'ready') throw new Error(`not ready: ${prepared.missing.join(' ')}`);
    expect(prepared.request.lineup.entries.some((e) => entryTouches(e, out))).toBe(false);
    expect(prepared.request.lineup.entries.length).toBe(raw.lineup.entries.filter((e) => !entryTouches(e, out)).length);
    expect(prepared.request.lineup.entries.some((e) => e.kind === 'relay' && e.eventKey === relay.eventKey && e.teamId === relay.teamId && entryTouches(e, out))).toBe(false);
    expect(prepared.request.model.swimmers.filter((s) => s.roster === 'not_member').map((s) => String(s.swimmerId)).sort()).toEqual([...out].sort());

    // The planner: in Simulator (current) the two swimmers carry session load; with the roster season they carry none.
    const simLive = liveOf(w.snapshot);
    // The planner under the coach's NSISC rules, with the same tags the scorer-tag scoring gets (the coach's plus the suggested opponents).
    const coach = await readCoachTags(w.repo, w.meetKey);
    const perSwimmer = async (l: typeof live): Promise<string[]> => (await plannerOf(l, coach))?.perSwimmer.map((x) => x.swimmerId) ?? [];
    expect(await perSwimmer(simLive)).toEqual(expect.arrayContaining(out));
    for (const id of out) expect(await perSwimmer(live)).not.toContain(id);
    expect((await perSwimmer(live)).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('T4: the loader reads the season setting and treats a missing roster as unknown', () => {
  it('loadLiveStored skips a team id that is not a SwimCloud id (no throw), and finds a stored roster by season and gender', async () => {
    const { w } = await seasonWorld();
    const stored = await loadLiveStored(w.repo, ['58', 'T412', '48'], 'Men', PAST, CURRENT);
    expect([...stored.membership.keys()]).toEqual(['58']);
    expect([...stored.current.keys()]).toEqual([]);
    expect((await loadLiveStored(w.repo, ['58'], 'Women', PAST, null)).membership.size).toBe(0);
    expect((await loadLiveStored(w.repo, ['58'], 'Men', null, null)).membership.size).toBe(0);
  }, 120_000);

  it('the other teams of the season-mode live model are unknown, and nothing of theirs is removed', async () => {
    const { live, raw } = await seasonWorld();
    for (const team of ['48', '412']) {
      expect(live.enrichment.teams.find((t) => t.teamId === team)?.status).toBe('not-loaded');
      expect(live.model.swimmers.filter((s) => String(s.teamId) === team).every((s) => s.roster === 'unknown')).toBe(true);
      expect(live.lineup.entries.filter((e) => String(e.teamId) === team).length).toBe(raw.lineup.entries.filter((e) => String(e.teamId) === team).length);
    }
  }, 120_000);
});

describe('T5: a tag on a not_member swimmer is dropped and reported; an unknown swimmer\'s tag is kept; the stored row stays', () => {
  it('scoring warns with the exact sentence and still scores', async () => {
    const { w, live, pinnedOut, unknownSwimmer } = await seasonWorld();
    const tags = await readCoachTags(w.repo, w.meetKey);
    expect(tags.some((t) => String(t.swimmerId) === pinnedOut)).toBe(true);
    // As the panel does: the coach's tags plus the suggested opponent rosters, so every side has a scoring roster.
    const suggestions = await suggestOpponentRosters(live, '58', tags, RULES, realSolveLp);
    const scored = scoreScorerTags(live, true, [...tags, ...suggestedTags(suggestions)], RULES);
    expect(scored.scored).toBe(true);
    const name = swimmerLabel(pinnedOut, live.model.display?.swimmers[pinnedOut]?.name);
    expect(scored.warnings).toContain(`${name} is not on the ${PAST} roster; the scorer tag is not used.`);
    expect(scored.warnings.filter((x) => x.includes('is not on the'))).toHaveLength(1);
    expect(scored.warnings.some((x) => x.includes(unknownSwimmer))).toBe(false);
  }, 120_000);

  it('the opponent suggestions are not refused because of the dropped tag', async () => {
    const { w, live } = await seasonWorld();
    const tags = await readCoachTags(w.repo, w.meetKey);
    const suggestions = await suggestOpponentRosters(live, '58', tags, RULES, realSolveLp);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.map((s) => s.result.kind)).toEqual(suggestions.map(() => 'suggested'));
  }, 120_000);

  it('the request drops the not_member tag, keeps the unknown swimmer\'s tag, reports the drop, and leaves the store unchanged', async () => {
    const { w, live, pinnedOut, unknownSwimmer } = await seasonWorld();
    const before = JSON.stringify(await w.repo.list('tags', { index: 'byMeet', value: w.meetKey }));
    const prepared = await prepareRequest({ live, repo: w.repo, solveLp: realSolveLp, controls: defaultControls() });
    if (prepared.kind !== 'ready') throw new Error(`not ready: ${prepared.missing.join(' ')}`);
    const requestTags = prepared.request.tags;
    expect(requestTags.some((t: ScorerTag) => String(t.swimmerId) === pinnedOut)).toBe(false);
    expect(requestTags.some((t: ScorerTag) => String(t.swimmerId) === unknownSwimmer && t.source === undefined)).toBe(true);
    expect(prepared.droppedTags.map((t) => String(t.swimmerId))).toEqual([pinnedOut]);
    // The stored list is what Accept compares with: the dropped tag is still in it.
    expect(prepared.inputs.coachTags.some((t) => String(t.swimmerId) === pinnedOut)).toBe(true);
    expect(prepared.inputs.liveKey).toBe(live.key);
    expect(prepared.request.sourcing).toBe(live.sourcing);
    expect(JSON.stringify(await w.repo.list('tags', { index: 'byMeet', value: w.meetKey }))).toBe(before);
  }, 120_000);
});

describe('T6: a roster season with the own team not loaded cannot build', () => {
  it('prepareRequest returns missing and names the fix', async () => {
    const w = await configCWorld();
    worlds.push(w);
    await saveRosterSeason(w.repo, w.meetKey, { kind: 'season', label: PAST });
    const live = await readyLive(w.loadLive, w.snapshot);
    expect(live.enrichment.teams.find((t) => t.teamId === '58')?.status).toBe('not-loaded');
    const prepared = await prepareRequest({ live, repo: w.repo, solveLp: realSolveLp, controls: defaultControls() });
    expect(prepared.kind).toBe('missing');
    if (prepared.kind === 'missing') expect(prepared.missing).toEqual([`The ${PAST} roster of your team has not been fetched. Fetch it in the Rosters tab, or choose Simulator (current).`]);
  }, 120_000);

  it('Simulator (current) with no roster stored still builds', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const prepared = await prepareRequest({ live: await readyLive(w.loadLive, w.snapshot), repo: w.repo, solveLp: realSolveLp, controls: defaultControls() });
    expect(prepared.kind).toBe('ready');
  }, 120_000);
});

describe('T7: Accept is refused when the roster season changed after the run', () => {
  it('a season chosen between Run and Accept blocks Accept and writes nothing', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const tagged = await runWorld(w);
    if (tagged.result.kind !== 'improved') throw new Error('expected improved');
    await saveRosterSeason(w.repo, w.meetKey, { kind: 'season', label: PAST });
    const out = await acceptProposal(tagged, new Map(), { repo: w.repo, solveLp: realSolveLp, score: nodeScore, loadLive: w.loadLive, currentSnapshot: w.snapshot, now: () => '2026-11-06T12:00:00.000Z', newId: () => 'lineup-t7' });
    expect(out).toEqual({ kind: 'blocked', reason: 'The roster season, a stored roster or a class year changed after this run. Run the AutoBuilder again.' });
    expect(await w.repo.list('lineups')).toEqual([]);
  }, 180_000);

  const acceptDeps = (w: ConfigCWorld, loadLive: ConfigCWorld['loadLive'], newId: string) => ({ repo: w.repo, solveLp: realSolveLp, score: nodeScore, loadLive, currentSnapshot: w.snapshot, now: () => '2026-11-06T12:00:00.000Z', newId: () => newId });

  it('a roster stored after the run changes the key and blocks Accept; with nothing changed the same Accept goes through', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const withLabel = repoLoader(w.repo, CURRENT);
    const tagged = await runWorld(w);
    // The run saw the model under the current-season label; the key of that model is what the run recorded.
    const run = { ...tagged, inputs: { ...tagged.inputs, liveKey: (await readyLive(withLabel, w.snapshot)).key } };
    const control = await acceptProposal(run, new Map(), acceptDeps(w, withLabel, 'lineup-t7-control'));
    expect(control.kind).toBe('accepted');
    const w2 = await configCWorld();
    worlds.push(w2);
    const loader2 = repoLoader(w2.repo, CURRENT);
    const tagged2 = await runWorld(w2);
    const run2 = { ...tagged2, inputs: { ...tagged2.inputs, liveKey: (await readyLive(loader2, w2.snapshot)).key } };
    await w2.repo.putCache('rosters', rosterRecord('58', CURRENT, swimmersOf(w2.snapshot, '58')));
    const blocked = await acceptProposal(run2, new Map(), acceptDeps(w2, loader2, 'lineup-t7-blocked'));
    expect(blocked).toEqual({ kind: 'blocked', reason: 'The roster season, a stored roster or a class year changed after this run. Run the AutoBuilder again.' });
    expect(await w2.repo.list('lineups')).toEqual([]);
  }, 400_000);
});

describe('H1/H2: Accept re-checks the live model after the slow re-score, and refuses a roster season', () => {
  const deps = (w: ConfigCWorld, score: typeof nodeScore, loadLive = w.loadLive) => ({ repo: w.repo, solveLp: realSolveLp, score, loadLive, currentSnapshot: w.snapshot, now: () => '2026-11-06T12:00:00.000Z', newId: () => 'lineup-h' });

  it('H1: a season chosen while the re-score runs blocks Accept after it, and nothing is written', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const tagged = await runWorld(w);
    let calls = 0;
    // The first call of the re-score is where the coach picks a season in another tab. The first key check has run; only the last one can see it.
    const score: typeof nodeScore = async (req, lineup, tags, scaleD) => {
      calls += 1;
      if (calls === 1) await saveRosterSeason(w.repo, w.meetKey, { kind: 'season', label: PAST });
      return nodeScore(req, lineup, tags, scaleD);
    };
    const out = await acceptProposal(tagged, new Map(), deps(w, score));
    expect(calls).toBe(2);
    expect(out).toEqual({ kind: 'blocked', reason: 'The roster season, a stored roster or a class year changed after this run. Run the AutoBuilder again.' });
    expect(await w.repo.list('lineups')).toEqual([]);
    expect(await w.repo.list('tags', { index: 'byMeet', value: w.meetKey })).toHaveLength(w.pinned.length);
  }, 180_000);

  it('H2: in season mode Accept refuses before any re-score and writes nothing', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const tagged = await runWorld(w);
    await w.repo.putCache('rosters', rosterRecord('58', PAST, swimmersOf(w.snapshot, '58')));
    await saveRosterSeason(w.repo, w.meetKey, { kind: 'season', label: PAST });
    const seasonLive = await readyLive(w.loadLive, w.snapshot);
    expect(seasonLive.enrichment.teams.find((t) => t.teamId === '58')?.status).toBe('members');
    // The run is taken as made in season mode: its key is the season model's. Build runs in season mode (the T3 tests); only Accept refuses.
    const run = { ...tagged, inputs: { ...tagged.inputs, liveKey: seasonLive.key } };
    let scored = 0;
    const out = await acceptProposal(run, new Map(), deps(w, async (req, lineup, tags, scaleD) => { scored += 1; return nodeScore(req, lineup, tags, scaleD); }));
    expect(out).toEqual({ kind: 'blocked', reason: SEASON_ACCEPT_REFUSED });
    expect(scored).toBe(0);
    expect(await w.repo.list('lineups')).toEqual([]);
  }, 180_000);

  it('the season list arriving after Run does not refuse Accept when no roster is stored (the key reads the output, not the raw label)', async () => {
    const w = await configCWorld();
    worlds.push(w);
    const tagged = await runWorld(w); // the run's loader had no current label
    const withLabel = repoLoader(w.repo, CURRENT);
    expect(tagged.inputs.liveKey).toBe((await readyLive(withLabel, w.snapshot)).key);
    const out = await acceptProposal(tagged, new Map(), deps(w, nodeScore, withLabel));
    expect(out.kind).toBe('accepted');
  }, 180_000);
});

describe('T9: the season setting round-trips and the validator guards it', () => {
  it('is per meet; simulator-current deletes the entry; a bad label throws and stores nothing', async () => {
    const w = await configCWorld();
    worlds.push(w);
    expect(await readRosterSeason(w.repo, 'meet-a')).toEqual({ kind: 'simulator-current' });
    await saveRosterSeason(w.repo, 'meet-a', { kind: 'season', label: PAST });
    await saveRosterSeason(w.repo, 'meet-b', { kind: 'season', label: CURRENT });
    expect(await readRosterSeason(w.repo, 'meet-a')).toEqual({ kind: 'season', label: PAST });
    expect(await readRosterSeason(w.repo, 'meet-b')).toEqual({ kind: 'season', label: CURRENT });
    await saveRosterSeason(w.repo, 'meet-a', { kind: 'simulator-current' });
    expect(await readRosterSeason(w.repo, 'meet-a')).toEqual({ kind: 'simulator-current' });
    const row = await w.repo.get('settings', 'rosterSeasonsByMeet');
    expect(row.found && row.value.value).toEqual({ 'meet-b': CURRENT });
    for (const label of ['', 'abc', '2025', '2025-26', ' 2025-2026']) {
      await expect(saveRosterSeason(w.repo, 'meet-c', { kind: 'season', label })).rejects.toThrow(RangeError);
    }
    expect(await readRosterSeason(w.repo, 'meet-c')).toEqual({ kind: 'simulator-current' });
  }, 120_000);

  it('the storage validator rejects \'\' and \'abc\' and accepts a season label', () => {
    const base = { key: 'rosterSeasonsByMeet', rev: 1, updatedAt: '2026-11-06T00:00:00.000Z' };
    expect(validateRecord('settings', { ...base, value: { m: '2025-2026' } })).toEqual([]);
    expect(validateRecord('settings', { ...base, value: {} })).toEqual([]);
    expect(validateRecord('settings', { ...base, value: { m: '' } })).toHaveLength(1);
    expect(validateRecord('settings', { ...base, value: { m: 'abc' } })).toHaveLength(1);
    expect(validateRecord('settings', { ...base, value: { m: 2025 } })).toHaveLength(1);
    expect(validateRecord('settings', { ...base, value: ['2025-2026'] })).toHaveLength(1);
  });
});

describe('T10: Score, Chart and parity stay on the raw snapshot', () => {
  it('in season mode the Score view still equals rescoreSimulator, while the live model\'s lineup differs', async () => {
    const { w, live, raw } = await seasonWorld();
    const rescored = rescoreSimulator(w.snapshot, { meetKey: 'swimcloud-simulator', snapshotId: 'live-snapshot' });
    if (rescored.kind !== 'scored') throw new Error('not scored');
    const view = viewOf(w.snapshot);
    expect(view).toStrictEqual({ kind: 'scored', snapshot: w.snapshot, results: rescored.results, parity: rescored.parity });
    // The premise that gives the check teeth: the live model is not the raw lineup in season mode.
    expect(live.lineup.entries.length).toBeLessThan(raw.lineup.entries.length);
    expect(live.enrichment.removedEntries.length).toBeGreaterThan(0);
  }, 120_000);

  const dashboard = (name: string): string => readFileSync(path.join(process.cwd(), 'apps', 'extension', 'src', 'dashboard', name), 'utf8');

  it('main.tsx scores the view with viewOf, and viewOf reads the raw snapshot through rescoreSimulator only', () => {
    const main = dashboard('main.tsx');
    expect(main).toMatch(/const score = React\.useCallback\(\(snapshot: SimSnapshot\): void => \{ setView\(viewOf\(snapshot\)\); \}, \[\]\);/);
    const view = dashboard('liveView.tsx');
    const body = /export function viewOf\([^)]*\): View \{[\s\S]*?\n\}\n/.exec(view)?.[0] ?? '';
    expect(body).toContain('rescoreSimulator(snapshot,');
    expect(body.replace("'live-snapshot'", '')).not.toMatch(/loadLive|buildLiveModel|liveModel|enrich|\blive\b/i);
  });

  it('no dashboard file scores with literal sourcing settings or adapts a snapshot for scoring outside the live model', () => {
    for (const name of ['scorerTagScoring.ts', 'suggestedRosters.ts', 'autoBuilderRequest.ts', 'snapshotSave.ts', 'plannerState.ts', 'main.tsx', 'autoBuilderAccept.ts']) {
      const text = dashboard(name);
      expect(text, name).not.toContain('includeConvertedSwims');
      expect(text, name).not.toContain('adaptSimulatorSnapshot');
      expect(text, name).not.toContain('SIMULATOR_SOURCING = ');
    }
  });

  it('the roster flow republishes only when the current label changes or a save reaches saved, so progress ticks start no LP solve', () => {
    const main = dashboard('main.tsx');
    expect(main).toContain('rosterFlow.subscribe(() => {');
    expect(main).toContain("if (label === lastLiveLabel && (savedRun === null || savedRun === lastSavedRun)) return;");
    expect(main).toContain("const savedRun = save.kind === 'saved' ? save.runId : null;");
  });

  it('the change listeners include the rosters and class-year stores, for the tag state and the planner', () => {
    const main = dashboard('main.tsx');
    expect(main).toContain("store === 'rosters' || store === 'classYearOverrides'");
    expect(main).toMatch(/change\.stores === 'unknown' \|\| liveStores \|\| change\.stores\.some\(store => store === 'sessionPresets'/);
    expect(main).toMatch(/\|\| liveStores\) void publishTagState\(\);/);
  });
});
