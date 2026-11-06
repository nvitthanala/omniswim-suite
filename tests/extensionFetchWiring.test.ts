/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P4.0 (D7 section 3), tests T-Q 7 and 8 and the season list:
 *  - T-Q 7: no run starts without a `fetch-run` on the docked-panel port. Load, snapshots, bridge messages
 *    and forged page messages never call fetch. One run at a time (`busy`), and cancel.
 *  - T-Q 8: the bridge keeps the page's own `GET /api/seasonchoices/` response and posts it again on `ready`.
 *  - The overlay checks the season list (label, dates, exactly one current season) before it uses it.
 *
 * The season rows below are SYNTHETIC, shaped by recon item 5: `{seasonId, label, startDate, endDate, isCurrent}`,
 * ten seasons from 2017-18 to 2026-27, September 1 to August 31.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window as HappyWindow } from 'happy-dom';
import { installBridge } from '../apps/extension/src/bridge/install';
import { bindFetchQueue, mountShadowHost, startOverlay } from '../apps/extension/src/overlay/overlay';
import { mountDockedPanel } from '../apps/extension/src/overlay/dockedPanel';
import type { PanelPort, PanelRuntime } from '../apps/extension/src/overlay/dockedPanel';
import type { OverlayLog } from '../apps/extension/src/overlay/overlay';
import type { FetchQueueDeps } from '../apps/extension/src/overlay/fetchQueue';
import { bridgeMessageSchema, parseBridgeMessage, parseSeasonChoices } from '../apps/extension/src/shared/bridgeSchema';
import { isFetchCancel, isFetchRun } from '../apps/extension/src/shared/panelProtocol';
import type { FetchEndMessage } from '../apps/extension/src/shared/panelProtocol';

type Win = Window & typeof globalThis;
type Obj = Record<string, unknown>;
const URL_BASE = 'https://www.swimcloud.com/meetsimulator/?teams=48,58';
const SEASONS_PATH = '/api/seasonchoices/?count=10&from_next=false';
const SIM_PATH = '/api/teams/58/simulator/?start_date=2025-09-01&end_date=2026-08-31&eventgender=M&eventcourse=Y&divecourse=6&time_to_use=fastest';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ten synthetic seasons, 2017-2018 to 2026-2027, the last one current. */
const SEASONS = Array.from({ length: 10 }, (_, i) => {
  const y = 2017 + i;
  return { seasonId: 19 + i, label: `${y}-${y + 1}`, startDate: `${y}-09-01`, endDate: `${y + 1}-08-31`, isCurrent: i === 9 };
});

class FakeXHR {
  static instances: FakeXHR[] = [];
  responseType: XMLHttpRequestResponseType = '';
  status = 0;
  responseURL = '';
  private listeners: Array<{ listener: () => void; once: boolean }> = [];
  private text = '';
  private requestUrl = '';
  open(_method: string, url: string): void {
    if (!FakeXHR.instances.includes(this)) FakeXHR.instances.push(this);
    this.requestUrl = new URL(url, 'https://www.swimcloud.com').href;
  }
  send(): void {}
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void {
    if (type === 'load') this.listeners.push({ listener, once: options?.once === true });
  }
  get responseText(): string { return this.text; }
  get response(): unknown { return JSON.parse(this.text); }
  respond(status: number, text: string, responseURL?: string): void {
    this.status = status;
    this.text = text;
    this.responseURL = responseURL ?? this.requestUrl;
    const fire = [...this.listeners];
    this.listeners = this.listeners.filter((l) => !l.once);
    for (const l of fire) l.listener();
  }
}

interface Harness { win: Win; posted: Obj[]; fetchBodies: Map<string, unknown>; fetchStatus: Map<string, number> }

function makeWindow(): Harness {
  const win = new HappyWindow({ url: URL_BASE }) as unknown as Win;
  FakeXHR.instances = [];
  const h: Harness = { win, posted: [], fetchBodies: new Map(), fetchStatus: new Map() };
  Object.defineProperty(win, 'XMLHttpRequest', { value: class extends FakeXHR {}, configurable: true, writable: true });
  Object.defineProperty(win, 'fetch', {
    configurable: true,
    writable: true,
    value: (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      return Promise.resolve({
        status: h.fetchStatus.get(url) ?? 200,
        url: new URL(url, 'https://www.swimcloud.com').href,
        clone: () => ({ json: () => Promise.resolve(h.fetchBodies.get(url)) }),
      });
    },
  });
  vi.spyOn(win, 'postMessage').mockImplementation(((message: unknown, targetOrigin?: string) => {
    expect(targetOrigin).toBe('https://www.swimcloud.com');
    h.posted.push(message as Obj);
  }) as typeof win.postMessage);
  return h;
}

