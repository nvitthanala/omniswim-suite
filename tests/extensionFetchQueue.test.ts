/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P4.0 (D7 section 3), tests T-Q 1 to 6 for the fetch queue and its protocol, with a fake `fetch`,
 * `sleep`, `now` and Web Lock. Nothing here touches the network or a real clock.
 *
 * Fixtures. "Delivered" pages are the real captures `swimcloud-real-team-roster-58-gender-m.html` (Henderson
 * State men, season 2025-2026) and `swimcloud/team-10002824-roster-gender-M-page.html` (the UWF empty state).
 * Challenge pages are SYNTHETIC: no real Cloudflare challenge page is archived, so each one is built here
 * from the markers the stop-rule table names. The "real roster + real invisible-check snippet" page splices
 * the one-line loader out of the real capture `swimcloud-real-conference-nsisc.html` into the real roster.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFetchResponse, newFetchPacer, parseRetryAfterMs, runFetchQueue } from '../apps/extension/src/overlay/fetchQueue';
import type { FetchPacer, FetchQueueDeps, FetchResponseView, FetchedResponse } from '../apps/extension/src/overlay/fetchQueue';
import {
  FETCH_BASE_BACKOFF_MS, FETCH_LOCK_NAME, FETCH_MAX_BACKOFF_MS, FETCH_MAX_RETRIES, FETCH_MIN_DELAY_MS,
  fetchPathFor, runEstimateMs, targetForPath,
} from '../apps/extension/src/shared/fetchProtocol';
import type { FetchTarget, RosterTarget, TeamWindowTarget } from '../apps/extension/src/shared/fetchProtocol';
import type { FetchEndMessage, FetchItemMessage, FetchProgressMessage } from '../apps/extension/src/shared/panelProtocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(here, 'fixtures', rel), 'utf8');
const REAL_ROSTER = read('swimcloud-real-team-roster-58-gender-m.html');
const UWF_EMPTY = read('swimcloud/team-10002824-roster-gender-M-page.html');
const NSISC_REAL = read('swimcloud-real-conference-nsisc.html');

const ORIGIN = 'https://www.swimcloud.com';
const T0 = 1_800_000_000_000;

const roster = (teamId = '58', gender: 'M' | 'F' = 'M'): RosterTarget => ({ kind: 'team-roster', teamId, gender, season: { kind: 'server-current' } });
const rosterSeason = (value: string): RosterTarget => ({ kind: 'team-roster', teamId: '58', gender: 'M', season: { kind: 'option', value, label: '2024-2025' } });
const win = (course: 'Y' | 'L' = 'L'): TeamWindowTarget => ({ kind: 'team-window', teamId: '58', gender: 'M', course, from: '2025-09-01', to: '2026-08-31', timeToUse: 'fastest' });

// ---- fakes ---------------------------------------------------------------------------------------------------

type Reply = (requestPath: string) => FetchedResponse | Error;
/** Script entries that never answer. `HANG` rejects when the request's signal aborts, as a real fetch does. `HANG_DEAF` ignores the signal. */
const HANG = Symbol('hang');
const HANG_DEAF = Symbol('hang-deaf');
type Step = Reply | typeof HANG | typeof HANG_DEAF;
interface ReplyOptions { readonly headers?: Record<string, string>; readonly url?: (requestPath: string) => string }

function reply(status: number, body: string, opts: ReplyOptions = {}): Reply {
  return (p) => ({
    status,
    url: opts.url ? opts.url(p) : new URL(p, ORIGIN).href,
    headers: new Headers(opts.headers ?? {}),
    text: () => Promise.resolve(body),
  });
}
const html = (body: string, opts: ReplyOptions = {}): Reply => reply(200, body, { ...opts, headers: { 'content-type': 'text/html; charset=utf-8', ...opts.headers } });
const json = (body: unknown, opts: ReplyOptions = {}): Reply => reply(200, JSON.stringify(body), { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } });
const WINDOW_OK = { swimmers: [], relays: [] };

interface Env {
  readonly deps: FetchQueueDeps;
  readonly posted: Array<FetchProgressMessage | FetchItemMessage | FetchEndMessage>;
  readonly calls: Array<{ path: string; init: RequestInit; at: number }>;
  readonly sleeps: number[];
  readonly lockCalls: Array<{ name: string; options: unknown }>;
  /** The clock reading each time the lock callback finished, so a test sees when the lock was let go. */
  readonly releasedAt: number[];
  /** Sleeps made after the run's fetch-end: the wait that keeps the lock until the pacing gap is over. */
  readonly holdSleeps: number[];
  readonly pacer: FetchPacer;
  readonly clock: { now: number };
  readonly items: () => FetchItemMessage[];
  readonly end: () => FetchEndMessage;
  /** Start-to-start gaps between calls. */
  readonly gaps: () => number[];
}

