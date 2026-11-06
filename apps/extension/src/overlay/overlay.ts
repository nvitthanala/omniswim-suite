/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * sim-overlay, ISOLATED world, document_idle.
 *
 * Bridge trust rule (D3 2.7): the page can forge any `postMessage`, so this
 * script validates the shape of every bridge message and drops the malformed
 * ones. It starts no storage write and no SwimCloud request from a bridge
 * message. It touches no IndexedDB here: in this world that would be
 * SwimCloud's own database (D3 0.2, enforced by tests/extensionBundleBoundaries).
 *
 * It logs a valid SimSnapshot to the console and hands it to `onSnapshot`,
 * which forwards it to the docked panel (D3 15).
 *
 * The one exception to "no SwimCloud request" is `bindFetchQueue` below (D7 section 3). A run starts
 * only when the docked panel sends `fetch-run` on its extension port. The window `message` listener
 * never starts one, so a forged page message cannot.
 */
import { parseBridgeMessage, parseSeasonChoices } from '../shared/bridgeSchema';
import type { ParsedSeasonChoices, SimSnapshot } from '../shared/bridgeSchema';
import { isFetchCancel, isFetchRun } from '../shared/panelProtocol';
import type { FetchEndMessage } from '../shared/panelProtocol';
import { newFetchPacer, runFetchQueue } from './fetchQueue';
import type { FetchQueueDeps } from './fetchQueue';
import { bindTheme } from '../shared/theme';
import type { ThemeController, ThemeOptions, ThemePreference } from '../shared/theme';
import { ROOT_CLASS, SHADOW_CSS } from './shadowStyle';
import { BRIDGE_SOURCE, BRIDGE_VERSION, OVERLAY_SOURCE, SIM_WRITE_KEYS } from '../shared/protocol';
import { simulatorWriteSettingsSchema, type SimulatorWriteSettings } from '../shared/bridgeSchema';

export const LOG_PREFIX = '[OmniSwim]';

export type OverlayLog = Pick<Console, 'log' | 'warn' | 'error' | 'debug'>;

/** Keys typed into OmniSwim UI must not reach SwimCloud's handlers (D3 section 4, trap 5). */
export const STOPPED_KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;
const writeApi = new WeakMap<Window, (settings: SimulatorWriteSettings) => string | null>();

/** Explicit Apply hook for future UI: writes only settings represented by native simulator controls. */
export function writeSimulatorSettings(win: Window & typeof globalThis, settings: SimulatorWriteSettings): string | null {
  return writeApi.get(win)?.(settings) ?? null;
}

export interface ShadowHostOptions {
  /** Defaults to `'light'`. `'system'` follows `prefers-color-scheme`. */
  readonly theme?: ThemePreference;
  /** Defaults to the global `matchMedia`. A test passes a stub. */
  readonly matchMedia?: ThemeOptions['matchMedia'];
}

const themeControllers = new WeakMap<HTMLElement, ThemeController>();

/** The theme controller of a host that `mountShadowHost` made. */
export function themeOf(host: HTMLElement): ThemeController | undefined {
  return themeControllers.get(host);
}

/**
 * Mount the shadow host (D3 section 4). Layout goes on the host as inline
 * style because page rules beat `:host`. Idempotent: a second call returns the
 * host that already exists.
 *
 * Inside the shadow root: one `<style>` (reset and tokens, ./shadowStyle.ts) and the `.osx-root`
 * wrapper. The wrapper stops key events so SwimCloud's handlers never see them. Nothing here
 * portals to `document.body` and nothing defines a custom element.
 */
