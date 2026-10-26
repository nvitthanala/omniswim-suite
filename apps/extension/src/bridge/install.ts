/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * sim-bridge, MAIN world, document_start (D3 2.7 "Recon outcome").
 *
 * It does two things and nothing else:
 *  1. Wraps XMLHttpRequest and fetch, and reads the body of the one request the
 *     simulator makes: `GET /api/teams/{id}/simulator/`.
 *  2. Finds the page's Redux store after #simulator mounts and posts a debounced
 *     snapshot of it.
 *
 * Every message is `{source:'osx-bridge', v:1, kind, ...}` sent with
 * `postMessage(msg, location.origin)`. The page can forge such a message, so
 * the overlay validates every one (bridge trust rule).
 *
 * The store path is a React and Redux internal:
 *   #simulator -> __reactContainer$... fiber -> Provider memoizedProps.store.
 * A missing link posts an `error` message. The bridge never falls back to a
 * guess. This file must stay under 5 KB built (tests/extensionBundleBoundaries).
 */
import { BRIDGE_SOURCE, OVERLAY_SOURCE, SETTINGS_KEYS, SIMULATOR_PATH } from '../shared/protocol';

type O = Record<string, unknown>;
interface Store {
  getState(): O;
  subscribe(l: () => void): unknown;
}
interface Fiber {
  child: Fiber | null;
  memoizedProps: { store?: Store } | null;
}
export interface BridgeOptions {
  /** Quiet time before a store change is posted. */
  debounceMs?: number;
  /** How long to wait for the store before posting an error. */
  deadlineMs?: number;
}

// Recon Q5: every swimmer row (ind, split, leadoff) carries all nine. null is allowed only where live
// data is null (pointvalue, flystart). A relay row has no `flystart` key at all (live store, 2026-10-26),
// so it must carry the first eight: flystart stays last for that slice.
const ROW = 'id eventstroke eventdistance eventcourse eventgender numlegs eventtime pointvalue flystart'.split(' ');
// Splashes are page-made copies (aggregate relays are built client-side) and recon saw only their entry
// summaries. Require what the Q13 sort needs. The rest is unverified on splashes, so it stays optional:
// points (missing past the table and on legs), relay_id, legposition, exhibition.
const SPLASH_REQ = 'id eventstroke eventdistance eventcourse eventtime'.split(' ');
const SPLASH_OPT = 'eventgender numlegs flystart pointvalue relay_id legposition points exhibition'.split(' ');
const KINDS = [['ind', 'indrecords'], ['split', 'relaysplits'], ['leadoff', 'relayleadoffs']] as const;

const gone = (p: string) => new Error('missing store path: ' + p);
/** Copy the keys that exist. With `p`, every key must exist (null is a value, undefined is absent). */
const pick = (o: O, ks: string[], p?: string): O => {
  for (const k of p ? ks : []) if (o[k] === undefined) throw gone(p + '.' + k);
  return Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
};
const arr = (v: unknown, p: string): O[] => {
  if (!Array.isArray(v)) throw gone(p);
  return v as O[];
};
const obj = (v: unknown, p: string): O => {
  if (!v || typeof v !== 'object') throw gone(p);
  return v as O;
};
/** The id of a `team` or `swimmer` reference on a splash. A missing reference is an error, never null. */
const ref = (x: O, k: string) => {
  const v = x[k] as O | null | undefined;
  if (!v || v.id == null) throw gone('simulatedMeet.splashes.' + k);
  return v.id;
};

/** Flatten a `{teamId: {swimmers, relays}}` roster map. `null` while the page has not loaded it. */
function flat(m: unknown, n: string): { swimmers: O[]; swims: O[] } | null {
  if (!m) return null;
  const swimmers: O[] = [];
  const swims: O[] = [];
  for (const [tid, r] of Object.entries(obj(m, n))) {
    const teamId = Number(tid);
    const p = `${n}.${tid}.`;
    for (const s of arr((r as O).swimmers, p + 'swimmers')) {
      swimmers.push({ ...pick(s, ['id'], p + 'swimmers'), ...pick(s, 'name display_name gender gradcollege'.split(' ')), teamId });
      for (const [kind, key] of KINDS) {
        for (const w of arr(s[key], p + key)) swims.push({ ...pick(w, ROW, p + key), kind, teamId, swimmerId: s.id });
      }
    }
    for (const w of arr((r as O).relays, p + 'relays')) swims.push({ ...pick(w, ROW.slice(0, 8), p + 'relays'), kind: 'relay', teamId, swimmerId: null });
  }
  return { swimmers, swims };
}

/** Copy the store into plain data. `null` means the page has not loaded it yet. */
function project(st: O): O {
  const settings: O = {};
  for (const k of SETTINGS_KEYS) {
    if (!(k in st)) throw gone(k);
    settings[k] = st[k];
  }
  settings.inactiveSwimmers = arr(st.inactiveSwimmers, 'inactiveSwimmers').map((s) => s.id);
  settings.meetChanges = arr(st.meetChanges, 'meetChanges'); // as the page holds it; coach edits
  const teams = arr(st.teams, 'teams').map((t) => pick(t, 'id name abbr orgcode'.split(' ')));
  for (const k of 'origRosters rosters simulatedMeet'.split(' ')) if (st[k] === undefined) throw gone(k);
  const orig = flat(st.origRosters, 'origRosters');
  const rosters = flat(st.rosters, 'rosters'); // current rosters after coach edits
  // SwimCloud's reducer leaves `totalScores` stale while a refetch clears
  // `simulatedMeet`, so read it only when the meet is present.
  let splashes: O[] | null = null;
  let totalScores: unknown = null;
  if (st.simulatedMeet) {
    const p = 'simulatedMeet.splashes';
    splashes = arr((st.simulatedMeet as O).splashes, p).map((x) => ({
      ...pick(x, SPLASH_REQ, p),
      ...pick(x, SPLASH_OPT),
      teamId: ref(x, 'team'),
      // A relay-level splash has no swimmer. An individual or a leg must.
      swimmerId: !x.swimmer && !x.relay_id && (x.eventstroke === '6' || x.eventstroke === '7') ? null : ref(x, 'swimmer'),
    }));
    totalScores = obj(st.totalScores, 'totalScores');
  }
  return { teams, swimmers: orig?.swimmers ?? null, swims: orig?.swims ?? null, rosters, settings, splashes, totalScores };
}

