/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Automated stand-in for "load unpacked, open the simulator, see a SimSnapshot
 * in the console" (P1.skeleton). A fresh happy-dom window per test holds:
 *
 *  - a fake XMLHttpRequest and a fake fetch, which the bridge wraps;
 *  - a fake `#simulator` element with a `__reactContainer$...` key, a fiber whose
 *    `memoizedProps.store` is a fake Redux store shaped from recon Q5 and S1.
 *
 * (jsdom is not installed in this repo. happy-dom is, and it covers the same DOM
 * surface the bridge and overlay use.)
 *
 * The store rows come from the committed fixtures in
 * tests/fixtures/swimcloud/simulator/. The fixtures keep swim rows as positional
 * arrays; `inflate` turns them into the object shape the live page holds. The
 * fixtures themselves are never edited. Fixture swimmers are sanitized ("T58-S01"),
 * so a swimmer's name here is that code.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Window as HappyWindow } from 'happy-dom';
import { installBridge } from '../apps/extension/src/bridge/install';
import { LOG_PREFIX, mountShadowHost, startOverlay, type OverlayLog } from '../apps/extension/src/overlay/overlay';
import * as z from 'zod/mini';
import { parseBridgeMessage } from '../apps/extension/src/shared/bridgeSchema';

type Obj = Record<string, unknown>;
type Win = Window & typeof globalThis;

const URL_BASE = 'https://www.swimcloud.com/meetsimulator/?teams=48,58';
const SIM_PATH = '/api/teams/58/simulator/?start_date=2025-09-01&end_date=2026-08-31&eventgender=M&eventcourse=Y&divecourse=6&time_to_use=fastest';
const FIXTURES = path.join(__dirname, 'fixtures', 'swimcloud', 'simulator');
const fixture = (name: string): Obj => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Obj;

// ---- store, shaped from the fixtures -------------------------------------------------------

type Row = [string, number, string, string, string | null, boolean | null];
let rowCounter = 0;
/** Recon Q5: every row carries id, eventstroke, eventdistance, eventcourse, eventgender, numlegs, eventtime, flystart, pointvalue. */
const rowToObject = (r: Row): Obj => ({
  id: `row-${(rowCounter += 1)}`, // the fixtures strip ids; this is a test-only stand-in
  numlegs: r[0] === '6' || r[0] === '7' ? 4 : 1,
  eventstroke: r[0],
  eventdistance: r[1],
  eventcourse: r[2],
  eventtime: r[3],
  pointvalue: r[4],
  flystart: r[5],
  eventgender: 'M',
});

/** One roster as the page holds it: swim rows carry `swimmer` and `team` back-references (a cyclic graph). */
function inflateRoster(file: string, team: Obj): Obj {
  const raw = fixture(file) as { swimmers: Obj[]; relays: Row[] };
  const swimmers = raw.swimmers.map((s) => {
    const swimmer: Obj = { id: s.sid, name: s.sid, gender: s.gender, gradcollege: s.gradcollege };
    const wrap = (rows: Row[]) => rows.map((r) => ({ ...rowToObject(r), swimmer, team }));
    swimmer.indrecords = wrap(s.indrecords as Row[]);
    swimmer.relaysplits = wrap(s.relaysplits as Row[]);
    swimmer.relayleadoffs = wrap(s.relayleadoffs as Row[]);
    return swimmer;
  });
  // Live store, 2026-10-26 (teams 48 and 58): a relay row has no `flystart` key at all. The fixture's
  // positional null is only the array format, so drop the key here to match the page.
  const relays = raw.relays.map((r) => {
    const { flystart: _absent, ...row } = rowToObject(r);
    return { ...row, team };
  });
  return { swimmers, relays };
}

/**
 * The page's `gf` sets `points` to a table lookup, which is `undefined` past the last place. JSON shows
 * that as `null` in the fixture. Leg splashes never go through `gf`, so they have no `points` key at all.
 */
const pointsOf = (fixturePoints: unknown): unknown => fixturePoints ?? undefined;

/** The page's chosen entries (config `results`), as splash objects. Relay legs get a `relay_id`. */
function inflateSplashes(config: { results: Record<string, unknown[][]> }, teams: Map<number, Obj>): Obj[] {
  const splashes: Obj[] = [];
  for (const [key, entries] of Object.entries(config.results)) {
    const parts = key.split('|');
    const dive = parts[0] === 'H';
    const event = dive
      ? { eventstroke: 'H', eventdistance: Number(parts[1]), eventcourse: '' }
      : { eventstroke: parts[0], eventdistance: Number(parts[1]), eventcourse: parts[2] };
    for (const entry of entries) {
      const team = teams.get(entry[0] as number);
      const who = entry[1] as string;
      if (who.startsWith('relay:')) {
        const relayId = `${key}#${entry[0]}#${who}`;
        splashes.push({ ...event, id: relayId, team, points: pointsOf(entry[3]), eventtime: entry[2] });
        (entry[4] as string[]).forEach((sid, i) =>
          splashes.push({ ...event, id: `${relayId}#${i + 1}`, team, swimmer: { id: sid }, relay_id: relayId, legposition: i + 1, eventtime: null }), // the fixture has no per-leg times
        );
      } else {
        splashes.push({ ...event, id: `${key}#${entry[0]}#${who}`, team, swimmer: { id: who }, points: pointsOf(entry[3]), eventtime: entry[2] });
      }
    }
  }
  return splashes;
}