export function mountShadowHost(doc: Document, opts: ShadowHostOptions = {}): HTMLElement {
  const existing = doc.querySelector<HTMLElement>('[data-osx-host]');
  if (existing) return existing;
  const host = doc.createElement('div');
  host.setAttribute('data-osx-host', '');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.setAttribute('data-osx-style', '');
  style.textContent = SHADOW_CSS;
  const wrapper = doc.createElement('div');
  wrapper.className = ROOT_CLASS;
  for (const type of STOPPED_KEY_EVENTS) wrapper.addEventListener(type, (e) => e.stopPropagation());
  root.append(style, wrapper);
  const options: ThemeOptions = { preference: opts.theme ?? 'light', ...(opts.matchMedia ? { matchMedia: opts.matchMedia } : {}) };
  themeControllers.set(host, bindTheme(wrapper, options));
  (doc.body ?? doc.documentElement).append(host);
  return host;
}

/** Listen for bridge messages. Returns a function that stops listening. */
export function startOverlay(
  win: Window & typeof globalThis,
  log: OverlayLog = console,
  onSnapshot: (snapshot: SimSnapshot) => void = () => undefined,
  onWriteAcknowledged: (token: string) => void = () => undefined,
  onPageSettingsChanged: (settings: SimSnapshot['settings']) => void = () => undefined,
  /** The page's own season list, checked. Called at capture and again after `ready`. A list that fails the check is logged and dropped. */
  onSeasons: (seasons: Extract<ParsedSeasonChoices, { ok: true }>) => void = () => undefined,
): () => void {
  const host = mountShadowHost(win.document);
  const showCompatibilityError = (message?: string): void => {
    const root = host.shadowRoot;
    if (!root) return;
    let alert = root.querySelector<HTMLElement>('[data-osx-compatibility-error]');
    if (!message) { alert?.remove(); delete host.dataset.osxCompatibilityError; return; }
    if (!alert) {
      alert = win.document.createElement('div');
      alert.dataset.osxCompatibilityError = '';
      alert.setAttribute('role', 'alert');
      alert.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483000;max-width:420px;padding:10px 14px;border:1px solid var(--osx-border);border-radius:8px;background:var(--osx-bg);color:var(--osx-fg);box-shadow:0 2px 12px rgba(0,0,0,.2);font:14px/1.4 var(--osx-font)';
      root.querySelector(`.${ROOT_CLASS}`)?.append(alert);
    }
    alert.textContent = message;
    host.dataset.osxCompatibilityError = message;
  };
  let lastSettingsSignature: string | undefined;
  let lastSnapshotSignature: string | undefined;
  let pending: { token: string; settings: SimulatorWriteSettings; timeout: ReturnType<typeof setTimeout> } | undefined;
  const signature = (s: Partial<Record<string, unknown>>): string => JSON.stringify(Object.fromEntries(SIM_WRITE_KEYS.map((k) => [k, s[k]])));
  const sendWrite = (settings: SimulatorWriteSettings): string | null => {
    const parsedSettings = simulatorWriteSettingsSchema.safeParse(settings);
    if (!parsedSettings.success) {
      host.dataset.osxState = 'error';
      showCompatibilityError('Unsupported simulator settings');
      log.error(`${LOG_PREFIX} compatibility error: unsupported simulator settings`);
      return null;
    }
    if (pending) clearTimeout(pending.timeout);
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      if (pending?.token !== token) return;
      pending = undefined;
      host.dataset.osxState = 'error';
      showCompatibilityError('Simulator settings write was not confirmed');
      log.error(`${LOG_PREFIX} compatibility error: simulator settings write was not confirmed`);
    }, 5000);
    pending = { token, settings: parsedSettings.data, timeout };
    win.postMessage({ source: OVERLAY_SOURCE, v: BRIDGE_VERSION, kind: 'write', token, settings: parsedSettings.data }, win.location.origin);
    return token;
  };
  writeApi.set(win, sendWrite);

  const onMessage = (e: MessageEvent): void => {
    // Not ours: another frame, another origin, or a page that talks to itself.
    if (e.source !== win || e.origin !== win.location.origin) return;
    const data = e.data as { source?: unknown } | null;
    if (!data || typeof data !== 'object' || data.source !== BRIDGE_SOURCE) return;

    const parsed = parseBridgeMessage(data);
    if (!parsed.ok) {
      log.warn(`${LOG_PREFIX} dropped a malformed bridge message (${parsed.reason})`);
      return;
    }
    const m = parsed.message;
    switch (m.kind) {
      case 'snapshot':
        {
        const sig = signature(m.snapshot.settings);
        const fullSig = JSON.stringify(m.snapshot);
        if (fullSig === lastSnapshotSignature) break;
        lastSnapshotSignature = fullSig;
        const pageSettingsChanged = lastSettingsSignature !== undefined && sig !== lastSettingsSignature;
        lastSettingsSignature = sig;
        let acknowledged = false;
        if (pending && Object.entries(pending.settings).every(([k, v]) => m.snapshot.settings[k as keyof SimSnapshot['settings']] === v)) {
          const token = pending.token;
          clearTimeout(pending.timeout);
          pending = undefined;
          showCompatibilityError();
          host.dataset.osxState = 'ready';
          onWriteAcknowledged(token);
          acknowledged = true;
        }
        if (pageSettingsChanged && !acknowledged) onPageSettingsChanged(m.snapshot.settings);
        host.dataset.osxState = 'ready';
        // The console line stays: the user's live load check reads it (D3 15, P1 `userCheck` in the state file).
        log.log(`${LOG_PREFIX} SimSnapshot`, m.snapshot);
        onSnapshot(m.snapshot);
        break;
        }
      case 'response':
        log.debug(`${LOG_PREFIX} team response`, m.url);
        break;
      case 'seasons': {
        const seasons = parseSeasonChoices(m.body);
        if (!seasons.ok) log.warn(`${LOG_PREFIX} dropped the season list (${seasons.reason})`);
        else onSeasons(seasons);
        break;
      }
      case 'error':
        host.dataset.osxState = 'error';
        log.error(`${LOG_PREFIX} bridge error: ${m.code}: ${m.detail}`);
        break;
      case 'write-result':
        if (!pending || m.token !== pending.token) {
          log.warn(`${LOG_PREFIX} dropped an unrecognized write response`);
          break;
        }
        if (m.status === 'error') {
          clearTimeout(pending.timeout);
          pending = undefined;
          host.dataset.osxState = 'error';
          showCompatibilityError(m.detail || 'Simulator rejected settings write');
          log.error(`${LOG_PREFIX} compatibility error: ${host.dataset.osxCompatibilityError}`);
        }
        break;
    }
  };

  win.addEventListener('message', onMessage);
  // The bridge posted its first snapshot before this script loaded. Ask for the latest.
  win.postMessage({ source: OVERLAY_SOURCE, v: BRIDGE_VERSION, kind: 'ready' }, win.location.origin);
  return () => { win.removeEventListener('message', onMessage); writeApi.delete(win); if (pending) clearTimeout(pending.timeout); };
}