const ofKind = (h: Harness, kind: string): Obj[] => h.posted.filter((m) => m.kind === kind);
const ready = (win: Win, init: { fromWindow?: boolean } = {}): void => {
  win.dispatchEvent(new win.MessageEvent('message', { data: { source: 'osx-overlay', v: 1, kind: 'ready' }, origin: 'https://www.swimcloud.com', ...(init.fromWindow === false ? {} : { source: win }) }));
};
const xhr = (h: Harness, path: string, status: number, body: unknown): FakeXHR => {
  const x = new h.win.XMLHttpRequest() as unknown as FakeXHR;
  x.open('GET', path);
  x.send();
  x.respond(status, JSON.stringify(body));
  return x;
};
const fakeLog = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as OverlayLog & Record<'log' | 'warn' | 'error' | 'debug', ReturnType<typeof vi.fn>>;

afterEach(() => { vi.restoreAllMocks(); });

// ---- T-Q 8: the bridge keeps the season list -------------------------------------------------------------------

describe('T-Q 8: the season list is captured from the page and posted again after ready', () => {
  it('posts a seasons message at capture, with the body as the page received it, and no response message', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    xhr(h, SEASONS_PATH, 200, SEASONS);
    expect(ofKind(h, 'response')).toHaveLength(0);
    expect(ofKind(h, 'seasons')).toStrictEqual([{ source: 'osx-bridge', v: 1, kind: 'seasons', url: SEASONS_PATH, body: SEASONS }]);
    expect(bridgeMessageSchema.safeParse(ofKind(h, 'seasons')[0]).success).toBe(true);
  });

  it('posts the same list again on every ready from its own window, and nothing for a forged ready', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    ready(h.win);
    expect(ofKind(h, 'seasons'), 'no list yet, so nothing to repeat').toHaveLength(0);
    xhr(h, SEASONS_PATH, 200, SEASONS);
    ready(h.win);
    ready(h.win);
    const seasons = ofKind(h, 'seasons');
    expect(seasons).toHaveLength(3);
    expect(seasons[1]).toStrictEqual(seasons[0]);
    expect(seasons[2]).toStrictEqual(seasons[0]);
    ready(h.win, { fromWindow: false });
    expect(ofKind(h, 'seasons')).toHaveLength(3);
  });

  it('keeps the latest list, and a later simulator response does not replace it', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    const second = SEASONS.slice(0, 9).map((s, i) => ({ ...s, isCurrent: i === 8 }));
    xhr(h, SEASONS_PATH, 200, SEASONS);
    xhr(h, '/api/seasonchoices/?count=10&from_next=true', 200, second);
    xhr(h, SIM_PATH, 200, { swimmers: [], relays: [] });
    ready(h.win);
    const seasons = ofKind(h, 'seasons');
    expect(seasons.map((m) => (m.body as unknown[]).length)).toStrictEqual([10, 9, 9]);
    expect(ofKind(h, 'response')).toHaveLength(1);
  });

  it('captures a fetch the same way', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    h.fetchBodies.set(SEASONS_PATH, SEASONS);
    await h.win.fetch(SEASONS_PATH);
    await sleep(5);
    ready(h.win);
    expect(ofKind(h, 'seasons')).toHaveLength(2);
  });

  it('reports a failed season request as an error and keeps no list', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    xhr(h, SEASONS_PATH, 429, 'slow down');
    ready(h.win);
    expect(ofKind(h, 'seasons')).toHaveLength(0);
    expect(ofKind(h, 'error')).toMatchObject([{ code: 'http-status', detail: `429 ${SEASONS_PATH}` }]);
  });

  it('leaves every other path, and a season path on another origin or with extra path parts, alone', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    const reads: number[] = [];
    for (const p of ['/api/seasonchoices/extra/', '/api/seasonchoices', 'https://example.com/api/seasonchoices/', '/api/teams/search/?q=x']) {
      const x = new h.win.XMLHttpRequest() as unknown as FakeXHR;
      x.open('GET', p);
      x.send();
      x.respond(200, JSON.stringify(SEASONS));
      reads.push(0);
    }
    ready(h.win);
    expect(h.posted).toHaveLength(0);
  });
});