/** `latencyMs` is how long each fake response takes to arrive. */
function makeEnv(script: Step[], opts: { latencyMs?: number; locks?: 'free' | 'held' | 'none' | 'throws'; onSleep?: (ms: number) => void; pacer?: FetchPacer; clock?: { now: number } } = {}): Env {
  const clock = opts.clock ?? { now: T0 };
  const pacer = opts.pacer ?? newFetchPacer();
  const releasedAt: number[] = [];
  const holdSleeps: number[] = [];
  const posted: Env['posted'] = [];
  const calls: Env['calls'] = [];
  const sleeps: number[] = [];
  const lockCalls: Env['lockCalls'] = [];
  const queue = [...script];
  const mode = opts.locks ?? 'free';
  const deps: FetchQueueDeps = {
    fetch: async (input, init) => {
      calls.push({ path: input, init, at: clock.now });
      clock.now += opts.latencyMs ?? 0;
      const next = queue.shift();
      if (!next) throw new Error(`the script ran out at call ${calls.length}: ${input}`);
      if (next === HANG_DEAF) return new Promise<never>(() => undefined);
      if (next === HANG) return new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true }));
      const out = next(input);
      if (out instanceof Error) throw out;
      return out;
    },
    sleep: (ms) => {
      (posted.some((m) => m.kind === 'fetch-end') ? holdSleeps : sleeps).push(ms);
      clock.now += ms;
      opts.onSleep?.(ms);
      return Promise.resolve();
    },
    now: () => clock.now,
    wallNow: () => clock.now,
    pacer,
    origin: ORIGIN,
    locks:
      mode === 'none'
        ? undefined
        : {
            request: async (name, options, callback) => {
              lockCalls.push({ name, options });
              if (mode === 'throws') throw new Error('locks are not allowed here');
              try {
                return await callback(mode === 'held' ? null : {});
              } finally {
                releasedAt.push(clock.now);
              }
            },
          },
    post: (m) => { posted.push(m); },
  };
  return {
    deps, posted, calls, sleeps, lockCalls, releasedAt, holdSleeps, pacer, clock,
    items: () => posted.filter((m): m is FetchItemMessage => m.kind === 'fetch-item'),
    end: () => {
      const ends = posted.filter((m): m is FetchEndMessage => m.kind === 'fetch-end');
      expect(ends, 'exactly one fetch-end per run').toHaveLength(1);
      return ends[0]!;
    },
    gaps: () => calls.slice(1).map((c, i) => c.at - calls[i]!.at),
  };
}

const run = (env: Env, targets: FetchTarget[], signal = new AbortController().signal) => runFetchQueue({ runId: 'r1', feature: 'roster', targets }, env.deps, signal);

// ---- constants and paths --------------------------------------------------------------------------------------

describe('fetch protocol constants and paths (D7 section 3)', () => {
  it('copies the legacy constants and the estimate', () => {
    expect([FETCH_MIN_DELAY_MS, FETCH_MAX_RETRIES, FETCH_BASE_BACKOFF_MS, FETCH_MAX_BACKOFF_MS]).toStrictEqual([3000, 3, 3000, 60000]);
    expect(FETCH_LOCK_NAME).toBe('omniswim-swimcloud-fetch');
    expect([0, 1, 2, 6].map(runEstimateMs)).toStrictEqual([0, 0, 3000, 15000]);
  });

  it('builds the three paths exactly as recon item 5 and crawlPlan.ts spell them', () => {
    expect(fetchPathFor(win('L'))).toBe('/api/teams/58/simulator/?start_date=2025-09-01&end_date=2026-08-31&eventgender=M&eventcourse=L&divecourse=6&time_to_use=fastest');
    expect(fetchPathFor(roster('58', 'F'))).toBe('/team/58/roster/?gender=F');
    expect(fetchPathFor(rosterSeason('28'))).toBe('/team/58/roster/?page=1&gender=M&season_id=28&sort=name');
  });

  it('targetForPath inverts fetchPathFor and returns null for anything else', () => {
    for (const t of [win('Y'), win('L'), roster(), roster('412', 'F'), rosterSeason('29')]) {
      const back = targetForPath(fetchPathFor(t));
      expect(back, JSON.stringify(t)).not.toBeNull();
      expect(fetchPathFor(back!)).toBe(fetchPathFor(t));
    }
    expect(targetForPath(fetchPathFor(win()))).toStrictEqual(win());
    // The path does not carry the season label, so the inverse reports ''.
    expect(targetForPath('/team/58/roster/?page=1&gender=M&season_id=28&sort=name')).toStrictEqual({ kind: 'team-roster', teamId: '58', gender: 'M', season: { kind: 'option', value: '28', label: '' } });
    for (const other of [
      '', '/', '/team/58/', '/team/58/roster/', '/team/58/roster/?gender=X', '/team/058/roster/?gender=M',
      '/team/58/roster/?gender=M&extra=1', '/team/58/roster/?gender=M&page=1', '/team/58/roster/?gender=M#x',
      '/team/58/roster/?page=1&gender=M&season_id=a%26b&sort=name', '/team/58/roster/?page=1&gender=M&season_id=&sort=name',
      '//evil.example/team/58/roster/?gender=M', 'https://www.swimcloud.com/team/58/roster/?gender=M',
      '/api/teams/58/simulator/?start_date=2025-09-01&end_date=2026-08-31&eventgender=M&eventcourse=S&divecourse=6&time_to_use=fastest',
      '/api/teams/58/simulator/?end_date=2026-08-31&start_date=2025-09-01&eventgender=M&eventcourse=L&divecourse=6&time_to_use=fastest',
      '/api/teams/58/simulator/?start_date=2025-09-01&end_date=2026-08-31&eventgender=M&eventcourse=L&divecourse=5&time_to_use=fastest',
      '/api/teams/58/simulator/?start_date=2025-9-1&end_date=2026-08-31&eventgender=M&eventcourse=L&divecourse=6&time_to_use=fastest',
      '/api/swimmers/1/profile_fastest_times/', '/api/seasonchoices/',
    ]) expect(targetForPath(other), other).toBeNull();
  });

  it('fetchPathFor throws on a field that is not a plain token', () => {
    expect(() => fetchPathFor({ ...roster(), teamId: '58/../9' })).toThrow(RangeError);
    expect(() => fetchPathFor({ ...roster(), gender: 'X' as 'M' })).toThrow(RangeError);
    expect(() => fetchPathFor(rosterSeason('1&team=9'))).toThrow(RangeError);
    expect(() => fetchPathFor(rosterSeason(''))).toThrow(RangeError);
    expect(() => fetchPathFor({ ...win(), course: 'S' as 'Y' })).toThrow(RangeError);
    expect(() => fetchPathFor({ ...win(), from: '2025-13-45' })).toThrow(RangeError);
    expect(() => fetchPathFor({ ...win(), to: '2026-02-30' })).toThrow(RangeError);
    expect(() => fetchPathFor({ ...win(), to: '2024-02-29' })).not.toThrow();
    expect(() => fetchPathFor({ ...win(), timeToUse: 'best' as 'fastest' })).toThrow(RangeError);
  });
});

