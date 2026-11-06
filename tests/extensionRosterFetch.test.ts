/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a (plans/2026-10-25/D7-DATA-SOURCING.md section 4), the extension side:
 *  - the strict guards for overlay-to-panel run messages and the season list (acceptance c);
 *  - the run client: indices 0..delivered-1 with no gap or repeat before `stopped: null` is trusted, run ids it did not start are
 *    ignored, a missing `fetch-end` after the port changed is a failed run (acceptance c and d);
 *  - the request plan, and saving a finished run: a refused page writes nothing and keeps the earlier record (acceptance g);
 *  - the season list reaching the panel, before and after a reconnect, and `main.ts` passing it on (acceptance a).
 *
 * Pages are the committed REAL roster captures (2025-2026). Where a test asks for a page under another team's id, that is SYNTHETIC reuse
 * of a real page and the test says so.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { Window as HappyWindow } from 'happy-dom';
import { fetchPathFor } from '../apps/extension/src/shared/fetchProtocol';
import type { RosterTarget } from '../apps/extension/src/shared/fetchProtocol';
import { parseFetchEnd, parseFetchItem, parseFetchOverlayMessage, parseFetchProgress, parseSeasonsState } from '../apps/extension/src/shared/panelProtocol';
import type { FetchOverlayMessage } from '../apps/extension/src/shared/panelProtocol';
import { createFetchRunClient } from '../apps/extension/src/dashboard/fetchClient';
import { createRosterFlow } from '../apps/extension/src/dashboard/rosterFlow';
import { describeRequests, planRosterRequests } from '../apps/extension/src/dashboard/rosterPlan';
import type { PlannedRosterRequest } from '../apps/extension/src/dashboard/rosterPlan';
import { rosterRecordFor, saveRosterRun } from '../apps/extension/src/dashboard/rosterRun';
import { listenForPanelPort } from '../apps/extension/src/dashboard/panelPort';
import { mountDockedPanel } from '../apps/extension/src/overlay/dockedPanel';
import type { PanelPort, PanelRuntime } from '../apps/extension/src/overlay/dockedPanel';
import { mountShadowHost } from '../apps/extension/src/overlay/overlay';
import { parseSeasonChoices } from '../apps/extension/src/shared/bridgeSchema';
import { createStorageRepo, openOmniDb, readRosterState, toSwimCloudId } from '../apps/extension/src/storage';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
const page = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const M58 = page('swimcloud-real-team-roster-58-gender-m.html');
const AT = '2026-11-06T00:00:00.000Z';

// ---- a synthetic season list shaped by live check 3 (30 = 2026-2027, 29 = 2025-2026, 28 = 2024-2025) ---------------------------------------
const SEASON_ROWS = Array.from({ length: 10 }, (_, i) => {
  const y = 2017 + i;
  return { seasonId: 21 + i, label: `${y}-${y + 1}`, startDate: `${y}-09-01`, endDate: `${y + 1}-08-31`, isCurrent: i === 9 };
});
const parsedSeasons = (() => {
  const p = parseSeasonChoices(SEASON_ROWS);
  if (!p.ok) throw new Error(p.reason);
  return p;
})();

const current = (teamId: string, gender: 'M' | 'F' = 'M'): RosterTarget => ({ kind: 'team-roster', teamId, gender, season: { kind: 'server-current' } });
const req = (teamId: string): PlannedRosterRequest => ({ target: current(teamId), role: 'current-season' });