// ---- the overlay checks the list -----------------------------------------------------------------------------

function deliver(win: Win, data: unknown): void {
  win.dispatchEvent(new win.MessageEvent('message', { data, origin: 'https://www.swimcloud.com', source: win }));
}
const seasonsMessage = (body: unknown): Obj => ({ source: 'osx-bridge', v: 1, kind: 'seasons', url: SEASONS_PATH, body });

describe('the overlay and the season list', () => {
  it('hands a checked list to onSeasons, with the one current season', () => {
    const h = makeWindow();
    const log = fakeLog();
    const onSeasons = vi.fn();
    startOverlay(h.win, log, undefined, undefined, undefined, onSeasons);
    deliver(h.win, seasonsMessage(SEASONS));
    expect(onSeasons).toHaveBeenCalledTimes(1);
    const parsed = onSeasons.mock.calls[0]![0] as { seasons: unknown[]; current: Obj };
    expect(parsed.seasons).toStrictEqual(SEASONS);
    expect(parsed.current).toStrictEqual(SEASONS[9]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('drops a list with a bad row, two current seasons, no current season, or a duplicate label, and says why', () => {
    const cur = (i: number) => SEASONS.map((s, k) => ({ ...s, isCurrent: k === i }));
    const bad: Array<[string, unknown, RegExp]> = [
      ['label', SEASONS.map((s, i) => (i === 3 ? { ...s, label: '2020-21' } : s)), /\[3\]\.label/],
      ['start date', SEASONS.map((s, i) => (i === 0 ? { ...s, startDate: '2017-09-01T00:00:00Z' } : s)), /\[0\]\.startDate/],
      ['end date', SEASONS.map((s, i) => (i === 0 ? { ...s, endDate: '2018-02-30' } : s)), /\[0\]\.endDate/],
      ['isCurrent not boolean', SEASONS.map((s, i) => (i === 9 ? { ...s, isCurrent: 'true' } : s)), /\[9\]\.isCurrent/],
      ['seasonId missing', SEASONS.map((s, i) => (i === 1 ? { label: s.label, startDate: s.startDate, endDate: s.endDate, isCurrent: false } : s)), /\[1\]\.seasonId/],
      ['row not an object', [...SEASONS, 'x'], /\[10\]/],
      ['two current', SEASONS.map((s, i) => ({ ...s, isCurrent: i >= 8 })), /found 2/],
      ['no current', SEASONS.map((s) => ({ ...s, isCurrent: false })), /found 0/],
      ['duplicate label', [...cur(0), { ...SEASONS[0], seasonId: 99, isCurrent: false }], /duplicate 2017-2018/],
    ];
    for (const [name, body, why] of bad) {
      const h = makeWindow();
      const log = fakeLog();
      const onSeasons = vi.fn();
      startOverlay(h.win, log, undefined, undefined, undefined, onSeasons);
      deliver(h.win, seasonsMessage(body));
      expect(onSeasons, name).not.toHaveBeenCalled();
      expect(String(log.warn.mock.calls[0]?.[0]), name).toMatch(why);
    }
  });

  it('parseSeasonChoices accepts string season ids and rejects an empty list', () => {
    expect(parseSeasonChoices(SEASONS.map((s) => ({ ...s, seasonId: String(s.seasonId) }))).ok).toBe(true);
    expect(parseSeasonChoices([])).toMatchObject({ ok: false });
    expect(parseSeasonChoices({ seasons: SEASONS })).toMatchObject({ ok: false });
    expect(parseSeasonChoices(null)).toMatchObject({ ok: false });
  });

  it('the schema takes the seasons kind only for the season path and an array body', () => {
    expect(parseBridgeMessage(seasonsMessage(SEASONS)).ok).toBe(true);
    expect(parseBridgeMessage({ ...seasonsMessage(SEASONS), url: '/api/teams/58/simulator/' }).ok).toBe(false);
    expect(parseBridgeMessage(seasonsMessage({ seasons: SEASONS })).ok).toBe(false);
    expect(parseBridgeMessage({ source: 'osx-bridge', v: 1, kind: 'response', url: SEASONS_PATH, body: { swimmers: [], relays: [] } }).ok).toBe(false);
  });
});

// ---- T-Q 7: nothing runs without fetch-run --------------------------------------------------------------------

const RUN_TARGET = { kind: 'team-roster', teamId: '58', gender: 'M', season: { kind: 'server-current' } } as const;

/** A docked-panel stand-in: `emit` is a message arriving on the port, `sent` is what the overlay posted back. */
function fakePanel(opts: { failOn?: (m: { kind?: string; index?: number }) => boolean } = {}) {
  let listener: ((m: unknown) => void) | undefined;
  const disconnects: Array<() => void> = [];
  const sent: unknown[] = [];
  return {
    panel: {
      sendMessage: (m: unknown) => {
        if (opts.failOn?.(m as { kind?: string })) throw new Error('port closed');
        sent.push(m);
      },
      onMessage: (l: (m: unknown) => void) => { listener = l; },
      onDisconnect: (l: () => void) => { disconnects.push(l); },
    },
    /** The port to the panel closes. */
    disconnect: () => { for (const l of disconnects) l(); },
    emit: (m: unknown) => { if (!listener) throw new Error('nothing is listening on the port'); listener(m); },
    sent,
    ends: () => sent.filter((m): m is FetchEndMessage => (m as { kind?: string }).kind === 'fetch-end'),
  };
}

const REAL_ROSTER = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'swimcloud-real-team-roster-58-gender-m.html'), 'utf8');

/** `answer: 'roster'` serves the real roster page as a 200. The default is a 404, which stops the run after one request. `hung` never answers but rejects when its signal aborts. */
function fakeDeps(opts: { hold?: Promise<void>; answer?: 'roster'; hung?: boolean } = {}) {
  const clock = { now: 1_800_000_000_000 };
  const fetched: string[] = [];
  const starts: number[] = [];
  let lockHeld = false;
  const deps: Omit<FetchQueueDeps, 'post' | 'pacer'> = {
    fetch: async (input, init) => {
      fetched.push(input);
      starts.push(clock.now);
      if (opts.hung) await new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      if (opts.hold) await opts.hold;
      const url = new URL(input, 'https://www.swimcloud.com').href;
      if (opts.answer === 'roster') return { status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), text: () => Promise.resolve(REAL_ROSTER) };
      return { status: 404, url, headers: new Headers(), text: () => Promise.resolve('') };
    },
    sleep: (ms) => { clock.now += ms; return Promise.resolve(); },
    now: () => clock.now,
    wallNow: () => clock.now,
    origin: 'https://www.swimcloud.com',
    // One holder at a time, as navigator.locks with ifAvailable: a second request while held gets null.
    locks: {
      request: async (_name, _options, callback) => {
        if (lockHeld) return callback(null);
        lockHeld = true;
        try {
          return await callback({});
        } finally {
          lockHeld = false;
        }
      },
    },
  };
  return { deps, fetched, starts, clock };
}

