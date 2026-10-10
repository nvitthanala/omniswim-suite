/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Out-of-order save detection for `PUT /api/workspaces/:id`.
 *
 * The known gap (docs/reference/NEXT_IMPROVEMENTS_STATE.json): a client sends
 * save A, then save B. B reaches the server first, A second. Without a
 * sequence the server applies both in arrival order and keeps A, the stale one,
 * and nobody notices.
 *
 * This module owns the two rules that close the gap:
 *
 *   1. Saves for one workspace run one at a time, in arrival order. Without
 *      that, "check the number, then write" is a race: two requests could both
 *      pass the check before either one wrote.
 *   2. A save tagged with a sequence is refused when the same client already
 *      had a save at or above that number applied. The refusal is a result,
 *      not an exception, so the route can answer 409 and the stored data stays
 *      untouched.
 *
 * Scope and limits, stated plainly:
 *   - State lives in this process's memory. A restart forgets it. That is
 *     acceptable because the failure it guards is two requests that cross each
 *     other in milliseconds, not hours apart. It does NOT protect across two
 *     server processes behind one load balancer.
 *   - Sequences compare only within one `clientId`. Two browser tabs have two
 *     client ids, so they stay last-writer-wins, exactly as before.
 *   - A save with no sequence (old client, script) is applied and reported as
 *     `unchecked`. It never fails, and it does not move the recorded number.
 */
import {
  CLIENT_ID_PATTERN,
  SAVE_CLIENT_HEADER,
  SAVE_SEQ_HEADER,
  SEQ_PATTERN,
  type SaveToken,
} from '../../../packages/core/src/api/saveSequence.ts';

type HeaderBag = Record<string, string | string[] | undefined>;

export type ParsedSaveToken =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly token: SaveToken }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Read the sequence headers. Absent is a legal state (old clients). A header
 * that is present but wrong is an error, never a quiet downgrade to "absent":
 * a client that sends a malformed sequence has a bug, and treating it as
 * unchecked would hide the bug and skip the protection.
 */
export function parseSaveToken(headers: HeaderBag): ParsedSaveToken {
  const rawClient = headers[SAVE_CLIENT_HEADER.toLowerCase()];
  const rawSeq = headers[SAVE_SEQ_HEADER.toLowerCase()];
  if (rawClient === undefined && rawSeq === undefined) return { kind: 'absent' };
  if (rawClient === undefined || rawSeq === undefined) {
    return {
      kind: 'invalid',
      reason: `${SAVE_CLIENT_HEADER} and ${SAVE_SEQ_HEADER} must be sent together`,
    };
  }
  if (typeof rawClient !== 'string' || !CLIENT_ID_PATTERN.test(rawClient)) {
    return { kind: 'invalid', reason: `${SAVE_CLIENT_HEADER} is not a valid client id` };
  }
  if (typeof rawSeq !== 'string' || !SEQ_PATTERN.test(rawSeq)) {
    return { kind: 'invalid', reason: `${SAVE_SEQ_HEADER} must be a positive integer` };
  }
  return { kind: 'ok', token: { clientId: rawClient, seq: Number(rawSeq) } };
}

export type SequencedResult<T> =
  | { readonly status: 'applied'; readonly value: T; readonly unchecked: boolean }
  | { readonly status: 'stale'; readonly lastAppliedSeq: number; readonly receivedSeq: number };

interface Applied {
  readonly clientId: string;
  readonly seq: number;
}

export class SaveSequencer {
  private readonly lastApplied = new Map<string, Applied>();
  private readonly tails = new Map<string, Promise<void>>();

  /** `maxKeys` bounds memory: the least recently written workspace is forgotten first. */
  constructor(private readonly maxKeys = 2000) {}

  /**
   * Run `apply` for `key` under the per-key lock, unless the token is stale.
   *
   * `didApply` says whether `apply` really wrote (a 404 does not). Only a save
   * that wrote moves the recorded number, so a save that failed or found no
   * workspace cannot make a later, good save look stale.
   */
  run<T>(
    key: string,
    token: SaveToken | undefined,
    apply: () => Promise<T>,
    didApply: (value: T) => boolean = () => true
  ): Promise<SequencedResult<T>> {
    return this.exclusive(key, async () => {
      if (token) {
        const prev = this.lastApplied.get(key);
        if (prev && prev.clientId === token.clientId && token.seq <= prev.seq) {
          return { status: 'stale', lastAppliedSeq: prev.seq, receivedSeq: token.seq } as const;
        }
      }
      const value = await apply();
      if (token && didApply(value)) this.record(key, token);
      return { status: 'applied', value, unchecked: token === undefined } as const;
    });
  }

  /** Forget a workspace (called when it is deleted, so a reused id starts clean). */
  forget(key: string): void {
    this.lastApplied.delete(key);
  }

  /** For tests. */
  peek(key: string): { clientId: string; seq: number } | undefined {
    const v = this.lastApplied.get(key);
    return v ? { ...v } : undefined;
  }

  private record(key: string, token: SaveToken): void {
    // Delete first so insertion order tracks recency and eviction drops the oldest.
    this.lastApplied.delete(key);
    this.lastApplied.set(key, { clientId: token.clientId, seq: token.seq });
    while (this.lastApplied.size > this.maxKeys) {
      const oldest = this.lastApplied.keys().next().value;
      if (oldest === undefined) break;
      this.lastApplied.delete(oldest);
    }
  }

  private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }
}