describe('strict guards for overlay-to-panel messages', () => {
  const progress = { kind: 'fetch-progress', runId: 'r1', index: 0, waitMs: 0, why: 'start' };
  const item = { kind: 'fetch-item', runId: 'r1', index: 0, path: '/team/58/roster/?gender=M', finalPath: '/team/58/roster/?gender=M', contentType: 'text/html; charset=utf-8', body: '<html></html>', fetchedAt: AT };
  const end = { kind: 'fetch-end', runId: 'r1', delivered: 1, stopped: null };

  it('accepts exactly the documented shapes and returns copies', () => {
    expect(parseFetchProgress(progress)).toEqual(progress);
    expect(parseFetchItem(item)).toEqual(item);
    expect(parseFetchEnd(end)).toEqual(end);
    const stopped = { reason: 'challenge', index: 2, status: 200, detail: 'x' };
    expect(parseFetchEnd({ ...end, stopped })).toEqual({ ...end, stopped });
    const extra = parseFetchItem({ ...item, injected: '<script>' });
    expect(extra).toEqual(item);
    expect(extra).not.toBe(item);
  });

  it('rejects a wrong kind, a missing field, a wrong type and a bad value in every message', () => {
    const bad: unknown[] = [
      null, 'fetch-end', 3, [], {},
      { ...progress, runId: '' }, { ...progress, index: -1 }, { ...progress, index: 1.5 }, { ...progress, waitMs: '0' }, { ...progress, why: 'later' },
      { ...item, runId: 7 }, { ...item, index: '0' }, { ...item, path: undefined }, { ...item, body: null }, { ...item, fetchedAt: 'yesterday' }, { ...item, fetchedAt: '2026-11-06' },
      { ...end, delivered: -1 }, { ...end, delivered: 0.5 }, { ...end, stopped: undefined }, { ...end, stopped: 'challenge' },
      { ...end, stopped: { reason: 'novel', index: 0, status: 0, detail: '' } }, { ...end, stopped: { reason: 'challenge', index: -1, status: 0, detail: '' } },
      { ...end, stopped: { reason: 'challenge', index: 0, status: 'x', detail: '' } }, { ...end, stopped: { reason: 'challenge', index: 0, status: 0 } },
    ];
    for (const m of bad) expect(parseFetchOverlayMessage(m), JSON.stringify(m)).toBeNull();
  });

  it('checks the season list again: one current row, valid labels', () => {
    expect(parseSeasonsState({ kind: 'seasons-state', seasons: SEASON_ROWS })).toMatchObject({ ok: true });
    expect(parseSeasonsState({ kind: 'seasons-state', seasons: SEASON_ROWS.map((s) => ({ ...s, isCurrent: false })) })).toBeNull();
    expect(parseSeasonsState({ kind: 'seasons-state', seasons: SEASON_ROWS.map((s) => ({ ...s, isCurrent: true })) })).toBeNull();
    expect(parseSeasonsState({ kind: 'seasons-state', seasons: [{ ...SEASON_ROWS[0], label: '2017' }, ...SEASON_ROWS.slice(1)] })).toBeNull();
    expect(parseSeasonsState({ kind: 'seasons-state', seasons: [] })).toBeNull();
    expect(parseSeasonsState({ kind: 'seasons', seasons: SEASON_ROWS })).toBeNull();
  });
});