// ---- T-Q 1: pacing --------------------------------------------------------------------------------------------

describe('T-Q 1: every request starts exactly 3000 ms after the previous one started, never earlier', () => {
  it('is measured from the previous START, not its end: slow responses add nothing, fast ones wait out the floor', () => {
    return (async () => {
      const fast = makeEnv([html(REAL_ROSTER), html(REAL_ROSTER), html(REAL_ROSTER)], { latencyMs: 1000 });
      await run(fast, [roster('58'), roster('48'), roster('412')]);
      expect(fast.gaps()).toStrictEqual([3000, 3000]);
      expect(fast.sleeps, 'it waits only the 2000 ms the response did not already use').toStrictEqual([2000, 2000]);

      const slow = makeEnv([html(REAL_ROSTER), html(REAL_ROSTER), html(REAL_ROSTER)], { latencyMs: 4000 });
      await run(slow, [roster('58'), roster('48'), roster('412')]);
      expect(slow.gaps(), 'a response slower than the floor adds no extra wait').toStrictEqual([4000, 4000]);
      expect(slow.sleeps).toStrictEqual([]);
      expect(fast.end()).toMatchObject({ delivered: 3, stopped: null });
    })();
  });

  it('applies to retries too: a 429 retry starts at least 3000 ms after the request it retries', async () => {
    const env = makeEnv([reply(429, ''), reply(429, '', { headers: { 'retry-after': '1' } }), html(REAL_ROSTER)], { latencyMs: 500 });
    await run(env, [roster()]);
    // Backoff 3000 after the first 429 arrives at +500, so the retry starts 3500 after the first start. A one-second Retry-After is raised to the floor.
    expect(env.gaps()).toStrictEqual([3500, 3500]);
    expect(env.end()).toMatchObject({ delivered: 1, stopped: null });
  });

  it('sends a plain GET with no custom headers, no body, and nothing but the four spec options and the abort signal', async () => {
    const env = makeEnv([html(REAL_ROSTER)]);
    await run(env, [roster()]);
    expect(env.calls[0]!.path).toBe('/team/58/roster/?gender=M');
    const ac = new AbortController();
    const env2 = makeEnv([html(REAL_ROSTER)]);
    await run(env2, [roster()], ac.signal);
    // The four spec options plus the run's own abort signal, so a cancel reaches a request in flight. No headers, no body.
    expect(env.calls[0]!.init).toStrictEqual({ method: 'GET', credentials: 'same-origin', redirect: 'follow', cache: 'default', signal: expect.any(AbortSignal) });
    expect(env2.calls[0]!.init.signal).toBe(ac.signal);
  });

  it('posts a progress message before each request with the wait and the reason', async () => {
    const env = makeEnv([html(REAL_ROSTER), reply(429, ''), html(REAL_ROSTER)], { latencyMs: 1000 });
    await run(env, [roster('58'), roster('48')]);
    expect(env.posted.filter((m) => m.kind === 'fetch-progress')).toStrictEqual([
      { kind: 'fetch-progress', runId: 'r1', index: 0, waitMs: 0, why: 'start' },
      { kind: 'fetch-progress', runId: 'r1', index: 1, waitMs: 2000, why: 'pacing' },
      { kind: 'fetch-progress', runId: 'r1', index: 1, waitMs: 3000, why: 'rate-limited' },
    ]);
  });
});

// ---- T-Q 2: 403 -----------------------------------------------------------------------------------------------