export function installBridge(win: Window & typeof globalThis, opts: BridgeOptions = {}): void {
  const { debounceMs = 250, deadlineMs = 20000 } = opts;
  const post = (kind: string, rest: O) => {
    try {
      win.postMessage({ source: BRIDGE_SOURCE, v: 1, kind, ...rest }, win.location.origin);
    } catch (e) {
      if (kind !== 'error') fail('post-failed', '' + e);
    }
  };
  const fail = (code: string, detail: string) => post('error', { code, detail });
  /** The simulator URL, as path and query, or null for any other request. */
  const sim = (u: string): string | null => {
    try {
      const x = new URL(u, win.location.href);
      return x.origin === win.location.origin && SIMULATOR_PATH.test(x.pathname) ? x.pathname + x.search : null;
    } catch {
      return null;
    }
  };

  const proto = win.XMLHttpRequest.prototype;
  const urls = new WeakMap<object, string>();
  const tokens = new WeakMap<object, object>(); // the current send() of each XHR
  const open = proto.open;
  const send = proto.send;
  proto.open = function (this: XMLHttpRequest, ...a: unknown[]) {
    urls.set(this, String(a[1]));
    return open.apply(this, a as never);
  } as typeof open;
  proto.send = function (this: XMLHttpRequest, ...a: unknown[]) {
    const u = sim(urls.get(this) ?? '');
    const token = {};
    if (u) {
      tokens.set(this, token);
      // A reused XHR keeps old listeners, so each one answers only the send() that added it.
      this.addEventListener(
        'load',
        () => {
          if (tokens.get(this) !== token) return;
          try {
            if (this.status !== 200) return fail('http-status', `${this.status} ${u}`);
            // The detail names the requested simulator URL, never the final URL: no other URL leaves this script.
            if (sim(this.responseURL) !== u) return fail('response-url', u);
            const t = this.responseType;
            post('response', { url: u, body: t === '' || t === 'text' ? JSON.parse(this.responseText) : this.response });
          } catch (e) {
            fail('unreadable', '' + e);
          }
        },
        { once: true },
      );
    } else tokens.delete(this);
    return send.apply(this, a as never);
  } as typeof send;

  const fetch0 = win.fetch;
  if (fetch0) {
    win.fetch = function (...a: [RequestInfo | URL, RequestInit?]) {
      const p = fetch0.apply(win, a) as Promise<Response>;
      try {
        const u = sim(a[0] instanceof win.Request ? a[0].url : String(a[0]));
        if (u) {
          p.then((r) =>
            r.status !== 200
              ? fail('http-status', `${r.status} ${u}`)
              : sim(r.url) !== u
                ? fail('response-url', u)
                : r.clone().json().then((body) => post('response', { url: u, body })),
          ).catch((e) => fail('unreadable', '' + e));
        }
      } catch (e) {
        fail('unreadable', '' + e);
      }
      return p; // always the native promise
    };
  }

  let store: Store | undefined;
  let lastSig: unknown[] | undefined;
  let lastErr = '';
  const emit = (force: boolean) => {
    if (!store) return;
    const st = store.getState();
    const sig = [st.origRosters, st.rosters, st.simulatedMeet, st.totalScores, st.teams, st.inactiveSwimmers, st.meetChanges, ...SETTINGS_KEYS.map((k) => st[k])];
    if (!force && lastSig && sig.every((v, i) => v === lastSig?.[i])) return;
    try {
      const snapshot = project(st);
      lastSig = sig;
      lastErr = '';
      post('snapshot', { snapshot });
    } catch (e) {
      const m = String((e as Error).message);
      if (m !== lastErr) fail('store-shape', m);
      lastErr = m;
    }
  };

  let why = 'no #simulator element';
  const find = (): Store | undefined => {
    const el = win.document.getElementById('simulator');
    if (!el) return undefined;
    const k = Object.keys(el).find((x) => x.startsWith('__reactContainer$'));
    if (!k) {
      why = '#simulator has no __reactContainer$ key';
      return undefined;
    }
    let f = (el as unknown as O)[k] as Fiber | null;
    for (let n = 0; f && n < 8; n++, f = f.child) {
      const s = f.memoizedProps?.store;
      if (s && typeof s.getState === 'function' && typeof s.subscribe === 'function') return s;
    }
    why = 'no Provider store in 8 fibers';
    return undefined;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mo = new win.MutationObserver(() => attach());
  const attach = () => {
    store = find();
    if (!store) return;
    mo.disconnect();
    clearTimeout(deadline);
    store.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => emit(false), debounceMs);
    });
    emit(true);
  };
  const deadline = setTimeout(() => {
    mo.disconnect();
    attach();
    if (!store) fail('store-not-found', why);
  }, deadlineMs);
  mo.observe(win.document, { childList: true, subtree: true });
  attach();

  // The overlay loads at document_idle, after the first snapshot. Its `ready` message asks for another.
  win.addEventListener('message', (e) => {
    const d = e.data as O | null;
    if (e.source === win && d?.source === OVERLAY_SOURCE && d.kind === 'ready') emit(true);
  });
}
