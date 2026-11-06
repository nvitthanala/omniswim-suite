/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The docked panel's end of a fetch run (D7 section 3, decisions Q, W, C). Pure: no port, no clock, no storage. The caller gives it a `post`
 * function and feeds it the messages that passed the strict guards in `shared/panelProtocol.ts`.
 *
 * What it guarantees:
 * - A run starts only from `start`, which the caller calls only from a click, and only when the posture is `'on-click'`.
 * - It ignores every message whose run id it did not start, including a run it already finished or failed.
 * - Each `fetch-item` must be the next index (0, 1, 2 ...), must have `path === fetchPathFor(targets[index])` from this client's own record,
 *   and must be `200` text (the overlay sends nothing else). A gap, a repeat or a different path fails the run.
 * - `stopped: null` is trusted only when the items run exactly 0..delivered-1 and `delivered` equals the number of targets.
 * - A run ends in `finished` only through that check. A stopped run, a missing `fetch-end` after the port was replaced or closed, and every
 *   check above end in `failed`, and `failed` carries no items: the caller writes nothing for a failed run.
 */
import { fetchPathFor } from '../shared/fetchProtocol';
import type { FetchFeature, FetchTarget } from '../shared/fetchProtocol';
import type { FetchOverlayMessage, FetchRunMessage } from '../shared/panelProtocol';

export interface DeliveredItem<T extends { readonly target: FetchTarget }> {
  readonly index: number;
  readonly request: T;
  readonly path: string;
  readonly finalPath: string;
  readonly contentType: string;
  readonly body: string;
  readonly fetchedAt: string;
}

export type RunFailure =
  | 'posture-off'
  | 'bad-plan'
  | 'stopped'
  | 'port-lost'
  | 'out-of-order'
  | 'wrong-path'
  | 'incomplete';

export type RunState<T extends { readonly target: FetchTarget }> =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly runId: string; readonly total: number; readonly received: number; readonly waitingMs: number | null }
  | { readonly phase: 'finished'; readonly runId: string; readonly items: readonly DeliveredItem<T>[] }
  | { readonly phase: 'failed'; readonly runId: string | null; readonly reason: RunFailure; readonly detail: string };

export interface FetchRunClientDeps {
  /** Sends a message to the overlay on the panel port. May throw if there is no port; the client then fails the run. */
  readonly post: (message: FetchRunMessage | { readonly kind: 'fetch-cancel'; readonly runId: string }) => void;
  /** A fresh id for each run. */
  readonly newRunId: () => string;
}

export interface FetchRunClient<T extends { readonly target: FetchTarget }> {
  state(): RunState<T>;
  /** Start a run. Returns the run id, or `null` when the run did not start (`state()` says why). */
  start(feature: FetchFeature, requests: readonly T[], posture: 'off' | 'on-click' | undefined): string | null;
  cancel(): void;
  /** A guarded message from the overlay. */
  handle(message: FetchOverlayMessage): void;
  /** A new port was accepted, or the live port closed. A run in progress cannot be completed: its `fetch-end` may be lost. */
  portChanged(): void;
  subscribe(listener: (state: RunState<T>) => void): () => void;
}

export function createFetchRunClient<T extends { readonly target: FetchTarget }>(deps: FetchRunClientDeps): FetchRunClient<T> {
  let state: RunState<T> = { phase: 'idle' };
  const listeners = new Set<(s: RunState<T>) => void>();
  let active: { readonly runId: string; readonly requests: readonly T[]; readonly paths: readonly string[]; readonly items: DeliveredItem<T>[] } | null = null;
  let waitingMs: number | null = null;

  const set = (next: RunState<T>): void => {
    state = next;
    for (const l of [...listeners]) l(next);
  };
  const fail = (reason: RunFailure, detail: string, cancel: boolean): void => {
    const runId = active?.runId ?? null;
    if (cancel && active) { try { deps.post({ kind: 'fetch-cancel', runId: active.runId }); } catch { /* the port is gone; the overlay stops the run itself */ } }
    active = null;
    waitingMs = null;
    set({ phase: 'failed', runId, reason, detail });
  };

  return {
    state: () => state,
    start(feature, requests, posture) {
      if (active) return null; // a run is going; its state stays as it is (checked first: a failure here would orphan the live run)
      if (posture !== 'on-click') { fail('posture-off', 'Fetching is off. Turn on fetching in the Rosters tab first.', false); return null; }
      if (requests.length === 0) { fail('bad-plan', 'There is nothing to fetch.', false); return null; }
      let paths: string[];
      try { paths = requests.map((r) => fetchPathFor(r.target)); } catch (error) { fail('bad-plan', error instanceof Error ? error.message : String(error), false); return null; }
      const runId = deps.newRunId();
      active = { runId, requests, paths, items: [] };
      waitingMs = null;
      set({ phase: 'running', runId, total: requests.length, received: 0, waitingMs: null });
      try {
        deps.post({ kind: 'fetch-run', runId, feature, targets: requests.map((r) => r.target) });
      } catch (error) {
        fail('port-lost', `The run could not be sent to the page: ${error instanceof Error ? error.message : String(error)}`, false);
        return null;
      }
      return runId;
    },
    cancel() {
      if (!active) return;
      try { deps.post({ kind: 'fetch-cancel', runId: active.runId }); } catch { /* see fail() */ }
      // The overlay answers with fetch-end and 'cancelled'. Until then the run stays running.
    },
    handle(message) {
      if (!active || message.runId !== active.runId) return; // a run this client did not start, or one that is over
      const run = active;
      if (message.kind === 'fetch-progress') {
        waitingMs = message.waitMs;
        set({ phase: 'running', runId: run.runId, total: run.requests.length, received: run.items.length, waitingMs });
        return;
      }
      if (message.kind === 'fetch-item') {
        if (message.index !== run.items.length) { fail('out-of-order', `Expected item ${run.items.length}, the page sent item ${message.index}.`, true); return; }
        if (message.index >= run.requests.length) { fail('out-of-order', `The page sent item ${message.index} of a ${run.requests.length}-request run.`, true); return; }
        if (message.path !== run.paths[message.index]) { fail('wrong-path', `Item ${message.index} answers ${message.path}, not the ${run.paths[message.index]} this panel asked for.`, true); return; }
        run.items.push({ index: message.index, request: run.requests[message.index] as T, path: message.path, finalPath: message.finalPath, contentType: message.contentType, body: message.body, fetchedAt: message.fetchedAt });
        set({ phase: 'running', runId: run.runId, total: run.requests.length, received: run.items.length, waitingMs });
        return;
      }
      // fetch-end
      if (message.stopped !== null) {
        fail('stopped', `The run stopped at request ${message.stopped.index + 1} of ${run.requests.length}: ${message.stopped.reason}${message.stopped.status ? ` (HTTP ${message.stopped.status})` : ''}. ${message.stopped.detail} Nothing was saved.`, false);
        return;
      }
      if (message.delivered !== run.items.length || run.items.length !== run.requests.length) {
        fail('incomplete', `The page reported ${message.delivered} delivered, this panel received ${run.items.length}, and the run had ${run.requests.length} requests. Nothing was saved.`, false);
        return;
      }
      if (!run.items.every((item, i) => item.index === i)) { fail('out-of-order', 'The items are not 0..n-1 in order. Nothing was saved.', false); return; }
      const items = run.items.slice();
      active = null;
      waitingMs = null;
      set({ phase: 'finished', runId: run.runId, items });
    },
    portChanged() {
      if (active) fail('port-lost', 'The connection to the SwimCloud page changed before the run finished. Nothing was saved.', false);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