describe('T-Q 2: a 403 stops the whole run', () => {
  it('stops with reason forbidden, delivers what came before, and never fetches later targets', async () => {
    const env = makeEnv([html(REAL_ROSTER), reply(403, 'Forbidden'), html(REAL_ROSTER)]);
    await run(env, [roster('58'), roster('48'), roster('412')]);
    expect(env.calls.map((c) => c.path)).toStrictEqual(['/team/58/roster/?gender=M', '/team/48/roster/?gender=M']);
    expect(env.end()).toStrictEqual({ kind: 'fetch-end', runId: 'r1', delivered: 1, stopped: { reason: 'forbidden', index: 1, status: 403, detail: expect.any(String) } });
    expect(env.items().map((i) => i.index)).toStrictEqual([0]);
  });

  it('is never retried, even with a Retry-After', async () => {
    const env = makeEnv([reply(403, '', { headers: { 'retry-after': '1' } }), html(REAL_ROSTER)]);
    await run(env, [roster()]);
    expect(env.calls).toHaveLength(1);
    expect(env.end().stopped?.reason).toBe('forbidden');
  });

  it('a 403 that carries cf-mitigated: challenge is a challenge (architect ruling 2026-11-05: the header is checked first)', async () => {
    const v = classifyFetchResponse(roster(), view({ status: 403, headers: { 'cf-mitigated': 'challenge' } }), T0, 0);
    expect(v).toMatchObject({ kind: 'stop', reason: 'challenge', status: 403 });
    const env = makeEnv([reply(403, 'Just a moment...', { headers: { 'cf-mitigated': 'challenge' } }), html(REAL_ROSTER)]);
    await run(env, [roster('58'), roster('48')]);
    expect(env.calls).toHaveLength(1);
    expect(env.end().stopped).toMatchObject({ reason: 'challenge', status: 403, index: 0 });
  });
});

// ---- T-Q 3: 429 -----------------------------------------------------------------------------------------------

describe('T-Q 3: 429 handling', () => {
  it('waits the Retry-After seconds, then goes on', async () => {
    const env = makeEnv([reply(429, '', { headers: { 'retry-after': '7' } }), html(REAL_ROSTER)]);
    await run(env, [roster()]);
    expect(env.sleeps).toStrictEqual([7000]);
    expect(env.gaps()).toStrictEqual([7000]);
    expect(env.items()).toHaveLength(1);
    expect(env.end()).toMatchObject({ delivered: 1, stopped: null });
  });

  it('backs off 3000, 6000, 12000 with no header, delivers on the third retry, and stops on the fourth 429', async () => {
    const ok = makeEnv([reply(429, ''), reply(429, ''), reply(429, ''), html(REAL_ROSTER)]);
    await run(ok, [roster()]);
    expect(ok.sleeps).toStrictEqual([3000, 6000, 12000]);
    expect(ok.end()).toMatchObject({ delivered: 1, stopped: null });

    const bad = makeEnv([reply(429, ''), reply(429, ''), reply(429, ''), reply(429, ''), html(REAL_ROSTER)]);
    await run(bad, [roster('58'), roster('48')]);
    expect(bad.calls, 'the fourth 429 stops the run; the fifth reply and the second target are never used').toHaveLength(4);
    expect(bad.sleeps).toStrictEqual([3000, 6000, 12000]);
    expect(bad.end()).toStrictEqual({ kind: 'fetch-end', runId: 'r1', delivered: 0, stopped: { reason: 'rate-limited', index: 0, status: 429, detail: expect.any(String) } });
  });

  it('keeps the retry count per target and starts the next target at attempt zero', async () => {
    const env = makeEnv([reply(429, ''), html(REAL_ROSTER), reply(429, ''), html(REAL_ROSTER)]);
    await run(env, [roster('58'), roster('48')]);
    expect(env.sleeps).toStrictEqual([3000, 3000, 3000]); // retry, pacing before target 2, retry (3000 each, never 6000)
    expect(env.end()).toMatchObject({ delivered: 2, stopped: null });
  });

  it('stops when Retry-After is over the 60 s cap (legacy rateLimitBackoff.ts:139-145) and honours exactly 60 s', async () => {
    const over = makeEnv([reply(429, '', { headers: { 'retry-after': '61' } }), html(REAL_ROSTER)]);
    await run(over, [roster()]);
    expect(over.calls).toHaveLength(1);
    expect(over.end().stopped?.reason).toBe('rate-limited');
    const exact = makeEnv([reply(429, '', { headers: { 'retry-after': '60' } }), html(REAL_ROSTER)]);
    await run(exact, [roster()]);
    expect(exact.sleeps).toStrictEqual([60000]);
  });

  it('reads Retry-After as an HTTP date, and falls back to backoff for a value it cannot read', () => {
    expect(parseRetryAfterMs('7', T0)).toBe(7000);
    expect(parseRetryAfterMs(new Date(T0 + 9000).toUTCString(), T0)).toBe(9000);
    expect(parseRetryAfterMs(new Date(T0 - 9000).toUTCString(), T0)).toBe(0);
    for (const bad of [null, undefined, '', '  ', '1.5', '-3', 'soon']) expect(parseRetryAfterMs(bad, T0), String(bad)).toBeUndefined();
    expect(classifyFetchResponse(roster(), view({ status: 429, headers: { 'retry-after': '1.5' } }), T0, 1)).toMatchObject({ kind: 'retry', waitMs: 6000 });
  });
});

// ---- T-Q 4: challenges and deliveries -------------------------------------------------------------------------