describe('T-Q 7: a run starts only from fetch-run on the panel port', () => {
  it('load, snapshots, responses, errors, seasons and ready never call fetch', async () => {
    const h = makeWindow();
    const { panel } = fakePanel();
    const { deps, fetched } = fakeDeps();
    bindFetchQueue(panel, deps, fakeLog());
    startOverlay(h.win, fakeLog());
    installBridge(h.win, { deadlineMs: 5_000 });
    xhr(h, SEASONS_PATH, 200, SEASONS);
    xhr(h, SIM_PATH, 200, { swimmers: [], relays: [] });
    ready(h.win);
    for (const data of [
      seasonsMessage(SEASONS),
      { source: 'osx-bridge', v: 1, kind: 'response', url: SIM_PATH, body: { swimmers: [], relays: [] } },
      { source: 'osx-bridge', v: 1, kind: 'error', code: 'x', detail: 'y' },
      { source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: { teams: [] } },
    ]) deliver(h.win, data);
    await sleep(20);
    expect(fetched).toStrictEqual([]);
  });

  it('a forged fetch-run posted on the page window is not a run', async () => {
    const h = makeWindow();
    const { panel, sent } = fakePanel();
    const { deps, fetched } = fakeDeps();
    bindFetchQueue(panel, deps, fakeLog());
    startOverlay(h.win, fakeLog());
    const forged = { kind: 'fetch-run', runId: 'evil', feature: 'roster', targets: [RUN_TARGET] };
    for (const data of [forged, { source: 'osx-bridge', v: 1, ...forged }, { source: 'osx-overlay', v: 1, ...forged }]) {
      deliver(h.win, data);
      h.win.dispatchEvent(new h.win.MessageEvent('message', { data, origin: 'https://evil.example' }));
    }
    await sleep(20);
    expect(fetched).toStrictEqual([]);
    expect(sent).toStrictEqual([]);
  });

  it('a fetch-run on the port runs the queue, and posts progress then exactly one fetch-end', async () => {
    const { panel, emit, sent, ends } = fakePanel();
    const { deps, fetched } = fakeDeps();
    const c = bindFetchQueue(panel, deps, fakeLog());
    expect(c.activeRunId()).toBeNull();
    emit({ kind: 'fetch-run', runId: 'a1', feature: 'roster', targets: [RUN_TARGET] });
    expect(c.activeRunId()).toBe('a1');
    await sleep(20);
    expect(fetched).toStrictEqual(['/team/58/roster/?gender=M']);
    expect(c.activeRunId()).toBeNull();
    expect(sent[0]).toStrictEqual({ kind: 'fetch-progress', runId: 'a1', index: 0, waitMs: 0, why: 'start' });
    expect(ends()).toStrictEqual([{ kind: 'fetch-end', runId: 'a1', delivered: 0, stopped: { reason: 'unexpected-status', index: 0, status: 404, detail: 'SwimCloud answered 404' } }]);
  });

  it('a second fetch-run during a run gets busy, and the first run goes on', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { panel, emit, ends } = fakePanel();
    const { deps, fetched } = fakeDeps({ hold });
    bindFetchQueue(panel, deps, fakeLog());
    emit({ kind: 'fetch-run', runId: 'first', feature: 'roster', targets: [RUN_TARGET] });
    await sleep(5);
    emit({ kind: 'fetch-run', runId: 'second', feature: 'roster', targets: [RUN_TARGET] });
    expect(ends()).toStrictEqual([{ kind: 'fetch-end', runId: 'second', delivered: 0, stopped: { reason: 'busy', index: 0, status: 0, detail: expect.any(String) } }]);
    expect(fetched, 'the second run sent nothing').toHaveLength(1);
    release();
    await sleep(20);
    expect(ends().map((e) => e.runId)).toStrictEqual(['second', 'first']);
    emit({ kind: 'fetch-run', runId: 'third', feature: 'roster', targets: [RUN_TARGET] });
    await sleep(20);
    expect(fetched, 'a new run may start once the first has ended').toHaveLength(2);
  });

  it('fetch-cancel for the running id stops it; one for another id does nothing', async () => {
    const { panel, emit, ends } = fakePanel();
    const { deps, fetched } = fakeDeps();
    // The first answer is a 429, so the run waits in sleep(). This sleep holds until the cancel aborts it.
    const rateLimited: Omit<FetchQueueDeps, 'post' | 'pacer'> = {
      ...deps,
      fetch: async (input) => { fetched.push(input); return { status: 429, url: new URL(input, 'https://www.swimcloud.com').href, headers: new Headers(), text: () => Promise.resolve('') }; },
      sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    };
    bindFetchQueue(panel, rateLimited, fakeLog());
    emit({ kind: 'fetch-run', runId: 'c1', feature: 'roster', targets: [RUN_TARGET, { ...RUN_TARGET, teamId: '48' }] });
    await sleep(10);
    emit({ kind: 'fetch-cancel', runId: 'someone-else' });
    await sleep(10);
    expect(ends()).toHaveLength(0);
    emit({ kind: 'fetch-cancel', runId: 'c1' });
    await sleep(10);
    expect(ends()).toStrictEqual([{ kind: 'fetch-end', runId: 'c1', delivered: 0, stopped: { reason: 'cancelled', index: 0, status: 0, detail: 'cancelled' } }]);
    expect(fetched).toHaveLength(1);
  });

  it('a malformed fetch-run is refused when it has a run id and dropped when it has none', async () => {
    const { panel, emit, ends, sent } = fakePanel();
    const { deps, fetched } = fakeDeps();
    const log = fakeLog();
    bindFetchQueue(panel, deps, log);
    emit({ kind: 'fetch-run', runId: 'm1', feature: 'swimmer-times', targets: [RUN_TARGET] });
    emit({ kind: 'fetch-run', runId: 'm2', feature: 'roster', targets: 'all' });
    emit({ kind: 'fetch-run', feature: 'roster', targets: [RUN_TARGET] });
    emit({ kind: 'fetch-run', runId: '', feature: 'roster', targets: [RUN_TARGET] });
    emit('fetch-run');
    emit(null);
    emit({ kind: 'ping', n: 1 });
    await sleep(10);
    expect(fetched).toStrictEqual([]);
    expect(ends().map((e) => [e.runId, e.stopped?.reason])).toStrictEqual([['m1', 'refused'], ['m2', 'refused'], ['', 'refused']]);
    expect(sent).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  it('a run with a target the module did not build is refused and sends nothing', async () => {
    const { panel, emit, ends } = fakePanel();
    const { deps, fetched } = fakeDeps();
    bindFetchQueue(panel, deps, fakeLog());
    emit({ kind: 'fetch-run', runId: 'x', feature: 'roster', targets: [{ ...RUN_TARGET, teamId: '58/../x' }] });
    await sleep(10);
    expect(fetched).toStrictEqual([]);
    expect(ends()).toMatchObject([{ runId: 'x', stopped: { reason: 'refused', index: 0 } }]);
  });

  it('two runs in a row keep the 3000 ms gap, and the second is neither busy nor lock-held (review item 1)', async () => {
    const { panel, emit, ends } = fakePanel();
    const { deps, starts } = fakeDeps();
    const c = bindFetchQueue(panel, deps, fakeLog());
    emit({ kind: 'fetch-run', runId: 'a', feature: 'roster', targets: [RUN_TARGET] });
    await sleep(5);
    expect(ends().map((e) => e.runId)).toStrictEqual(['a']);
    expect(c.activeRunId(), 'the run is over once its fetch-end is out').toBeNull();
    emit({ kind: 'fetch-run', runId: 'b', feature: 'roster', targets: [RUN_TARGET] });
    await sleep(5);
    expect(ends().map((e) => [e.runId, e.stopped?.reason])).toStrictEqual([['a', 'unexpected-status'], ['b', 'unexpected-status']]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(3000);
  });

  it('a fetch-run that reuses the running id is dropped and logged, never answered (review item 3)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { panel, emit, ends } = fakePanel();
    const { deps, fetched } = fakeDeps({ hold });
    const log = fakeLog();
    bindFetchQueue(panel, deps, log);
    emit({ kind: 'fetch-run', runId: 'same', feature: 'roster', targets: [RUN_TARGET] });
    await sleep(5);
    emit({ kind: 'fetch-run', runId: 'same', feature: 'roster', targets: [RUN_TARGET] });
    emit({ kind: 'fetch-run', runId: 'same', feature: 'not-a-feature', targets: 'x' }); // malformed, same id
    expect(ends(), 'no fetch-end for the duplicate, which would end the live run in the panel').toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(2);
    release();
    await sleep(20);
    expect(ends().map((e) => e.runId)).toStrictEqual(['same']);
    expect(fetched).toHaveLength(1);
  });

  it('closing the port aborts the run in flight, and the lock is let go (review item 4)', async () => {
    const { panel, emit, ends, disconnect } = fakePanel();
    const { deps, fetched } = fakeDeps({ hung: true });
    const c = bindFetchQueue(panel, deps, fakeLog());
    emit({ kind: 'fetch-run', runId: 'gone', feature: 'roster', targets: [RUN_TARGET, { ...RUN_TARGET, teamId: '48' }] });
    await sleep(5);
    expect(fetched).toHaveLength(1);
    expect(c.activeRunId()).toBe('gone');
    disconnect();
    await sleep(10);
    expect(ends()).toStrictEqual([{ kind: 'fetch-end', runId: 'gone', delivered: 0, stopped: { reason: 'cancelled', index: 0, status: 0, detail: 'the panel disconnected' } }]);
    expect(c.activeRunId()).toBeNull();
    expect(fetched, 'the second target was never sent').toHaveLength(1);
    // The lock is free again: a new run is not lock-held.
    emit({ kind: 'fetch-run', runId: 'again', feature: 'roster', targets: [RUN_TARGET] });
    await sleep(10);
    expect(fetched).toHaveLength(2);
  });

  it('fetch-cancel stops a hung request: exactly one fetch-end, active cleared (review item 2)', async () => {
    const { panel, emit, ends } = fakePanel();
    const { deps } = fakeDeps({ hung: true });
    const c = bindFetchQueue(panel, deps, fakeLog());
    emit({ kind: 'fetch-run', runId: 'h1', feature: 'roster', targets: [RUN_TARGET] });
    await sleep(5);
    emit({ kind: 'fetch-cancel', runId: 'h1' });
    await sleep(10);
    expect(ends()).toStrictEqual([{ kind: 'fetch-end', runId: 'h1', delivered: 0, stopped: { reason: 'cancelled', index: 0, status: 0, detail: 'cancelled' } }]);
    expect(c.activeRunId()).toBeNull();
  });

  it('a crash inside the queue ends the run with internal, the index in progress and the real delivered count (review item 6)', async () => {
    const { panel, emit, ends } = fakePanel({ failOn: (m) => m.kind === 'fetch-item' && m.index === 1 });
    const { deps } = fakeDeps({ answer: 'roster' });
    const log = fakeLog();
    const c = bindFetchQueue(panel, deps, log);
    emit({ kind: 'fetch-run', runId: 'boom', feature: 'roster', targets: [RUN_TARGET, { ...RUN_TARGET, teamId: '48' }, { ...RUN_TARGET, teamId: '412' }] });
    await sleep(20);
    expect(ends()).toStrictEqual([{ kind: 'fetch-end', runId: 'boom', delivered: 1, stopped: { reason: 'internal', index: 1, status: 0, detail: expect.stringContaining('port closed') } }]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(c.activeRunId()).toBeNull();
  });

  it('the guards accept only their own message', () => {
    expect(isFetchRun({ kind: 'fetch-run', runId: 'r', feature: 'lcm', targets: [] })).toBe(true);
    expect(isFetchRun({ kind: 'fetch-run', runId: 'r', feature: 'nope', targets: [] })).toBe(false);
    expect(isFetchCancel({ kind: 'fetch-cancel', runId: 'r' })).toBe(true);
    expect(isFetchCancel({ kind: 'fetch-cancel' })).toBe(false);
  });
});

// ---- DockedPanel.onDisconnect (review item 4) -------------------------------------------------------------------

describe('DockedPanel.onDisconnect', () => {
  it('fires when the live port closes, once, and not for a port that was already replaced', async () => {
    vi.useFakeTimers();
    try {
      const w = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/' });
      const host = mountShadowHost(w.document as unknown as Document);
      const ports: Array<{ drop(): void }> = [];
      const runtime: PanelRuntime = {
        getURL: (p) => `chrome-extension://abc/${p}`,
        connect: () => {
          const closers: Array<() => void> = [];
          const port: PanelPort & { drop(): void } = {
            postMessage: () => undefined,
            disconnect: () => undefined,
            onMessage: { addListener: () => undefined },
            onDisconnect: { addListener: (cb) => { closers.push(cb); } },
            drop: () => { for (const cb of closers) cb(); },
          };
          ports.push(port);
          return port;
        },
      };
      const panel = mountDockedPanel(host, runtime, { retryDelayMs: 5 });
      const gone = vi.fn();
      panel.onDisconnect(gone);
      panel.iframe.dispatchEvent(new w.Event('load') as unknown as Event);
      expect(gone).not.toHaveBeenCalled();
      ports[0]!.drop();
      expect(gone).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5);
      expect(ports).toHaveLength(2);
      ports[0]!.drop(); // the old port reports again after the new one took over
      expect(gone).toHaveBeenCalledTimes(1);
      ports[1]!.drop();
      expect(gone).toHaveBeenCalledTimes(2);
      await w.happyDOM.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseSeasonChoices, duplicate season id (review item 7)', () => {
  it('drops the whole list when two rows share a seasonId, also across number and string', () => {
    const dup = SEASONS.map((s, i) => (i === 4 ? { ...s, seasonId: 19 } : s));
    expect(parseSeasonChoices(dup)).toMatchObject({ ok: false, reason: '[4].seasonId: duplicate 19' });
    expect(parseSeasonChoices(SEASONS.map((s, i) => (i === 4 ? { ...s, seasonId: '19' } : s)))).toMatchObject({ ok: false });
  });
});