function buildState(): Obj {
  const config = fixture('config-A.json') as { teams: Obj[]; settings: Obj; results: Record<string, unknown[][]>; totalScores: Obj };
  const teams = config.teams;
  const byId = new Map(teams.map((t) => [t.id as number, t]));
  const settings = { ...config.settings };
  delete settings.presetId; // derived by the page, not a store key
  delete settings.meetChanges;
  const origRosters = { 58: inflateRoster('team-58.json', byId.get(58)!), 48: inflateRoster('team-48.json', byId.get(48)!) };
  return {
    ...settings,
    seasonId: null,
    teams,
    origRosters,
    rosters: origRosters, // no coach edits: the page's `rosters` equals `origRosters` minus inactive swimmers
    simulatedMeet: { splashes: inflateSplashes(config, byId) },
    totalScores: config.totalScores,
    inactiveSwimmers: [],
    meetChanges: [],
  };
}

/** Stand-in for the Redux store: `getState`, `subscribe`, and a `set` that notifies. */
function fakeStore(initial: Obj) {
  let state = initial;
  const listeners: Array<() => void> = [];
  return {
    getState: () => state,
    subscribe: (l: () => void) => {
      listeners.push(l);
      return () => undefined;
    },
    set(patch: Obj) {
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
  };
}

// ---- window, XHR and fetch fakes -----------------------------------------------------------

class FakeXHR {
  static instances: FakeXHR[] = [];
  responseType: XMLHttpRequestResponseType = '';
  status = 0;
  bodyReads = 0;
  responseURL = '';
  private loadListeners: Array<{ listener: () => void; once: boolean }> = [];
  private text = '';
  private requestUrl = '';
  open(_method: string, url: string): void {
    // A reused XHR is the same object: listeners from earlier sends stay, as in a browser.
    if (!FakeXHR.instances.includes(this)) FakeXHR.instances.push(this);
    this.requestUrl = new URL(url, 'https://www.swimcloud.com').href;
  }
  send(): void {
    // The real request would start here.
  }
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void {
    if (type === 'load') this.loadListeners.push({ listener, once: options?.once === true });
  }
  get responseText(): string {
    this.bodyReads += 1;
    return this.text;
  }
  get response(): unknown {
    this.bodyReads += 1;
    return JSON.parse(this.text);
  }
  /** Finish the request, as the network would. */
  respond(status: number, text: string, responseURL?: string): void {
    this.status = status;
    this.text = text;
    this.responseURL = responseURL ?? this.requestUrl;
    const fire = [...this.loadListeners];
    this.loadListeners = this.loadListeners.filter((l) => !l.once);
    for (const l of fire) l.listener();
  }
}

interface Harness {
  win: Win;
  posted: Obj[];
  fetchCalls: string[];
  cloneCalls: string[];
  /** Status the fake network answers with. */
  status: number;
  /** The promise the native (fake) fetch returned last. */
  nativePromise: Promise<unknown> | undefined;
  /** Final URL the fake fetch reports, as after a redirect. Unset: the requested URL. */
  finalUrl?: string;
}

function makeWindow(): Harness {
  const win = new HappyWindow({ url: URL_BASE }) as unknown as Win;
  FakeXHR.instances = [];
  const harness: Harness = { win, posted: [], fetchCalls: [], cloneCalls: [], status: 200, nativePromise: undefined };
  // A subclass per window: the bridge patches the prototype it finds, and bridges from earlier tests must not stack on this one.
  Object.defineProperty(win, 'XMLHttpRequest', { value: class extends FakeXHR {}, configurable: true, writable: true });
  Object.defineProperty(win, 'fetch', {
    configurable: true,
    writable: true,
    value: (input: unknown) => {
      const url = typeof input === 'string' ? input : ((input as { url?: string } | null)?.url ?? String(input));
      harness.fetchCalls.push(url);
      const body = { swimmers: [], relays: [] };
      harness.nativePromise = Promise.resolve({
        ok: harness.status === 200,
        status: harness.status,
        url: harness.finalUrl ?? new URL(url, 'https://www.swimcloud.com').href,
        clone: () => {
          harness.cloneCalls.push(url);
          return { json: () => Promise.resolve(body) };
        },
      });
      return harness.nativePromise;
    },
  });
  // Capture what the bridge posts, as the structured-clone boundary would see it. Nothing is delivered.
  vi.spyOn(win, 'postMessage').mockImplementation(((message: unknown, targetOrigin?: string) => {
    expect(targetOrigin, 'bridge messages go to this origin only').toBe('https://www.swimcloud.com');
    harness.posted.push(message as Obj);
  }) as typeof win.postMessage);
  return harness;
}

/** Add `#simulator` with the `__reactContainer$` fiber path the bridge walks. */
function mountSimulator(win: Win, store: unknown, depth = 2): HTMLElement {
  const el = win.document.createElement('div');
  el.id = 'simulator';
  let fiber: Obj = { memoizedProps: { store }, child: null };
  for (let i = 1; i < depth; i += 1) fiber = { memoizedProps: null, child: fiber };
  (el as unknown as Obj)['__reactContainer$x1y2z3'] = fiber;
  win.document.body.append(el);
  return el;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ofKind = (h: Harness, kind: string): Obj[] => h.posted.filter((m) => m.kind === kind);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- bridge --------------------------------------------------------------------------------

describe('sim-bridge: network hook (D3 2.7)', () => {
  it('posts the response body of the simulator request only', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    const sim = new h.win.XMLHttpRequest();
    sim.open('GET', SIM_PATH);
    sim.send();
    const other = new h.win.XMLHttpRequest();
    other.open('GET', '/api/seasonchoices/?count=10&from_next=false');
    other.send();
    const lookalike = new h.win.XMLHttpRequest();
    lookalike.open('GET', '/api/teams/58/simulator/extra/');
    lookalike.send();
    const foreign = new h.win.XMLHttpRequest();
    foreign.open('GET', 'https://example.com/api/teams/58/simulator/');
    foreign.send();

    const body = { swimmers: [{ id: 1 }], relays: [] };
    for (const x of FakeXHR.instances) x.respond(200, JSON.stringify(body));

    const responses = ofKind(h, 'response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toStrictEqual({ source: 'osx-bridge', v: 1, kind: 'response', url: SIM_PATH, body });
    // The bridge never opened the bodies of the other requests.
    const reads = FakeXHR.instances.map((x) => x.bodyReads);
    expect(reads).toStrictEqual([1, 0, 0, 0]);
  });

  it('a reused XMLHttpRequest posts each simulator response under its own URL and never reads other bodies', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    const p58 = '/api/teams/58/simulator/?eventgender=M';
    const p48 = '/api/teams/48/simulator/?eventgender=M';
    const body58 = { swimmers: [{ id: 58 }], relays: [] };
    const body48 = { swimmers: [{ id: 48 }], relays: [] };
    const x = new h.win.XMLHttpRequest() as unknown as FakeXHR;
    x.open('GET', p58);
    x.send();
    x.respond(200, JSON.stringify(body58));
    x.open('GET', p48);
    x.send();
    x.respond(200, JSON.stringify(body48));
    x.open('GET', '/api/teams/search/?q=x');
    x.send();
    x.respond(200, JSON.stringify({ teams: [] }));

    const responses = ofKind(h, 'response');
    expect(responses.map((m) => m.url)).toStrictEqual([p58, p48]);
    expect(responses.map((m) => m.body)).toStrictEqual([body58, body48]);
    expect(ofKind(h, 'error')).toHaveLength(0);
    expect(x.bodyReads, 'the search response body was read').toBe(2);
  });

  it('an aborted simulator request leaves nothing behind for the next request on the same XMLHttpRequest', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    const x = new h.win.XMLHttpRequest() as unknown as FakeXHR;
    x.open('GET', '/api/teams/58/simulator/?eventgender=M');
    x.send(); // never answered: aborted
    x.open('GET', '/api/seasonchoices/?count=10');
    x.send();
    x.respond(200, JSON.stringify({ seasons: [] }));
    expect(h.posted).toHaveLength(0);
    expect(x.bodyReads).toBe(0);
  });

  it('drops a simulator response whose final URL is not the simulator path', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    const x = new h.win.XMLHttpRequest() as unknown as FakeXHR;
    x.open('GET', SIM_PATH);
    x.send();
    x.respond(200, JSON.stringify({ swimmers: [], relays: [] }), 'https://www.swimcloud.com/api/teams/search/?q=x');
    expect(ofKind(h, 'response')).toHaveLength(0);
    expect(ofKind(h, 'error')).toMatchObject([{ code: 'response-url' }]);
    expect(JSON.stringify(h.posted), 'the final non-simulator URL never leaves the bridge').not.toContain('/api/teams/search/');
  });

  it('drops a simulator fetch whose final URL is not the simulator path, and reads no body', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    h.finalUrl = 'https://www.swimcloud.com/api/teams/search/?q=x';
    await h.win.fetch(SIM_PATH);
    await sleep(5);
    expect(ofKind(h, 'response')).toHaveLength(0);
    expect(ofKind(h, 'error')).toMatchObject([{ code: 'response-url' }]);
    expect(h.cloneCalls).toHaveLength(0);
    expect(JSON.stringify(h.posted)).not.toContain('/api/teams/search/');
  });

  it('wraps XMLHttpRequest.prototype before the page uses it, and still calls the original', () => {
    const h = makeWindow();
    const originalOpen = vi.spyOn(FakeXHR.prototype, 'open');
    const originalSend = vi.spyOn(FakeXHR.prototype, 'send');
    installBridge(h.win, { deadlineMs: 5_000 });
    const x = new h.win.XMLHttpRequest();
    x.open('GET', SIM_PATH);
    x.send();
    expect(originalOpen).toHaveBeenCalledWith('GET', SIM_PATH);
    expect(originalSend).toHaveBeenCalledTimes(1);
    expect(h.win.XMLHttpRequest.prototype.open).not.toBe(FakeXHR.prototype.open);
  });

  it('reports a non-200 simulator response as an error, not as data', () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    const x = new h.win.XMLHttpRequest();
    x.open('GET', SIM_PATH);
    x.send();
    (x as unknown as FakeXHR).respond(503, 'busy');
    expect(ofKind(h, 'response')).toHaveLength(0);
    expect(ofKind(h, 'error')).toStrictEqual([
      { source: 'osx-bridge', v: 1, kind: 'error', code: 'http-status', detail: `503 ${SIM_PATH}` },
    ]);
  });

  it('clones only simulator fetch responses', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    await h.win.fetch(SIM_PATH);
    await h.win.fetch('/api/seasonchoices/?count=10&from_next=false');
    await h.win.fetch(new URL(SIM_PATH, 'https://www.swimcloud.com') as unknown as string);
    await h.win.fetch(new h.win.Request(`https://www.swimcloud.com${SIM_PATH}`));
    await sleep(5);
    expect(h.fetchCalls).toHaveLength(4);
    const abs = `https://www.swimcloud.com${SIM_PATH}`;
    expect(h.cloneCalls).toStrictEqual([SIM_PATH, abs, abs]);
    expect(ofKind(h, 'response')).toHaveLength(3);
  });

  it('returns the native fetch promise unchanged, even for fetch(null) and fetch(undefined)', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    for (const input of [null, undefined, 42, {}]) {
      let returned: unknown;
      expect(() => {
        returned = h.win.fetch(input as unknown as string);
      }, `fetch(${String(input)}) threw inside the wrapper`).not.toThrow();
      expect(returned).toBe(h.nativePromise);
    }
    await sleep(5);
    expect(h.posted).toHaveLength(0);
  });

  it('reports a non-200 simulator fetch as http-status, like the XHR path, and reads no body', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 5_000 });
    h.status = 404;
    const returned = h.win.fetch(SIM_PATH);
    expect(returned).toBe(h.nativePromise);
    await returned;
    await sleep(5);
    expect(ofKind(h, 'response')).toHaveLength(0);
    expect(h.cloneCalls).toHaveLength(0);
    expect(ofKind(h, 'error')).toStrictEqual([
      { source: 'osx-bridge', v: 1, kind: 'error', code: 'http-status', detail: `404 ${SIM_PATH}` },
    ]);
  });
});