/** A response view with sane defaults for a roster. */
function view(over: { status?: number; url?: string; headers?: Record<string, string>; body?: string | null } = {}, target: FetchTarget = roster()): FetchResponseView {
  return {
    status: over.status ?? 200,
    url: over.url ?? new URL(fetchPathFor(target), ORIGIN).href,
    headers: new Headers(over.headers ?? {}),
    origin: ORIGIN,
    body: over.body === undefined ? null : over.body,
  };
}

// Synthetic: the markers the stop-rule table names, in the smallest page that carries them.
const SYNTH_JUST_A_MOMENT = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1></body></html>';
const SYNTH_CHL_OPT = `<html><head><title>Roster</title></head><body><script>window._cf_chl_opt={cvId:'3'};</script>${REAL_ROSTER}</body></html>`;
const SYNTH_NO_SELECT = REAL_ROSTER.replace('<select name="season_id"', '<select name="not_season"');
const SYNTH_NO_HEADING = REAL_ROSTER.replace(/Season 2025-2026 Men/g, 'Roster listing');

describe('T-Q 4: every challenge form stops the run, and real pages are delivered', () => {
  const challenges: Array<[string, FetchTarget, Reply]> = [
    ['roster: title "Just a moment" (synthetic)', roster(), html(SYNTH_JUST_A_MOMENT)],
    ['roster: _cf_chl_opt on an otherwise real page (synthetic)', roster(), html(SYNTH_CHL_OPT)],
    ['roster: no season_id select (real page with the select renamed)', roster(), html(SYNTH_NO_SELECT)],
    ['roster: select but no Season heading and no empty state (real page with the heading changed)', roster(), html(SYNTH_NO_HEADING)],
    ['roster: an empty body', roster(), html('')],
    ['roster: the challenge header on a 200 (synthetic)', roster(), html(REAL_ROSTER, { headers: { 'cf-mitigated': 'challenge' } })],
    ['roster: the challenge header on a 503 (synthetic)', roster(), reply(503, SYNTH_JUST_A_MOMENT, { headers: { 'cf-mitigated': 'challenge' } })],
    ['roster: the challenge header on a 429 (synthetic)', roster(), reply(429, '', { headers: { 'cf-mitigated': 'challenge', 'retry-after': '1' } })],
    ['window: the challenge header on a 200 (synthetic)', win(), json(WINDOW_OK, { headers: { 'cf-mitigated': 'challenge' } })],
    ['window: 200 text/html (synthetic)', win(), html(SYNTH_JUST_A_MOMENT)],
    ['window: right content type, body not JSON (synthetic)', win(), reply(200, 'Just a moment...', { headers: { 'content-type': 'application/json' } })],
    ['window: JSON null', win(), json(null)],
    ['window: JSON array', win(), json([])],
    ['window: no relays', win(), json({ swimmers: [] })],
    ['window: no swimmers', win(), json({ relays: [] })],
    ['window: swimmers is not a list', win(), json({ swimmers: {}, relays: [] })],
    ['window: no content type at all', win(), reply(200, JSON.stringify(WINDOW_OK))],
  ];
  it.each(challenges)('%s', async (_name, target, answer) => {
    const env = makeEnv([answer, html(REAL_ROSTER), html(REAL_ROSTER)]);
    await run(env, [target, roster('48'), roster('412')]);
    expect(env.calls, 'later targets are never fetched').toHaveLength(1);
    expect(env.items(), 'a body that was not classified is never delivered').toHaveLength(0);
    expect(env.end().stopped?.reason).toBe('challenge');
    expect(env.end().stopped).toMatchObject({ index: 0 });
  });

  it('does not read the body of a response that carries the challenge header', async () => {
    let reads = 0;
    const answer: Reply = (p) => ({ status: 200, url: new URL(p, ORIGIN).href, headers: new Headers({ 'cf-mitigated': 'challenge' }), text: () => { reads += 1; return Promise.resolve(REAL_ROSTER); } });
    await run(makeEnv([answer]), [roster()]);
    expect(reads).toBe(0);
  });

  it('delivers the real Henderson State roster page byte for byte', async () => {
    const env = makeEnv([html(REAL_ROSTER)]);
    await run(env, [roster('58')]);
    expect(env.items()).toStrictEqual([{
      kind: 'fetch-item', runId: 'r1', index: 0, path: '/team/58/roster/?gender=M', finalPath: '/team/58/roster/?gender=M',
      contentType: 'text/html; charset=utf-8', body: REAL_ROSTER, fetchedAt: new Date(T0).toISOString(),
    }]);
    expect(env.end()).toStrictEqual({ kind: 'fetch-end', runId: 'r1', delivered: 1, stopped: null });
  });

  it('delivers the real UWF empty-state page ("No rosters found") as a real answer', async () => {
    const env = makeEnv([html(UWF_EMPTY)]);
    await run(env, [roster('10002824')]);
    expect(env.items()).toHaveLength(1);
    expect(env.items()[0]!.body).toBe(UWF_EMPTY);
    expect(env.end()).toMatchObject({ delivered: 1, stopped: null });
  });

  it('delivers a real roster that also loads the invisible-check script (real roster + real snippet from the NSISC capture)', async () => {
    // A normal SwimCloud page carries this one-line loader. It is not a challenge. Matching "challenge-platform" would stop every run.
    const snippet = /<script>window\.__CF\$cv\$params=\{\};[^\n]*challenge-platform[^\n]*<\/script>/.exec(NSISC_REAL)?.[0];
    expect(snippet, 'the NSISC capture still carries the loader').toContain('/cdn-cgi/challenge-platform/');
    expect(REAL_ROSTER.split('</body>')).toHaveLength(2);
    const page = REAL_ROSTER.replace('</body>', `${snippet}</body>`);
    expect(page).toContain('challenge-platform');
    const env = makeEnv([html(page)]);
    await run(env, [roster('58')]);
    expect(env.items()).toHaveLength(1);
    expect(env.items()[0]!.body).toBe(page);
    expect(env.end()).toMatchObject({ delivered: 1, stopped: null });
  });

  it('delivers a chosen-season roster and a team-window JSON, and the window keeps its charset suffix', async () => {
    const env = makeEnv([html(REAL_ROSTER), reply(200, JSON.stringify({ swimmers: [{ id: 1 }], relays: [] }), { headers: { 'content-type': 'application/json; charset=utf-8' } })]);
    await run(env, [rosterSeason('29'), win('L')]);
    expect(env.items().map((i) => i.path)).toStrictEqual([
      '/team/58/roster/?page=1&gender=M&season_id=29&sort=name',
      '/api/teams/58/simulator/?start_date=2025-09-01&end_date=2026-08-31&eventgender=M&eventcourse=L&divecourse=6&time_to_use=fastest',
    ]);
    expect(env.items()[1]!.body).toBe('{"swimmers":[{"id":1}],"relays":[]}');
  });
});