/** The slice of the docked panel `bindFetchQueue` uses. `mountDockedPanel` returns it. */
export interface FetchPanel {
  sendMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Called when the port to the panel closes. A message sent after that is lost, so `bindFetchQueue` stops the run. */
  onDisconnect(listener: () => void): void;
}

export interface FetchController {
  /** The id of the run in progress, or null. A run is over once its `fetch-end` is posted, even if it still holds the lock for the pacing gap. */
  activeRunId(): string | null;
}

/**
 * The real clocks, network and lock manager of a page. A test passes fakes. Content scripts reach the page's origin with their own `fetch`.
 * Pacing runs on `performance.now()`, which a change of the system clock cannot move. `wallNow` is for `fetchedAt` and an HTTP-date `Retry-After`.
 * `bindFetchQueue` adds the pacer and `post`.
 */
export function browserFetchDeps(win: Window & typeof globalThis): Omit<FetchQueueDeps, 'post' | 'pacer'> {
  return {
    fetch: (input, init) => win.fetch(input, init),
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
      }),
    now: () => win.performance.now(),
    wallNow: () => Date.now(),
    locks: win.navigator.locks as FetchQueueDeps['locks'],
    origin: win.location.origin,
  };
}

/**
 * Run `fetch-run` from the docked panel (D7 section 3, decisions Q, W, C). Reads the panel port only: a window `message` is never an
 * input, and nothing runs on load, on a snapshot or on a bridge message.
 *
 * - A second `fetch-run` during a run gets `fetch-end` with `busy`, and the first run goes on. A `fetch-run` that reuses the running
 *   id is dropped and logged: answering it would end the live run in the panel's eyes.
 * - `fetch-cancel` for the running id aborts it, in flight too. So does a closed port, because nobody is left to read the answers.
 * - One pacer serves every run of this tab. A run that starts while the last one still holds the lock for the pacing gap waits for it.
 * - If the queue's own code throws, the panel gets `fetch-end` with `internal`, the index in progress and the real delivered count.
 */
