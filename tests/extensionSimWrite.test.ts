import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { installBridge } from '../apps/extension/src/bridge/install';
import { startOverlay, writeSimulatorSettings, type OverlayLog } from '../apps/extension/src/overlay/overlay';
import { fixture, inflateRoster, inflateSplashes, type Obj } from './helpers/simulatorFixtures';

type Win = Window & typeof globalThis;
const keys = ['pointSystem', 'maxScorersPerTeam', 'maxIndrecordsPerAthlete', 'maxIndrecordsPerTeam', 'maxRelaysPerAthlete', 'maxRelaysPerTeam', 'maxTotalPerAthlete'] as const;
const nap = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function initialState(): Obj {
  const config = fixture('config-A.json') as { teams: Obj[]; settings: Obj; totalScores: Obj; results: Record<string, unknown[][]> };
  const teams = config.teams;
  const byId = new Map(teams.map((team) => [team.id as number, team]));
  const settings = { ...config.settings };
  delete settings.presetId;
  delete settings.meetChanges;
  const origRosters = { 58: inflateRoster('team-58.json', byId.get(58)!), 48: inflateRoster('team-48.json', byId.get(48)!) };
  return { ...settings, seasonId: null, teams, origRosters, rosters: origRosters, simulatedMeet: { splashes: inflateSplashes(config, byId) }, totalScores: config.totalScores, inactiveSwimmers: [], meetChanges: [] };
}

function setup(options: { dispatch?: boolean; reject?: boolean } = {}) {
  const win = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/?teams=48,58' }) as unknown as Win;
  const state = initialState();
  const listeners: Array<() => void> = [];
  const actions: Array<{ type: string; payload: unknown }> = [];
  const store: { getState: () => Obj; subscribe: (listener: () => void) => void; dispatch?: (action: { type: string; payload: unknown }) => unknown } = {
    getState: () => state,
    subscribe: (listener) => { listeners.push(listener); },
  };
  if (options.dispatch !== false) store.dispatch = (action) => {
    if (options.reject) throw new Error('dispatch rejected');
    actions.push(action);
    const key = action.type.slice('@SETTER/'.length);
    state[key] = action.payload;
    listeners.forEach((listener) => listener());
    return action;
  };
  const el = win.document.createElement('div');
  el.id = 'simulator';
  (el as unknown as Obj)['__reactContainer$fixture'] = { memoizedProps: { store }, child: null };
  win.document.body.append(el);
  const fetch = vi.fn(() => Promise.resolve({ status: 200 }));
  Object.defineProperty(win, 'fetch', { value: fetch, configurable: true, writable: true });
  vi.spyOn(win, 'postMessage').mockImplementation(((data: unknown, targetOrigin?: string) => {
    if (targetOrigin && targetOrigin !== win.location.origin) return;
    win.dispatchEvent(new win.MessageEvent('message', { data, origin: win.location.origin, source: win }));
  }) as typeof win.postMessage);
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } satisfies OverlayLog;
  const snapshots: unknown[] = [];
  const acknowledgements: string[] = [];
  const pageEdits: unknown[] = [];
  installBridge(win, { debounceMs: 1, deadlineMs: 5000 });
  startOverlay(win, log, (snapshot) => snapshots.push(snapshot), (token) => acknowledgements.push(token), (settings) => pageEdits.push(settings));
  return { win, state, actions, log, snapshots, store, fetch, acknowledgements, pageEdits };
}

afterEach(() => vi.restoreAllMocks());