// ---- other stop rules -----------------------------------------------------------------------------------------

describe('the remaining stop rules', () => {
  it.each([
    [500, 'server-error'], [503, 'server-error'], [599, 'server-error'],
    [404, 'unexpected-status'], [301, 'unexpected-status'], [204, 'unexpected-status'], [401, 'unexpected-status'], [201, 'unexpected-status'],
  ] as const)('status %i stops with %s', async (status, reason) => {
    const env = makeEnv([reply(status, ''), html(REAL_ROSTER)]);
    await run(env, [roster('58'), roster('48')]);
    expect(env.calls).toHaveLength(1);
    expect(env.end().stopped).toMatchObject({ reason, status, index: 0 });
  });

  it('stops with network when fetch rejects, and when the body cannot be read', async () => {
    const down = makeEnv([() => new Error('Failed to fetch'), html(REAL_ROSTER)]);
    await run(down, [roster('58'), roster('48')]);
    expect(down.calls).toHaveLength(1);
    expect(down.end().stopped).toMatchObject({ reason: 'network', status: 0, detail: 'Failed to fetch' });

    const broken: Reply = (p) => ({ status: 200, url: new URL(p, ORIGIN).href, headers: new Headers(), text: () => Promise.reject(new Error('body stream failed')) });
    const env = makeEnv([broken]);
    await run(env, [roster()]);
    expect(env.end().stopped).toMatchObject({ reason: 'network', detail: 'body stream failed' });
  });

  it('delivers nothing from a target after a stop even when the script has more answers', async () => {
    const env = makeEnv([html(REAL_ROSTER), reply(500, ''), html(REAL_ROSTER), html(REAL_ROSTER)]);
    await run(env, [roster('58'), roster('48'), roster('412'), roster('1')]);
    expect(env.items().map((i) => i.index)).toStrictEqual([0]);
    expect(env.end()).toMatchObject({ delivered: 1, stopped: { reason: 'server-error', index: 1 } });
  });
});

// ---- T-Q 5: redirect ------------------------------------------------------------------------------------------

describe('T-Q 5: a 200 whose final path or query differs from the request stops the run', () => {
  const finals: Array<[string, (p: string) => string]> = [
    ['another path', () => `${ORIGIN}/login/`],
    ['another team', () => `${ORIGIN}/team/99/roster/?gender=M`],
    ['a dropped query', () => `${ORIGIN}/team/58/roster/`],
    ['another gender', () => `${ORIGIN}/team/58/roster/?gender=F`],
    ['an extra parameter', () => `${ORIGIN}/team/58/roster/?gender=M&season_id=30`],
    ['another origin', (p) => `https://evil.example${p}`],
    ['another scheme', (p) => `http://www.swimcloud.com${p}`],
    ['no URL at all', () => ''],
    ['a trailing slash removed', () => `${ORIGIN}/team/58/roster?gender=M`],
  ];
  it.each(finals)('final URL with %s', async (_name, finalUrl) => {
    const env = makeEnv([html(REAL_ROSTER, { url: finalUrl }), html(REAL_ROSTER)]);
    await run(env, [roster('58'), roster('48')]);
    expect(env.calls).toHaveLength(1);
    expect(env.items()).toHaveLength(0);
    expect(env.end().stopped).toMatchObject({ reason: 'redirected', status: 200, index: 0 });
  });

  it('compares the query as a sorted set, so the same parameters in another order are the same page', async () => {
    const env = makeEnv([html(REAL_ROSTER, { url: () => `${ORIGIN}/team/58/roster/?sort=name&season_id=29&gender=M&page=1` })]);
    await run(env, [rosterSeason('29')]);
    expect(env.end()).toMatchObject({ delivered: 1, stopped: null });
    expect(env.items()[0]).toMatchObject({ path: '/team/58/roster/?page=1&gender=M&season_id=29&sort=name', finalPath: '/team/58/roster/?sort=name&season_id=29&gender=M&page=1' });
  });

  it('checks a team-window response too', async () => {
    const env = makeEnv([json(WINDOW_OK, { url: () => `${ORIGIN}/api/teams/58/simulator/?eventcourse=Y` })]);
    await run(env, [win('L')]);
    expect(env.end().stopped?.reason).toBe('redirected');
  });
});