describe('the run client', () => {
  function setup() {
    const posted: unknown[] = [];
    let n = 0;
    const client = createFetchRunClient<PlannedRosterRequest>({ post: (m) => void posted.push(m), newRunId: () => `run-${++n}` });
    const requests = [req('58'), req('48'), req('412')];
    const paths = requests.map((r) => fetchPathFor(r.target));
    const itemMsg = (runId: string, index: number, over: Record<string, unknown> = {}): FetchOverlayMessage => parseFetchItem({
      kind: 'fetch-item', runId, index, path: paths[index], finalPath: paths[index], contentType: 'text/html', body: `page ${index}`, fetchedAt: AT, ...over,
    })!;
    const endMsg = (runId: string, delivered: number, stopped: unknown = null): FetchOverlayMessage => parseFetchEnd({ kind: 'fetch-end', runId, delivered, stopped })!;
    return { client, posted, requests, paths, itemMsg, endMsg };
  }

  it('posture off or unset: no fetch-run is posted (U5)', () => {
    for (const posture of ['off', undefined] as const) {
      const s = setup();
      expect(s.client.start('roster', s.requests, posture)).toBeNull();
      expect(s.posted).toEqual([]);
      expect(s.client.state()).toMatchObject({ phase: 'failed', reason: 'posture-off' });
    }
  });

  it('a start with posture off while a run is going leaves that run alone: it is not orphaned and still completes', () => {
    const s = setup();
    const runId = s.client.start('roster', s.requests, 'on-click')!;
    s.client.handle(s.itemMsg(runId, 0));
    expect(s.client.start('roster', s.requests, 'off')).toBeNull();
    expect(s.client.start('roster', s.requests, undefined)).toBeNull();
    expect(s.client.state()).toMatchObject({ phase: 'running', runId, received: 1 });
    for (let i = 1; i < 3; i += 1) s.client.handle(s.itemMsg(runId, i));
    s.client.handle(s.endMsg(runId, 3));
    expect(s.client.state()).toMatchObject({ phase: 'finished', runId });
  });

  it('on-click posts one fetch-run with the targets, and nothing before it', () => {
    const s = setup();
    expect(s.posted).toEqual([]);
    const runId = s.client.start('roster', s.requests, 'on-click');
    expect(runId).toBe('run-1');
    expect(s.posted).toEqual([{ kind: 'fetch-run', runId: 'run-1', feature: 'roster', targets: s.requests.map((r) => r.target) }]);
    expect(s.client.start('roster', s.requests, 'on-click')).toBeNull(); // a second start while running
    expect(s.posted).toHaveLength(1);
  });

  it('a complete run finishes only when items run 0..n-1 and delivered equals the request count', () => {
    const s = setup();
    const runId = s.client.start('roster', s.requests, 'on-click')!;
    for (let i = 0; i < 3; i += 1) s.client.handle(s.itemMsg(runId, i));
    expect(s.client.state()).toMatchObject({ phase: 'running', received: 3 });
    s.client.handle(s.endMsg(runId, 3));
    const state = s.client.state();
    if (state.phase !== 'finished') throw new Error(JSON.stringify(state));
    expect(state.items.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(state.items.map((i) => i.request.target.teamId)).toEqual(['58', '48', '412']);
  });

  it('ignores every message of a run id it did not start, and of a run that is over', () => {
    const s = setup();
    const runId = s.client.start('roster', s.requests, 'on-click')!;
    s.client.handle(s.itemMsg('someone-else', 0));
    s.client.handle(s.endMsg('someone-else', 0, { reason: 'challenge', index: 0, status: 200, detail: '' }));
    s.client.handle(parseFetchProgress({ kind: 'fetch-progress', runId: 'someone-else', index: 0, waitMs: 5000, why: 'pacing' })!);
    expect(s.client.state()).toMatchObject({ phase: 'running', received: 0, waitingMs: null });
    for (let i = 0; i < 3; i += 1) s.client.handle(s.itemMsg(runId, i));
    s.client.handle(s.endMsg(runId, 3));
    const done = s.client.state();
    expect(done.phase).toBe('finished');
    s.client.handle(s.itemMsg(runId, 3)); // late message of the finished run
    s.client.handle(s.endMsg(runId, 0, { reason: 'network', index: 0, status: 0, detail: '' }));
    expect(s.client.state()).toBe(done);
  });

  it('a gap, a repeat or an index past the end fails the run and asks the overlay to cancel', () => {
    const gap = setup();
    let id = gap.client.start('roster', gap.requests, 'on-click')!;
    gap.client.handle(gap.itemMsg(id, 0));
    gap.client.handle(gap.itemMsg(id, 2));
    expect(gap.client.state()).toMatchObject({ phase: 'failed', reason: 'out-of-order' });
    expect(gap.posted.at(-1)).toEqual({ kind: 'fetch-cancel', runId: id });

    const repeat = setup();
    id = repeat.client.start('roster', repeat.requests, 'on-click')!;
    repeat.client.handle(repeat.itemMsg(id, 0));
    repeat.client.handle(repeat.itemMsg(id, 0));
    expect(repeat.client.state()).toMatchObject({ phase: 'failed', reason: 'out-of-order' });

    const late = setup();
    id = late.client.start('roster', late.requests, 'on-click')!;
    for (let i = 0; i < 3; i += 1) late.client.handle(late.itemMsg(id, i));
    late.client.handle(late.itemMsg(id, 3, { path: late.paths[0], finalPath: late.paths[0] }));
    expect(late.client.state()).toMatchObject({ phase: 'failed', reason: 'out-of-order' });
  });

  it('a body filed under the wrong path is refused: the item path must be the one this panel asked for', () => {
    const s = setup();
    const id = s.client.start('roster', s.requests, 'on-click')!;
    s.client.handle(s.itemMsg(id, 0, { path: s.paths[1], finalPath: s.paths[1] }));
    expect(s.client.state()).toMatchObject({ phase: 'failed', reason: 'wrong-path' });
  });

  it('stopped:null is not trusted when delivered disagrees with the items or with the request count', () => {
    const fewer = setup();
    let id = fewer.client.start('roster', fewer.requests, 'on-click')!;
    fewer.client.handle(fewer.itemMsg(id, 0));
    fewer.client.handle(fewer.endMsg(id, 1)); // one delivered, three asked
    expect(fewer.client.state()).toMatchObject({ phase: 'failed', reason: 'incomplete' });

    const lie = setup();
    id = lie.client.start('roster', lie.requests, 'on-click')!;
    lie.client.handle(lie.itemMsg(id, 0));
    lie.client.handle(lie.itemMsg(id, 1));
    lie.client.handle(lie.endMsg(id, 3)); // claims 3, two arrived
    expect(lie.client.state()).toMatchObject({ phase: 'failed', reason: 'incomplete' });

    const none = setup();
    id = none.client.start('roster', none.requests, 'on-click')!;
    none.client.handle(none.endMsg(id, 0));
    expect(none.client.state()).toMatchObject({ phase: 'failed', reason: 'incomplete' });
  });

  it('a stopped run is a failed run with no items, even after items arrived', () => {
    const s = setup();
    const id = s.client.start('roster', s.requests, 'on-click')!;
    s.client.handle(s.itemMsg(id, 0));
    s.client.handle(s.endMsg(id, 1, { reason: 'challenge', index: 1, status: 200, detail: 'Just a moment' }));
    const state = s.client.state();
    expect(state).toMatchObject({ phase: 'failed', reason: 'stopped' });
    expect('items' in state).toBe(false);
    expect(state.phase === 'failed' && state.detail).toContain('challenge');
    expect(state.phase === 'failed' && state.detail).toContain('Nothing was saved');
  });

  it('a port change before fetch-end is a failed run, and its late messages are ignored', () => {
    const s = setup();
    const id = s.client.start('roster', s.requests, 'on-click')!;
    s.client.handle(s.itemMsg(id, 0));
    s.client.portChanged();
    const failed = s.client.state();
    expect(failed).toMatchObject({ phase: 'failed', reason: 'port-lost' });
    for (let i = 1; i < 3; i += 1) s.client.handle(s.itemMsg(id, i));
    s.client.handle(s.endMsg(id, 3));
    expect(s.client.state()).toBe(failed);
    // With no run, a port change does nothing.
    const idle = setup();
    idle.client.portChanged();
    expect(idle.client.state()).toEqual({ phase: 'idle' });
  });

  it('a post that throws (no port) fails the run instead of leaving it waiting', () => {
    const client = createFetchRunClient<PlannedRosterRequest>({ post: () => { throw new Error('no port'); }, newRunId: () => 'r' });
    expect(client.start('roster', [req('58')], 'on-click')).toBeNull();
    expect(client.state()).toMatchObject({ phase: 'failed', reason: 'port-lost' });
  });
});

describe('the request plan', () => {
  const plan = (choice: Parameters<typeof planRosterRequests>[0]['choice'], seasons: Parameters<typeof planRosterRequests>[0]['seasons'] = parsedSeasons, teamIds: string[] = ['58', '48', '412']) =>
    planRosterRequests({ teamIds, gender: 'M', choice, seasons });

  it('"Simulator (current)": one server-current page per team, checked against the current label when known', () => {
    const p = plan({ kind: 'simulator-current' });
    if (!p.ok) throw new Error(p.reason);
    expect(p.requests.map((r) => fetchPathFor(r.target))).toEqual(['/team/58/roster/?gender=M', '/team/48/roster/?gender=M', '/team/412/roster/?gender=M']);
    expect(p.requests.every((r) => r.role === 'current-season' && r.expectedSeasonLabel === '2026-2027')).toBe(true);
    expect(p.estimateMs).toBe(6000);
    expect(describeRequests(3, p.estimateMs)).toBe('3 requests, about 6 s');
    const noList = plan({ kind: 'simulator-current' }, null);
    if (!noList.ok) throw new Error(noList.reason);
    expect(noList.requests.some((r) => r.expectedSeasonLabel !== undefined)).toBe(false);
  });

  it('the current season chosen by label is the same page, used for both roles', () => {
    const p = plan({ kind: 'season', label: '2026-2027' });
    if (!p.ok) throw new Error(p.reason);
    expect(p.requests).toHaveLength(3);
    expect(p.requests.every((r) => r.role === 'both')).toBe(true);
  });

  it('a past season: its page (id copied from the season list) plus the current page, per team', () => {
    const p = plan({ kind: 'season', label: '2025-2026' });
    if (!p.ok) throw new Error(p.reason);
    expect(p.requests.map((r) => fetchPathFor(r.target))).toEqual([
      '/team/58/roster/?page=1&gender=M&season_id=29&sort=name', '/team/58/roster/?gender=M',
      '/team/48/roster/?page=1&gender=M&season_id=29&sort=name', '/team/48/roster/?gender=M',
      '/team/412/roster/?page=1&gender=M&season_id=29&sort=name', '/team/412/roster/?gender=M',
    ]);
    expect(p.requests.map((r) => r.role)).toEqual(['chosen-season', 'current-season', 'chosen-season', 'current-season', 'chosen-season', 'current-season']);
    expect(p.requests[0]!.target.season).toEqual({ kind: 'option', value: '29', label: '2025-2026' });
    expect(p.estimateMs).toBe(15000);
  });

  it('refuses instead of guessing: no season list, a label the list lacks, no team, a duplicate team, an id that is not a plain number', () => {
    expect(plan({ kind: 'season', label: '2025-2026' }, null)).toMatchObject({ ok: false });
    expect(plan({ kind: 'season', label: '2031-2032' })).toMatchObject({ ok: false });
    expect(plan({ kind: 'simulator-current' }, parsedSeasons, [])).toMatchObject({ ok: false });
    expect(plan({ kind: 'simulator-current' }, parsedSeasons, ['58', '58'])).toMatchObject({ ok: false });
    expect(plan({ kind: 'simulator-current' }, parsedSeasons, ['T58'])).toMatchObject({ ok: false });
  });
});

// ---- saving a finished run -------------------------------------------------------------------------------------------------------------

async function newRepo() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('install') });
  return createStorageRepo(db, { now: steppingClock() });
}
const item58 = (body: string, over: Partial<{ request: PlannedRosterRequest; path: string; finalPath: string; contentType: string }> = {}) => {
  const request: PlannedRosterRequest = over.request ?? { target: { kind: 'team-roster', teamId: '58', gender: 'M', season: { kind: 'option', value: '29', label: '2025-2026' } }, role: 'chosen-season' };
  const p = fetchPathFor(request.target);
  return { index: 0, request, path: over.path ?? p, finalPath: over.finalPath ?? p, contentType: over.contentType ?? 'text/html; charset=utf-8', body, fetchedAt: AT };
};
const spyOn = (repo: Awaited<ReturnType<typeof newRepo>>) => { const putCache = vi.spyOn(repo, 'putCache'); return putCache; };