describe('simulator settings write adapter and read-back', () => {
  it('writes each native setting once, acknowledges matching read-back, and creates no fetch', async () => {
    const h = setup();
    await nap();
    for (const key of keys) {
      const value = key === 'pointSystem' ? 'fixture-next-table' : Number(h.state[key]) + 1;
      const before = h.snapshots.length;
      const token = writeSimulatorSettings(h.win, { [key]: value });
      expect(token).toBeTruthy();
      await nap();
      expect(h.actions.at(-1)).toStrictEqual({ type: `@SETTER/${key}`, payload: value });
      expect(h.snapshots.length).toBe(before + 1);
      expect(h.acknowledgements.at(-1)).toBe(token);
      expect(h.acknowledgements).toHaveLength(keys.indexOf(key) + 1);
      expect(h.pageEdits).toHaveLength(0);
      expect(h.win.document.querySelector<HTMLElement>('[data-osx-host]')?.dataset.osxCompatibilityError).toBeUndefined();
    }
    expect(h.actions).toHaveLength(keys.length);
    const last = h.snapshots.at(-1);
    h.win.dispatchEvent(new h.win.MessageEvent('message', { origin: h.win.location.origin, source: h.win, data: { source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: last } }));
    expect(h.snapshots).toHaveLength(keys.length + 1);
    expect(h.acknowledgements).toHaveLength(keys.length);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('surfaces missing state keys and unknown store shape as compatibility errors', async () => {
    const missing = setup();
    delete missing.state.maxRelaysPerTeam;
    await nap();
    writeSimulatorSettings(missing.win, { maxRelaysPerTeam: 3 });
    expect(missing.win.document.querySelector<HTMLElement>('[data-osx-host]')?.dataset.osxCompatibilityError).toContain('unsupported');
    expect(missing.win.document.querySelector<HTMLElement>('[data-osx-host]')?.shadowRoot?.querySelector('[data-osx-compatibility-error]')?.textContent).toContain('unsupported');
    const unknown = setup({ dispatch: false });
    await nap();
    writeSimulatorSettings(unknown.win, { pointSystem: 'fixture' });
    expect(unknown.win.document.querySelector<HTMLElement>('[data-osx-host]')?.dataset.osxCompatibilityError).toContain('setter unavailable');
  });

  it('surfaces rejected dispatch without claiming success', async () => {
    const h = setup({ reject: true });
    await nap();
    writeSimulatorSettings(h.win, { maxScorersPerTeam: 4 });
    expect(h.win.document.querySelector<HTMLElement>('[data-osx-host]')?.dataset.osxCompatibilityError).toBe('dispatch rejected');
    expect(h.snapshots).toHaveLength(1);
  });

  it('does not dispatch from subscription; identical snapshots are no-ops and page edits recompute once', async () => {
    const h = setup();
    await nap();
    const count = h.snapshots.length;
    h.store.dispatch!({ type: '@SETTER/maxTotalPerAthlete', payload: 4 });
    await nap();
    expect(h.snapshots.length).toBe(count + 1);
    expect(h.actions).toHaveLength(1);
    expect(h.pageEdits).toHaveLength(1);
    h.win.dispatchEvent(new h.win.MessageEvent('message', { origin: h.win.location.origin, source: h.win, data: { source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: { ...(h.snapshots.at(-1) as object) } } }));
    expect(h.snapshots.length).toBe(count + 1);
    const pageBefore = h.snapshots.length;
    h.store.dispatch!({ type: '@SETTER/maxIndrecordsPerAthlete', payload: 2 });
    await nap();
    expect(h.snapshots.length).toBe(pageBefore + 1);
    expect(h.actions).toHaveLength(2);
    expect(h.pageEdits).toHaveLength(2);
  });

  it('rejects forged or malformed write responses and refuses unsupported settings', async () => {
    const h = setup();
    await nap();
    expect(writeSimulatorSettings(h.win, { pageOnlyRule: 1 } as never)).toBeNull();
    const host = h.win.document.querySelector<HTMLElement>('[data-osx-host]')!;
    expect(host.dataset.osxCompatibilityError).toContain('Unsupported');
    h.win.dispatchEvent(new h.win.MessageEvent('message', { origin: h.win.location.origin, source: h.win, data: { source: 'osx-bridge', v: 1, kind: 'write-result', token: 'forged', status: 'error', detail: 'forged' } }));
    expect(host.dataset.osxCompatibilityError).toContain('Unsupported');
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('unrecognized write response'));
    h.win.dispatchEvent(new h.win.MessageEvent('message', { origin: 'https://attacker.example', source: h.win, data: { source: 'osx-bridge', v: 1, kind: 'write-result', token: 'x', status: 'error', detail: 'forged' } }));
    expect(host.dataset.osxCompatibilityError).toContain('Unsupported');
  });
});