// ---- T-Q 6: refusal -------------------------------------------------------------------------------------------

describe('T-Q 6: a path the module did not build is refused before any request', () => {
  const bad: Array<[string, FetchTarget]> = [
    ['a team id with a path in it', { ...roster(), teamId: '58/../../api/x' }],
    ['a zero-led team id', { ...roster(), teamId: '058' }],
    ['a season value with an ampersand', rosterSeason('1&team=9')],
    ['a season value that is empty', rosterSeason('')],
    ['a window course the module does not build', { ...win(), course: 'S' as 'Y' }],
    ['a window date that is not a date', { ...win(), to: '2026-02-31x' }],
    ['an unknown kind', { kind: 'swimmer-times', swimmerId: '1' } as unknown as FetchTarget],
  ];
  it.each(bad)('%s', async (_name, target) => {
    const env = makeEnv([html(REAL_ROSTER), html(REAL_ROSTER)]);
    await run(env, [roster('58'), target]);
    expect(env.calls, 'not even the good first target is sent').toHaveLength(0);
    expect(env.lockCalls, 'the lock is never taken').toHaveLength(0);
    expect(env.end()).toStrictEqual({ kind: 'fetch-end', runId: 'r1', delivered: 0, stopped: { reason: 'refused', index: 1, status: 0, detail: expect.any(String) } });
  });
});

// ---- locks, cancel, empty -------------------------------------------------------------------------------------

describe('one run at a time, and cancel', () => {
  it('takes the named Web Lock with ifAvailable', async () => {
    const env = makeEnv([html(REAL_ROSTER)]);
    await run(env, [roster()]);
    expect(env.lockCalls).toStrictEqual([{ name: 'omniswim-swimcloud-fetch', options: { ifAvailable: true } }]);
  });

  it('stops with lock-held when another tab holds the lock, and fetches nothing', async () => {
    const env = makeEnv([html(REAL_ROSTER)], { locks: 'held' });
    await run(env, [roster()]);
    expect(env.calls).toHaveLength(0);
    expect(env.end().stopped).toMatchObject({ reason: 'lock-held', index: 0, status: 0 });
  });

  it('stops with lock-unavailable when there is no navigator.locks, or the lock manager throws', async () => {
    const none = makeEnv([html(REAL_ROSTER)], { locks: 'none' });
    await run(none, [roster()]);
    expect(none.calls).toHaveLength(0);
    expect(none.end().stopped).toMatchObject({ reason: 'lock-unavailable' });
    const throws = makeEnv([html(REAL_ROSTER)], { locks: 'throws' });
    await run(throws, [roster()]);
    expect(throws.calls).toHaveLength(0);
    expect(throws.end().stopped).toMatchObject({ reason: 'lock-unavailable', detail: 'locks are not allowed here' });
  });

  it('a failure inside a run surfaces instead of becoming lock-unavailable', async () => {
    const env = makeEnv([html(REAL_ROSTER)]);
    const deps: FetchQueueDeps = { ...env.deps, post: () => { throw new Error('port closed'); } };
    await expect(runFetchQueue({ runId: 'r1', feature: 'roster', targets: [roster()] }, deps, new AbortController().signal)).rejects.toThrow('port closed');
  });

  it('cancel during the pacing wait stops with cancelled and sends nothing more', async () => {
    const ac = new AbortController();
    const env = makeEnv([html(REAL_ROSTER), html(REAL_ROSTER)], { onSleep: () => ac.abort() });
    await run(env, [roster('58'), roster('48')], ac.signal);
    expect(env.calls).toHaveLength(1);
    expect(env.end()).toMatchObject({ delivered: 1, stopped: { reason: 'cancelled', index: 1 } });
  });

  it('cancel while a request is in flight drops its answer', async () => {
    const ac = new AbortController();
    const answer: Reply = (p) => { ac.abort(); return html(REAL_ROSTER)(p); };
    const env = makeEnv([answer]);
    await run(env, [roster()], ac.signal);
    expect(env.items()).toHaveLength(0);
    expect(env.end()).toMatchObject({ delivered: 0, stopped: { reason: 'cancelled' } });
  });

  it('a run that is already cancelled sends nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const env = makeEnv([html(REAL_ROSTER)]);
    await run(env, [roster()], ac.signal);
    expect(env.calls).toHaveLength(0);
    expect(env.end().stopped?.reason).toBe('cancelled');
  });

  it('an empty run ends at once without taking the lock', async () => {
    const env = makeEnv([]);
    await run(env, []);
    expect(env.lockCalls).toHaveLength(0);
    expect(env.end()).toStrictEqual({ kind: 'fetch-end', runId: 'r1', delivered: 0, stopped: null });
  });
});

// ---- pacing outlives the run ----------------------------------------------------------------------------------