describe('sim-bridge: Redux store (D3 2.7)', () => {
  it('posts a SimSnapshot once #simulator mounts, with the documented fields', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    expect(ofKind(h, 'snapshot')).toHaveLength(0);

    const store = fakeStore(buildState());
    mountSimulator(h.win, store);
    await sleep(30);

    const snapshots = ofKind(h, 'snapshot');
    expect(snapshots).toHaveLength(1);
    const message = snapshots[0] as { source: string; v: number; kind: string; snapshot: Obj };
    expect(message.source).toBe('osx-bridge');
    expect(message.v).toBe(1);
    expect(Object.keys(message.snapshot).sort()).toStrictEqual(['rosters', 'settings', 'splashes', 'swimmers', 'swims', 'teams', 'totalScores']);

    const snap = message.snapshot as {
      teams: Obj[];
      swimmers: Obj[];
      swims: Obj[];
      settings: Obj;
      splashes: Obj[];
      totalScores: Obj;
    };
    expect(snap.teams.map((t) => t.id)).toStrictEqual([58, 48]);
    expect(snap.swimmers.length).toBeGreaterThan(40);
    expect(snap.swimmers.every((s) => s.teamId === 58 || s.teamId === 48)).toBe(true);
    // SwimCloud's own scores come through untouched (fixture config-A: 58 scores 186, 48 scores 102).
    expect(snap.totalScores).toStrictEqual({ 48: { points: 102, place: 2 }, 58: { points: 186, place: 1 } });
    expect(snap.settings.pointSystem).toBe('college');
    expect(snap.settings.maxScorersPerTeam).toBe(3);
    expect(snap.settings.inactiveSwimmers).toStrictEqual([]);
    expect(snap.settings.meetChanges).toStrictEqual([]);
    expect(snap.settings.eventIds).toHaveLength(16);

    // swims: every kind, each pointing at a swimmer or null (relay rows), none carrying the object graph.
    const kinds = new Set(snap.swims.map((s) => s.kind));
    expect([...kinds].sort()).toStrictEqual(['ind', 'leadoff', 'relay', 'split']);
    expect(snap.swims.filter((s) => s.kind === 'relay').every((s) => s.swimmerId === null)).toBe(true);
    expect(snap.swims.every((s) => !('swimmer' in s) && !('team' in s))).toBe(true);
    expect(() => JSON.stringify(snap)).not.toThrow();

    // splashes: the page's chosen entries, with points, and relay legs linked by relay_id.
    expect(snap.splashes.length).toBeGreaterThan(50);
    const relayLeg = snap.splashes.find((s) => s.relay_id !== undefined);
    expect(relayLeg).toBeDefined();
    expect(relayLeg?.swimmerId).toMatch(/^T\d+-S\d+$/);
    expect(snap.splashes.some((s) => s.points === 9)).toBe(true);
    // Live shape: an entry past the point table, and every relay leg, has no `points` key.
    expect(snap.splashes.some((s) => !('points' in s))).toBe(true);
    expect(snap.splashes.filter((s) => s.relay_id !== undefined).every((s) => !('points' in s))).toBe(true);
    expect(snap.splashes.every((s) => !('swimmer' in s) && !('team' in s))).toBe(true);

    // The overlay's schema accepts the bridge's real output.
    expect(parseBridgeMessage(message)).toMatchObject({ ok: true });
  });

  it('finds the store through a deeper fiber chain, and debounces a burst of changes into one snapshot', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 20, deadlineMs: 5_000 });
    const store = fakeStore(buildState());
    mountSimulator(h.win, store, 5);
    await sleep(40);
    expect(ofKind(h, 'snapshot')).toHaveLength(1);

    store.set({ maxScorersPerTeam: 2 });
    store.set({ maxScorersPerTeam: 4 });
    store.set({ maxScorersPerTeam: 5 });
    expect(ofKind(h, 'snapshot')).toHaveLength(1);
    await sleep(60);
    const snapshots = ofKind(h, 'snapshot') as Array<{ snapshot: { settings: Obj } }>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.snapshot.settings.maxScorersPerTeam).toBe(5);
  });

  it('posts an error, not a row with a hole, when a swim row lacks a key recon Q5 says it carries', async () => {
    for (const key of ['id', 'eventstroke', 'eventdistance', 'eventcourse', 'eventgender', 'numlegs', 'eventtime', 'flystart', 'pointvalue']) {
      const h = makeWindow();
      installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
      const broken = buildState();
      const first = ((broken.origRosters as Obj)[58] as { swimmers: Array<{ indrecords: Obj[] }> }).swimmers[0]!.indrecords[0]!;
      delete first[key];
      mountSimulator(h.win, fakeStore(broken));
      await sleep(25);
      expect(ofKind(h, 'snapshot'), `a row without ${key} was posted`).toHaveLength(0);
      expect(ofKind(h, 'error')).toMatchObject([{ code: 'store-shape', detail: expect.stringContaining(`.${key}`) }]);
    }
  });

  it('accepts a relay row with no flystart key, as the live store has it, and posts it without one', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    const state = buildState();
    const relays = ((state.origRosters as Obj)[48] as { relays: Obj[] }).relays;
    expect(relays.length).toBeGreaterThan(0);
    expect(relays.every((r) => !('flystart' in r)), 'the fixture must match the live relay shape').toBe(true);
    mountSimulator(h.win, fakeStore(state));
    await sleep(25);
    expect(ofKind(h, 'error')).toHaveLength(0);
    const [message] = ofKind(h, 'snapshot') as Array<{ snapshot: { swims: Obj[] } }>;
    const relayRows = message!.snapshot.swims.filter((s) => s.kind === 'relay');
    expect(relayRows.length).toBeGreaterThan(0);
    expect(relayRows.every((s) => !('flystart' in s)), 'a relay row gained a flystart the page never had').toBe(true);
  });

  it('still posts an error when a relay row lacks any of its eight keys', async () => {
    for (const key of ['id', 'eventstroke', 'eventdistance', 'eventcourse', 'eventgender', 'numlegs', 'eventtime', 'pointvalue']) {
      const h = makeWindow();
      installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
      const broken = buildState();
      delete ((broken.origRosters as Obj)[58] as { relays: Obj[] }).relays[0]![key];
      mountSimulator(h.win, fakeStore(broken));
      await sleep(25);
      expect(ofKind(h, 'snapshot'), `a relay row without ${key} was posted`).toHaveLength(0);
      expect(ofKind(h, 'error')).toMatchObject([{ code: 'store-shape', detail: expect.stringContaining(`relays.${key}`) }]);
    }
  });

  // Live store, 2026-10-26 (teams 48 and 58): pointvalue is null on relay splits and some individual
  // rows; flystart is never null (true on splits, false on individual and leadoff rows).
  it('keeps null where the live data is null (pointvalue), and flystart as the page holds it', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    mountSimulator(h.win, fakeStore(buildState()));
    await sleep(25);
    const [message] = ofKind(h, 'snapshot') as Array<{ snapshot: { swims: Obj[] } }>;
    const swims = message!.snapshot.swims;
    expect(swims.some((s) => s.pointvalue === null)).toBe(true);
    expect(swims.filter((s) => s.kind === 'split').every((s) => s.flystart === true)).toBe(true);
    expect(swims.filter((s) => s.kind === 'ind' || s.kind === 'leadoff').every((s) => s.flystart === false)).toBe(true);
  });

  it('posts an error when a splash lacks its team, id or time, or an individual or leg splash lacks its swimmer', async () => {
    const individual = (x: Obj) => x.swimmer && !x.relay_id;
    const cases: Array<[string, (splashes: Obj[]) => void, string]> = [
      ['no team', (s) => void delete s.find(individual)!.team, 'team'],
      ['individual with no swimmer', (s) => void delete s.find(individual)!.swimmer, 'swimmer'],
      ['leg with no swimmer', (s) => void delete s.find((x) => x.relay_id)!.swimmer, 'swimmer'],
      ['no eventtime', (s) => void delete s.find(individual)!.eventtime, 'eventtime'],
      ['no id', (s) => void delete s.find(individual)!.id, 'id'],
    ];
    for (const [label, mutate, key] of cases) {
      const h = makeWindow();
      installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
      const broken = buildState();
      mutate((broken.simulatedMeet as { splashes: Obj[] }).splashes);
      mountSimulator(h.win, fakeStore(broken));
      await sleep(25);
      expect(ofKind(h, 'snapshot'), `snapshot posted despite: ${label}`).toHaveLength(0);
      expect(ofKind(h, 'error'), label).toMatchObject([{ code: 'store-shape', detail: expect.stringContaining(`.${key}`) }]);
    }
  });

  it('accepts a relay splash with no swimmer (the page builds it from its legs)', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    mountSimulator(h.win, fakeStore(buildState()));
    await sleep(25);
    const [message] = ofKind(h, 'snapshot') as Array<{ snapshot: { splashes: Obj[] } }>;
    const relay = message?.snapshot.splashes.find((s) => s.eventstroke === '7' && s.relay_id === undefined);
    expect(relay).toBeDefined();
    expect(relay?.swimmerId).toBeNull();
  });

  it('adds the current rosters, meetChanges and exhibition so coach edits can be told from a rule mismatch', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    const state = buildState();
    const orig = state.origRosters as Record<string, { swimmers: Obj[]; relays: Obj[] }>;
    const removed = orig[58]!.swimmers[0]!;
    // Coach edit: one swimmer made inactive. The page's `rosters` drops them; `origRosters` keeps them.
    state.rosters = { ...orig, 58: { ...orig[58]!, swimmers: orig[58]!.swimmers.slice(1) } };
    state.inactiveSwimmers = [{ id: removed.id }];
    state.meetChanges = [{ type: 'REMOVE_ENTRY' }];
    (state.simulatedMeet as { splashes: Obj[] }).splashes[0]!.exhibition = true;
    mountSimulator(h.win, fakeStore(state));
    await sleep(25);
    const [message] = ofKind(h, 'snapshot') as Array<{
      snapshot: { swimmers: Obj[]; swims: Obj[]; rosters: { swimmers: Obj[]; swims: Obj[] }; settings: Obj; splashes: Obj[] };
    }>;
    expect(message).toBeDefined();
    const snap = message!.snapshot;
    expect(snap.swimmers.some((s) => s.id === removed.id)).toBe(true);
    expect(snap.rosters.swimmers.some((s) => s.id === removed.id)).toBe(false);
    expect(snap.rosters.swimmers.length).toBe(snap.swimmers.length - 1);
    expect(snap.rosters.swims.length).toBeLessThan(snap.swims.length);
    expect(snap.settings.inactiveSwimmers).toStrictEqual([removed.id]);
    expect(snap.settings.meetChanges).toStrictEqual([{ type: 'REMOVE_ENTRY' }]);
    expect(snap.splashes[0]?.exhibition).toBe(true);
    expect(snap.splashes[1] && 'exhibition' in snap.splashes[1]).toBe(false);
    expect(parseBridgeMessage(message)).toMatchObject({ ok: true });
  });

  it('posts null, not an empty list, while the page has not loaded team data', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    const loading: Obj = { ...buildState(), origRosters: null, rosters: null, simulatedMeet: null };
    delete loading.totalScores; // SwimCloud's reducer leaves it out until a meet exists
    mountSimulator(h.win, fakeStore(loading));
    await sleep(30);
    const [message] = ofKind(h, 'snapshot') as Array<{ snapshot: Obj }>;
    expect(message).toBeDefined();
    expect(message?.snapshot.swimmers).toBeNull();
    expect(message?.snapshot.swims).toBeNull();
    expect(message?.snapshot.splashes).toBeNull();
    expect(message?.snapshot.rosters).toBeNull();
    expect(message?.snapshot.totalScores).toBeNull();
    expect(ofKind(h, 'error')).toHaveLength(0);
    expect(parseBridgeMessage(message)).toMatchObject({ ok: true });
  });

  it('posts an explicit error when a store path is missing, once, and never a guessed snapshot', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    const broken = buildState();
    broken.simulatedMeet = {}; // the page's meet object has no `splashes`
    const store = fakeStore(broken);
    mountSimulator(h.win, store);
    await sleep(30);
    store.set({ maxScorersPerTeam: 2 }); // another change, same fault
    await sleep(30);

    expect(ofKind(h, 'snapshot')).toHaveLength(0);
    expect(ofKind(h, 'error')).toStrictEqual([
      { source: 'osx-bridge', v: 1, kind: 'error', code: 'store-shape', detail: 'missing store path: simulatedMeet.splashes' },
    ]);
  });

  it('posts an error naming a missing setting', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    const broken = buildState();
    delete broken.pointSystem;
    mountSimulator(h.win, fakeStore(broken));
    await sleep(30);
    expect(ofKind(h, 'error')).toMatchObject([{ code: 'store-shape', detail: 'missing store path: pointSystem' }]);
    expect(ofKind(h, 'snapshot')).toHaveLength(0);
  });

  it('posts store-not-found at the deadline, with the reason, when the fiber path is missing', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 40 });
    const el = h.win.document.createElement('div');
    el.id = 'simulator'; // mounted, but no __reactContainer$ key
    h.win.document.body.append(el);
    await sleep(80);
    expect(h.posted).toStrictEqual([
      { source: 'osx-bridge', v: 1, kind: 'error', code: 'store-not-found', detail: '#simulator has no __reactContainer$ key' },
    ]);
  });

  it('says so when the Provider is not in the fiber tree', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 40 });
    mountSimulator(h.win, { notAStore: true });
    await sleep(80);
    expect(ofKind(h, 'error')).toMatchObject([{ code: 'store-not-found', detail: expect.stringContaining('no Provider store') }]);
  });

  it('says so when #simulator never mounts', async () => {
    const h = makeWindow();
    installBridge(h.win, { deadlineMs: 30 });
    await sleep(70);
    expect(ofKind(h, 'error')).toMatchObject([{ code: 'store-not-found', detail: 'no #simulator element' }]);
  });

  it('re-posts the latest snapshot when the overlay says it is ready', async () => {
    const h = makeWindow();
    installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
    mountSimulator(h.win, fakeStore(buildState()));
    await sleep(30);
    expect(ofKind(h, 'snapshot')).toHaveLength(1);

    h.win.dispatchEvent(
      new h.win.MessageEvent('message', { data: { source: 'osx-overlay', v: 1, kind: 'ready' }, origin: 'https://www.swimcloud.com', source: h.win }),
    );
    expect(ofKind(h, 'snapshot')).toHaveLength(2);

    // A page script that is not this window cannot ask for it.
    h.win.dispatchEvent(
      new h.win.MessageEvent('message', { data: { source: 'osx-overlay', v: 1, kind: 'ready' }, origin: 'https://www.swimcloud.com' }),
    );
    expect(ofKind(h, 'snapshot')).toHaveLength(2);
  });
});