export function bindFetchQueue(panel: FetchPanel, deps: Omit<FetchQueueDeps, 'post' | 'pacer'>, log: OverlayLog = console): FetchController {
  const pacer = newFetchPacer();
  let active: { readonly runId: string; readonly abort: AbortController } | null = null;
  let tail: Promise<unknown> = Promise.resolve(); // the last run, until it let go of the lock
  const post = (message: unknown): void => panel.sendMessage(message);
  const endWith = (runId: string, delivered: number, stopped: NonNullable<FetchEndMessage['stopped']>): void => post({ kind: 'fetch-end', runId, delivered, stopped } satisfies FetchEndMessage);
  panel.onDisconnect(() => active?.abort.abort('the panel disconnected'));
  panel.onMessage((message) => {
    if (isFetchCancel(message)) {
      if (active?.runId === message.runId) active.abort.abort();
      return;
    }
    const kind = message && typeof message === 'object' ? (message as { kind?: unknown }).kind : undefined;
    if (kind !== 'fetch-run') return;
    const claimed = (message as { runId?: unknown }).runId;
    if (active && claimed === active.runId) {
      log.warn(`${LOG_PREFIX} dropped a fetch-run that reuses the running id`);
      return;
    }
    if (!isFetchRun(message)) {
      log.warn(`${LOG_PREFIX} dropped a malformed fetch-run`);
      if (typeof claimed === 'string') endWith(claimed, 0, { reason: 'refused', index: 0, status: 0, detail: 'the fetch-run message is malformed' });
      return;
    }
    if (active) {
      endWith(message.runId, 0, { reason: 'busy', index: 0, status: 0, detail: `run ${active.runId} is still going` });
      return;
    }
    const abort = new AbortController();
    const run = { runId: message.runId, abort };
    active = run;
    let ended = false;
    let delivered = 0;
    let index = 0;
    const runPost: FetchQueueDeps['post'] = (m) => {
      if (m.kind === 'fetch-progress') index = m.index;
      if (m.kind === 'fetch-end') {
        ended = true;
        if (active === run) active = null; // the run is over; the lock may still be held for the gap
      }
      post(m);
      if (m.kind === 'fetch-item') delivered += 1;
    };
    const previous = tail;
    const result = previous.then(() => runFetchQueue(message, { ...deps, pacer, post: runPost }, abort.signal));
    tail = result.catch(() => undefined);
    result
      .catch((error: unknown) => {
        log.error(`${LOG_PREFIX} fetch queue failed`, error);
        if (!ended) endWith(message.runId, delivered, { reason: 'internal', index, status: 0, detail: `the overlay's fetch queue failed: ${error instanceof Error ? error.message : String(error)}` });
      })
      .finally(() => { if (active === run) active = null; });
  });
  return { activeRunId: () => active?.runId ?? null };
}