describe('saving a finished run (acceptance g)', () => {
  it('writes a members roster with its class years, the requested URL and the parser (real 58 men, 2025-2026)', async () => {
    const repo = await newRepo();
    const reports = await saveRosterRun([item58(M58)], repo);
    expect(reports[0]!.status).toMatchObject({ kind: 'saved', seasonLabel: '2025-2026', members: 35, withClassYear: 35 });
    const state = await readRosterState(repo, { teamId: toSwimCloudId('58'), seasonId: '2025-2026', gender: 'Men' });
    if (state.state !== 'members') throw new Error(state.state);
    expect(state.record.memberIds).toHaveLength(35);
    expect(state.record.classYears?.['2352628']).toBe('FR');
    expect(state.record.sourceUrl).toBe('https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=29&sort=name');
    expect(state.record.fetchedAt).toBe(AT);
    expect(state.record.parser).toEqual({ name: 'readRosterFetch', confidence: 'real-capture-verified' });
    expect(Object.values(state.record.classYears ?? {})).not.toContain('unknown');
  });

  it('writes the UWF "No rosters found" page as verified-empty', async () => {
    const repo = await newRepo();
    const request: PlannedRosterRequest = { target: { kind: 'team-roster', teamId: '10002824', gender: 'M', season: { kind: 'option', value: '29', label: '2025-2026' } }, role: 'chosen-season' };
    const reports = await saveRosterRun([item58(page('swimcloud/team-10002824-roster-gender-M-page.html'), { request })], repo);
    expect(reports[0]!.status).toMatchObject({ kind: 'saved-empty' });
    const state = await readRosterState(repo, { teamId: toSwimCloudId('10002824'), seasonId: '2025-2026', gender: 'Men' });
    expect(state.state).toBe('verified-empty');
  });

  it('T-R3: every refusal writes nothing (zero putCache) and keeps the earlier record', async () => {
    const repo = await newRepo();
    await saveRosterRun([item58(M58)], repo);
    const key = { teamId: toSwimCloudId('58'), seasonId: '2025-2026', gender: 'Men' as const };
    const before = await readRosterState(repo, key);
    expect(before.state).toBe('members');
    const spy = spyOn(repo);
    const tamper = (from: string | RegExp, to: string): string => { const out = M58.replace(from, to); expect(out).not.toBe(M58); return out; };
    const refusals: [string, ReturnType<typeof item58>][] = [
      ['unmapped class word', item58(tamper(/(href="\/swimmer\/2352628">[^<]*<\/a><\/td><td[^>]*>[^<]*<\/td><td[^>]*>)FR/, '$15Y'))],
      ['missing athlete link', item58(tamper('<a class="u-text-semi" href="/swimmer/2352628">Bartu Akin</a>', 'Bartu Akin'))],
      ['no Class column (architect ruling 4)', item58(tamper('<th class="c-table-clean__col-fit">Class</th>', ''))],
      ['duplicate id', item58(tamper('href="/swimmer/1130590">', 'href="/swimmer/2352628">'))],
      ['page=2 link', item58(tamper('</tbody>', '</tbody><a href="?page=2">2</a>'))],
      ['heading season mismatch', item58(tamper('Season 2025-2026 Men', 'Season 2024-2025 Men'))],
      ['heading gender mismatch', item58(tamper('Season 2025-2026 Men', 'Season 2025-2026 Women'))],
      ['redirected', item58(M58, { finalPath: '/team/58/roster/?gender=M' })],
      ['selected season is not the target', item58(M58, { request: { target: { kind: 'team-roster', teamId: '58', gender: 'M', season: { kind: 'option', value: '30', label: '2026-2027' } }, role: 'chosen-season' } })],
      ['a challenge page', item58('<html><head><title>Just a moment...</title></head></html>')],
      ['a JSON content type', item58(M58, { contentType: 'application/json' })],
      ['an empty body', item58('')],
    ];
    for (const [name, it2] of refusals) {
      const reports = await saveRosterRun([it2], repo);
      expect(reports[0]!.status.kind, name).toBe('refused');
      if (name.startsWith('no Class column')) expect(reports[0]!.status).toMatchObject({ kind: 'refused', code: 'class-column-missing' });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await readRosterState(repo, key)).toEqual(before);
  });

  it('judges each page on its own: one refused team does not discard another team\'s roster (SYNTHETIC reuse of the 412 page under team 412)', async () => {
    const repo = await newRepo();
    const bad = M58.replace(/(href="\/swimmer\/2352628">[^<]*<\/a><\/td><td[^>]*>[^<]*<\/td><td[^>]*>)FR/, '$15Y');
    const r412: PlannedRosterRequest = { target: { kind: 'team-roster', teamId: '412', gender: 'M', season: { kind: 'option', value: '29', label: '2025-2026' } }, role: 'chosen-season' };
    const spy = spyOn(repo);
    const reports = await saveRosterRun([item58(bad), { ...item58(page('swimcloud/team-412-roster-gender-M-page.html'), { request: r412 }), index: 1 }], repo);
    expect(reports.map((r) => r.status.kind)).toEqual(['refused', 'saved']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await readRosterState(repo, { teamId: toSwimCloudId('58'), seasonId: '2025-2026', gender: 'Men' })).state).toBe('not-loaded');
    expect((await readRosterState(repo, { teamId: toSwimCloudId('412'), seasonId: '2025-2026', gender: 'Men' })).state).toBe('members');
  });

  it('a record the store would reject is reported, not thrown, and nothing is stored (write-failed)', async () => {
    const repo = await newRepo();
    vi.spyOn(repo, 'putCache').mockRejectedValue(new Error('disk full'));
    const reports = await saveRosterRun([item58(M58)], repo);
    expect(reports[0]!.status).toEqual({ kind: 'write-failed', detail: 'disk full' });
  });

  it('rosterRecordFor never carries the parser\'s "unknown" class', () => {
    const record = rosterRecordFor({ kind: 'members', teamId: '58', seasonLabel: '2025-2026', gender: 'Men', memberIds: ['1', '2'], classYears: { '1': 'FR' }, parser: { name: 'readRosterFetch', confidence: 'real-capture-verified' } }, { path: '/team/58/roster/?gender=M', fetchedAt: AT });
    expect(record.classYears).toEqual({ '1': 'FR' });
    expect(JSON.stringify(record)).not.toContain('unknown');
  });
});