describe('pacing outlives the run (architect review 2026-11-05, item 1)', () => {
  it('the tab keeps the last start: a second run begins at least 3000 ms after the first run\'s last request', async () => {
    const first = makeEnv([html(REAL_ROSTER)], { latencyMs: 200 });
    await run(first, [roster('58')]);
    const lastStart = first.pacer.lastStart!;
    expect(lastStart).toBe(T0);
    // A new run on the same pacer, with the clock only 1000 ms after that start, as when the hold above did not cover it.
    const second = makeEnv([html(REAL_ROSTER)], { pacer: first.pacer, clock: { now: lastStart + 1000 } });
    await run(second, [roster('48')]);
    expect(second.calls[0]!.at).toBe(lastStart + 3000);
    expect(second.posted.find((m) => m.kind === 'fetch-progress')).toMatchObject({ index: 0, waitMs: 2000 });
  });

  it('a fresh tab (new pacer) starts at once', async () => {
    const env = makeEnv([html(REAL_ROSTER)]);
    await run(env, [roster()]);
    expect(env.calls[0]!.at).toBe(T0);
    expect(env.sleeps).toStrictEqual([]);
  });

  it('keeps the lock until the last request is 3000 ms old, so another tab cannot start inside the gap', async () => {
    const env = makeEnv([html(REAL_ROSTER), html(REAL_ROSTER)], { latencyMs: 1000 });
    await run(env, [roster('58'), roster('48')]);
    const lastStart = env.calls[1]!.at;
    expect(env.end()).toMatchObject({ delivered: 2, stopped: null });
    expect(env.releasedAt).toStrictEqual([lastStart + 3000]);
    expect(env.holdSleeps).toStrictEqual([2000]);
  });

  it('holds the lock after a stop too', async () => {
    const stopped = makeEnv([reply(500, '')], { latencyMs: 500 });
    await run(stopped, [roster()]);
    expect(stopped.end().stopped?.reason).toBe('server-error');
    expect(stopped.releasedAt).toStrictEqual([T0 + 3000]);
  });

  it('does not hold the lock for a run that never sent a request, and does not take it for a refusal', async () => {
    const held = makeEnv([html(REAL_ROSTER)], { locks: 'held' });
    await run(held, [roster()]);
    expect(held.holdSleeps).toStrictEqual([]);
  });

  it('the hold cannot be cancelled: a cancel during it still waits out the gap', async () => {
    const ac = new AbortController();
    const env = makeEnv([html(REAL_ROSTER)]);
    const sleepWas = env.deps.sleep;
    const deps: FetchQueueDeps = { ...env.deps, sleep: (ms, signal) => { ac.abort(); expect(signal.aborted, 'the hold gets a signal that never aborts').toBe(false); return sleepWas(ms, signal); } };
    await runFetchQueue({ runId: 'r1', feature: 'roster', targets: [roster()] }, deps, ac.signal);
    expect(env.releasedAt).toStrictEqual([T0 + 3000]);
  });
});

// ---- cancel reaches a request in flight -----------------------------------------------------------------------

describe('cancel stops a request in flight (architect review 2026-11-05, item 2)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('a hung request plus cancel gives exactly one fetch-end with reason cancelled, and the lock is let go', async () => {
    const ac = new AbortController();
    const env = makeEnv([HANG, html(REAL_ROSTER)]);
    const p = run(env, [roster('58'), roster('48')], ac.signal);
    await tick();
    expect(env.calls).toHaveLength(1);
    expect(env.releasedAt, 'still waiting on the hung request').toHaveLength(0);
    ac.abort('the user pressed cancel');
    const end = await p;
    expect(end).toStrictEqual({ kind: 'fetch-end', runId: 'r1', delivered: 0, stopped: { reason: 'cancelled', index: 0, status: 0, detail: 'the user pressed cancel' } });
    expect(env.end()).toBe(end); // the only fetch-end that was posted
    expect(env.items()).toHaveLength(0);
    expect(env.calls, 'the second target was never sent').toHaveLength(1);
    expect(env.releasedAt).toHaveLength(1);
  });

  it('ends the run even when the fetch ignores the signal', async () => {
    const ac = new AbortController();
    const env = makeEnv([HANG_DEAF]);
    const p = run(env, [roster()], ac.signal);
    await tick();
    ac.abort();
    expect((await p).stopped).toMatchObject({ reason: 'cancelled', detail: 'cancelled' });
    expect(env.releasedAt).toHaveLength(1);
  });
});

// ---- clocks ---------------------------------------------------------------------------------------------------

describe('pacing runs on the monotonic clock, dates on the wall clock (review item 8)', () => {
  it('reads an HTTP-date Retry-After against the wall clock and stamps fetchedAt from it', async () => {
    const env = makeEnv([reply(429, '', { headers: { 'retry-after': new Date(T0 + 9000).toUTCString() } }), html(REAL_ROSTER)]);
    // The monotonic clock reads nothing like the wall clock, as performance.now() does not.
    const deps: FetchQueueDeps = { ...env.deps, now: () => env.clock.now - T0 + 500 };
    const end = await runFetchQueue({ runId: 'r1', feature: 'roster', targets: [roster()] }, deps, new AbortController().signal);
    expect(end).toMatchObject({ delivered: 1, stopped: null });
    expect(env.sleeps).toStrictEqual([9000]);
    expect(env.items()[0]!.fetchedAt).toBe(new Date(T0 + 9000).toISOString());
  });
});