// ---- overlay -------------------------------------------------------------------------------

interface FakeLog {
  log: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
}

function fakeLog(): FakeLog & OverlayLog {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as FakeLog & OverlayLog;
}

function deliver(win: Win, data: unknown, init: { origin?: string; fromWindow?: boolean } = {}): void {
  win.dispatchEvent(
    new win.MessageEvent('message', {
      data,
      origin: init.origin ?? 'https://www.swimcloud.com',
      ...(init.fromWindow === false ? {} : { source: win }),
    }),
  );
}

async function realSnapshotMessage(): Promise<Obj> {
  const h = makeWindow();
  installBridge(h.win, { debounceMs: 5, deadlineMs: 5_000 });
  mountSimulator(h.win, fakeStore(buildState()));
  await sleep(30);
  const [message] = ofKind(h, 'snapshot');
  if (!message) throw new Error('the bridge posted no snapshot');
  return message;
}

describe('sim-overlay: validates every bridge message (bridge trust rule)', () => {
  it('logs a valid SimSnapshot with the [OmniSwim] prefix', async () => {
    const message = await realSnapshotMessage();
    const h = makeWindow();
    const log = fakeLog();
    startOverlay(h.win, log);
    deliver(h.win, message);
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0]?.[0]).toBe('[OmniSwim] SimSnapshot');
    expect(LOG_PREFIX).toBe('[OmniSwim]');
    const logged = log.log.mock.calls[0]?.[1] as Obj;
    expect(Object.keys(logged).sort()).toStrictEqual(['rosters', 'settings', 'splashes', 'swimmers', 'swims', 'teams', 'totalScores']);
    expect(log.warn).not.toHaveBeenCalled();
    expect(h.win.document.querySelector<HTMLElement>('[data-osx-host]')?.dataset.osxState).toBe('ready');
  });

  it('drops malformed bridge messages and logs no snapshot', async () => {
    const good = (await realSnapshotMessage()) as { snapshot: Obj };
    const h = makeWindow();
    const log = fakeLog();
    startOverlay(h.win, log);
    const malformed: unknown[] = [
      { source: 'osx-bridge', v: 1, kind: 'snapshot' }, // no snapshot
      { source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: { ...good.snapshot, teams: 'not a list' } },
      { source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: { ...good.snapshot, totalScores: { 58: { points: 'many', place: 1 } } } },
      { source: 'osx-bridge', v: 2, kind: 'snapshot', snapshot: good.snapshot }, // wrong version
      { source: 'osx-bridge', v: 1, kind: 'rm -rf' }, // unknown kind
      { source: 'osx-bridge', v: 1, kind: 'response', url: '/api/seasonchoices/', body: { swimmers: [], relays: [] } }, // other path
      { source: 'osx-bridge', v: 1, kind: 'error', code: 7, detail: 'x' },
    ];
    for (const data of malformed) deliver(h.win, data);
    expect(log.log).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(malformed.length);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('dropped a malformed bridge message');
  });

  it('drops a snapshot whose swim row or splash lacks a required key (absent is not empty)', async () => {
    const good = (await realSnapshotMessage()) as { snapshot: { swims: Obj[]; splashes: Obj[]; rosters: { swims: Obj[] } } };
    const strip = (rows: Obj[], key: string, pick: (r: Obj) => boolean): Obj[] => {
      const copy = rows.map((r) => ({ ...r }));
      delete copy.find(pick)![key];
      return copy;
    };
    const individual = (r: Obj) => r.kind === 'ind';
    const splash = (r: Obj) => r.relay_id === undefined && r.swimmerId !== null;
    const variants: Array<[string, Obj]> = [
      ['swim eventtime', { swims: strip(good.snapshot.swims, 'eventtime', individual) }],
      ['swim id', { swims: strip(good.snapshot.swims, 'id', individual) }],
      ['swim eventcourse', { swims: strip(good.snapshot.swims, 'eventcourse', individual) }],
      ['swim numlegs', { swims: strip(good.snapshot.swims, 'numlegs', individual) }],
      // Only a relay row may omit flystart (live store, 2026-10-26).
      ['individual swim flystart', { swims: strip(good.snapshot.swims, 'flystart', individual) }],
      ['split swim flystart', { swims: strip(good.snapshot.swims, 'flystart', (r) => r.kind === 'split') }],
      ['rosters swim eventgender', { rosters: { swimmers: [], swims: strip(good.snapshot.rosters.swims, 'eventgender', individual) } }],
      ['splash eventtime', { splashes: strip(good.snapshot.splashes, 'eventtime', splash) }],
      ['splash eventcourse', { splashes: strip(good.snapshot.splashes, 'eventcourse', splash) }],
      ['splash teamId', { splashes: strip(good.snapshot.splashes, 'teamId', splash) }],
    ];
    for (const [label, patch] of variants) {
      const message = { ...good, snapshot: { ...good.snapshot, ...patch } };
      expect(parseBridgeMessage(message), label).toMatchObject({ ok: false });
    }
    expect(parseBridgeMessage(good)).toMatchObject({ ok: true });
  });

  it('ignores messages that are not from the bridge, another origin, or another window', async () => {
    const good = await realSnapshotMessage();
    const h = makeWindow();
    const log = fakeLog();
    startOverlay(h.win, log);
    deliver(h.win, { source: 'something-else', hello: 1 });
    deliver(h.win, 'a string');
    deliver(h.win, null);
    deliver(h.win, good, { origin: 'https://evil.example' });
    deliver(h.win, good, { fromWindow: false });
    expect(log.log).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('shows a bridge error loudly and marks the host', () => {
    const h = makeWindow();
    const log = fakeLog();
    startOverlay(h.win, log);
    deliver(h.win, { source: 'osx-bridge', v: 1, kind: 'error', code: 'store-shape', detail: 'missing store path: totalScores' });
    expect(log.error).toHaveBeenCalledWith('[OmniSwim] bridge error: store-shape: missing store path: totalScores');
    expect(h.win.document.querySelector<HTMLElement>('[data-osx-host]')?.dataset.osxState).toBe('error');
  });

  it('starts no request and no storage write from a bridge message', async () => {
    const message = await realSnapshotMessage();
    const h = makeWindow();
    const fetchSpy = vi.fn();
    Object.defineProperty(h.win, 'fetch', { value: fetchSpy, configurable: true, writable: true });
    const setItem = vi.spyOn(h.win.localStorage, 'setItem');
    const sessionSetItem = vi.spyOn(h.win.sessionStorage, 'setItem');
    const cookieSet = vi.fn();
    Object.defineProperty(h.win.document, 'cookie', { configurable: true, get: () => '', set: cookieSet });
    // happy-dom has no indexedDB and no chrome.*. Install spies, on the window and on the Node global,
    // so a call through either name is seen. Each must stay untouched.
    const spies = { storageSet: vi.fn(), sendMessage: vi.fn(), idbOpen: vi.fn() };
    const fakeChrome = { storage: { local: { set: spies.storageSet } }, runtime: { sendMessage: spies.sendMessage } };
    const fakeIdb = { open: spies.idbOpen };
    const targets = [h.win, globalThis] as unknown as Array<Record<string, unknown>>;
    const saved = targets.map((tg) => ({ chrome: tg.chrome, indexedDB: tg.indexedDB }));
    const define = (tg: Record<string, unknown>, name: string, value: unknown) =>
      Object.defineProperty(tg, name, { value, configurable: true, writable: true });
    for (const tg of targets) {
      define(tg, 'chrome', fakeChrome);
      define(tg, 'indexedDB', fakeIdb);
    }
    const log = fakeLog();
    try {
      startOverlay(h.win, log);
      FakeXHR.instances = [];
      define(h.win as unknown as Record<string, unknown>, 'XMLHttpRequest', FakeXHR);
      deliver(h.win, message); // valid snapshot
      deliver(h.win, { source: 'osx-bridge', v: 1, kind: 'response', url: SIM_PATH, body: { swimmers: [], relays: [] } }); // valid response
      deliver(h.win, { source: 'osx-bridge', v: 1, kind: 'error', code: 'x', detail: 'y' }); // valid error
      deliver(h.win, { source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: { teams: 1 } }); // malformed
      deliver(h.win, { source: 'osx-bridge', v: 9, kind: 'rm -rf' }); // malformed
    } finally {
      targets.forEach((tg, i) => {
        define(tg, 'chrome', saved[i]?.chrome);
        define(tg, 'indexedDB', saved[i]?.indexedDB);
      });
    }
    // The messages were processed, so the "not called" checks below are not vacuous.
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(spies.storageSet).not.toHaveBeenCalled();
    expect(spies.sendMessage).not.toHaveBeenCalled();
    expect(spies.idbOpen).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(FakeXHR.instances).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('is configured jitless, so zod never probes the Function constructor (MV3 CSP)', async () => {
    const message = await realSnapshotMessage();
    expect(z.config().jitless, 'bridgeSchema.ts must call z.config({ jitless: true })').toBe(true);
    // Only the jitless assertion above is load-bearing. Zod falls back without the Function constructor
    // whether or not jitless is set, so the block below cannot fail on its own. It stays as a smoke check.
    const RealFunction = globalThis.Function;
    const blocked = function blockedFunction() {
      throw new Error('Function constructor is blocked');
    } as unknown as FunctionConstructor;
    globalThis.Function = blocked;
    try {
      expect(parseBridgeMessage(message)).toMatchObject({ ok: true });
      expect(parseBridgeMessage({ source: 'osx-bridge', v: 1, kind: 'nope' })).toMatchObject({ ok: false });
    } finally {
      globalThis.Function = RealFunction;
    }
  });

  it('asks the bridge for the latest snapshot when it starts', () => {
    const h = makeWindow();
    startOverlay(h.win, fakeLog());
    expect(h.posted).toStrictEqual([{ source: 'osx-overlay', v: 1, kind: 'ready' }]);
  });

  it('stops listening when told to', async () => {
    const message = await realSnapshotMessage();
    const h = makeWindow();
    const log = fakeLog();
    const stop = startOverlay(h.win, log);
    stop();
    deliver(h.win, message);
    expect(log.log).not.toHaveBeenCalled();
  });
});

describe('sim-overlay: shadow host (D3 section 4)', () => {
  it('mounts one open shadow host with an empty .osx-root, and is idempotent', () => {
    const h = makeWindow();
    const host = mountShadowHost(h.win.document);
    expect(mountShadowHost(h.win.document)).toBe(host);
    expect(h.win.document.querySelectorAll('[data-osx-host]')).toHaveLength(1);
    expect(host.style.cssText).toContain('position: fixed');
    expect(host.style.cssText).toContain('z-index: 2147483000');
    const root = host.shadowRoot;
    expect(root).not.toBeNull();
    const wrapper = root?.querySelector('.osx-root');
    expect(wrapper?.children).toHaveLength(0);
    expect(wrapper?.getAttribute('data-osx-theme')).toBe('light');
  });
});