describe('the flow: a failed run writes nothing (acceptance d)', () => {
  it('a port reconnect after items but before fetch-end fails the run, and the late items and fetch-end save nothing', async () => {
    const repo = await newRepo();
    const spy = spyOn(repo);
    const posted: { kind: string; runId: string; targets?: readonly RosterTarget[] }[] = [];
    const flow = createRosterFlow({ post: (m) => void posted.push(m as never), newRunId: () => 'run-a', repo: async () => repo });
    flow.setSeasons(parsedSeasons);
    const plan = flow.fetchRosters({ teamIds: ['58', '48'], gender: 'M', choice: { kind: 'simulator-current' }, posture: 'on-click' });
    expect(plan.ok).toBe(true);
    expect(posted).toHaveLength(1);
    const targets = posted[0]!.targets!;
    const msg = (index: number): FetchOverlayMessage => parseFetchItem({ kind: 'fetch-item', runId: 'run-a', index, path: fetchPathFor(targets[index]!), finalPath: fetchPathFor(targets[index]!), contentType: 'text/html', body: M58, fetchedAt: AT })!;
    flow.handle(msg(0));
    flow.portChanged(); // the overlay reconnected
    flow.handle(msg(1));
    flow.handle(parseFetchEnd({ kind: 'fetch-end', runId: 'run-a', delivered: 2, stopped: null })!);
    await new Promise((r) => setTimeout(r, 10));
    expect(flow.client.state()).toMatchObject({ phase: 'failed', reason: 'port-lost' });
    expect(flow.save()).toEqual({ kind: 'none' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('with posture off the flow posts nothing and starts nothing', () => {
    const posted: unknown[] = [];
    const flow = createRosterFlow({ post: (m) => void posted.push(m), newRunId: () => 'r', repo: async () => { throw new Error('no repo'); } });
    flow.fetchRosters({ teamIds: ['58'], gender: 'M', choice: { kind: 'simulator-current' }, posture: 'off' });
    expect(posted).toEqual([]);
    expect(flow.client.state()).toMatchObject({ phase: 'failed', reason: 'posture-off' });
  });

  it('a finished run is saved once', async () => {
    const repo = await newRepo();
    const spy = spyOn(repo);
    const posted: { targets?: readonly RosterTarget[] }[] = [];
    const flow = createRosterFlow({ post: (m) => void posted.push(m as never), newRunId: () => 'run-b', repo: async () => repo });
    flow.setSeasons(parsedSeasons);
    flow.fetchRosters({ teamIds: ['58'], gender: 'M', choice: { kind: 'season', label: '2025-2026' }, posture: 'on-click' });
    const targets = posted[0]!.targets!;
    expect(targets.map((t) => fetchPathFor(t))).toEqual(['/team/58/roster/?page=1&gender=M&season_id=29&sort=name', '/team/58/roster/?gender=M']);
    // Item 0 is the real 2025-2026 page. Item 1 asks for the current season (2026-2027) and gets the same 2025-2026 page: it must be refused.
    for (const [i, t] of targets.entries()) flow.handle(parseFetchItem({ kind: 'fetch-item', runId: 'run-b', index: i, path: fetchPathFor(t), finalPath: fetchPathFor(t), contentType: 'text/html', body: M58, fetchedAt: AT })!);
    flow.handle(parseFetchEnd({ kind: 'fetch-end', runId: 'run-b', delivered: 2, stopped: null })!);
    await vi.waitFor(() => expect(flow.save().kind).toBe('saved'));
    const save = flow.save();
    if (save.kind !== 'saved') throw new Error(save.kind);
    expect(save.reports.map((r) => r.status.kind)).toEqual(['saved', 'refused']);
    expect(save.reports[1]!.status).toMatchObject({ code: 'season-mismatch' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('the season list reaches the panel (acceptance a)', () => {
  class Port implements PanelPort {
    sent: unknown[] = [];
    messages: ((m: unknown) => void)[] = [];
    disconnected: (() => void)[] = [];
    postMessage(m: unknown) { this.sent.push(m); }
    disconnect() {}
    onMessage = { addListener: (cb: (m: unknown) => void) => this.messages.push(cb) };
    onDisconnect = { addListener: (cb: () => void) => this.disconnected.push(cb) };
  }
  const setup = () => {
    vi.useFakeTimers();
    const win = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/' });
    const host = mountShadowHost(win.document as unknown as Document);
    const ports: Port[] = [];
    const runtime: PanelRuntime = { getURL: (p) => `chrome-extension://abc/${p}`, connect: () => { const p = new Port(); ports.push(p); return p; } };
    const panel = mountDockedPanel(host, runtime, { retryDelayMs: 5 });
    return { win, panel, ports };
  };

  it('is sent when it arrives after connect, and again on the next connect; a bad list is never sent', async () => {
    const { win, panel, ports } = setup();
    try {
      panel.iframe.dispatchEvent(new win.Event('load') as unknown as Event);
      panel.sendSeasons(parsedSeasons);
      expect(ports[0]!.sent.filter((m) => (m as { kind?: string }).kind === 'seasons-state')).toHaveLength(1);
      ports[0]!.disconnected.forEach((cb) => cb());
      await vi.advanceTimersByTimeAsync(5);
      expect(ports).toHaveLength(2);
      const resent = ports[1]!.sent.find((m) => (m as { kind?: string }).kind === 'seasons-state');
      expect(parseSeasonsState(resent)).toMatchObject({ ok: true });
      expect((resent as { seasons: unknown[] }).seasons).toHaveLength(10);
      // A list with no current season is not sent.
      const before = ports[1]!.sent.length;
      panel.sendSeasons({ ok: true, seasons: parsedSeasons.seasons.map((s) => ({ ...s, isCurrent: false })), current: parsedSeasons.current });
      expect(ports[1]!.sent.length).toBe(before);
    } finally { vi.useRealTimers(); await win.happyDOM.close(); }
  });

  it('is sent when it arrived before the first connect', async () => {
    const { win, panel, ports } = setup();
    try {
      panel.sendSeasons(parsedSeasons);
      panel.iframe.dispatchEvent(new win.Event('load') as unknown as Event);
      expect(ports[0]!.sent.some((m) => (m as { kind?: string }).kind === 'seasons-state')).toBe(true);
    } finally { vi.useRealTimers(); await win.happyDOM.close(); }
  });

  it('the panel\'s port listener hands on only guarded run messages and checked season lists', () => {
    const onConnect: ((port: never) => void)[] = [];
    const nonce = 'a'.repeat(32);
    const seen: { fetch: unknown[]; seasons: unknown[] } = { fetch: [], seasons: [] };
    listenForPanelPort({ onConnect: { addListener: (cb) => void onConnect.push(cb as never) } }, nonce, undefined, undefined, undefined, undefined, undefined,
      { onFetchMessage: (m) => void seen.fetch.push(m), onSeasons: (s) => void seen.seasons.push(s) });
    const listeners: ((m: unknown) => void)[] = [];
    onConnect[0]!({ name: `osx-panel:${nonce}`, postMessage: () => undefined, onMessage: { addListener: (cb: (m: unknown) => void) => void listeners.push(cb) } } as never);
    const deliver = (m: unknown): void => listeners.forEach((l) => l(m));
    deliver({ kind: 'fetch-end', runId: 'r', delivered: 1, stopped: null });
    deliver({ kind: 'fetch-end', runId: 'r', delivered: -1, stopped: null });
    deliver({ kind: 'fetch-item', runId: 'r' });
    deliver({ kind: 'seasons-state', seasons: SEASON_ROWS });
    deliver({ kind: 'seasons-state', seasons: SEASON_ROWS.map((s) => ({ ...s, isCurrent: false })) });
    expect(seen.fetch).toHaveLength(1);
    expect(seen.seasons).toHaveLength(1);
  });

  it('overlay/main.ts passes the season callback (6th argument) to startOverlay and it calls panel.sendSeasons', () => {
    const text = readFileSync(path.join(process.cwd(), 'apps', 'extension', 'src', 'overlay', 'main.ts'), 'utf8');
    const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.ES2022, true);
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'startOverlay') calls.push(n); ts.forEachChild(n, visit); };
    visit(source);
    expect(calls).toHaveLength(1);
    const sixth = calls[0]!.arguments[5];
    expect(sixth, 'startOverlay gets no 6th argument').toBeDefined();
    expect(sixth!.getText(source)).toContain('panel.sendSeasons');
  });
});

describe('dashboard/main.tsx wiring (acceptance a, c, d)', () => {
  const text = readFileSync(path.join(process.cwd(), 'apps', 'extension', 'src', 'dashboard', 'main.tsx'), 'utf8');
  const source = ts.createSourceFile('main.tsx', text, ts.ScriptTarget.ES2022, true);
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'listenForPanelPort') calls.push(n); ts.forEachChild(n, visit); };
  visit(source);

  it('listenForPanelPort passes the run client a port-change signal on a new port and on a closed live port, and the guarded messages', () => {
    expect(calls).toHaveLength(1);
    const args = calls[0]!.arguments.map((a) => a.getText(source));
    expect(args[4], 'onPort').toContain('rosterFlow.portChanged()');
    expect(args[6], 'onPortClosed').toContain('rosterFlow.portChanged()');
    expect(args[7], 'extras').toContain('rosterFlow.handle(');
    expect(args[7], 'extras').toContain('rosterFlow.setSeasons(');
  });

  it('the docked panel has a Rosters tab that gets the flow and the repo', () => {
    expect(text).toMatch(/id: 'rosters', label: 'Rosters'.*<RosterTab snapshot=\{scored\.snapshot\} flow=\{rosterFlow\}/);
  });

  it('the run message is posted on the live port and throws when there is none, so a lost message cannot leave a run waiting', () => {
    expect(text).toMatch(/createRosterFlow\(\{\s*post: \(message\) => \{\s*if \(!latestPanelPort\) throw new Error/);
  });
});
