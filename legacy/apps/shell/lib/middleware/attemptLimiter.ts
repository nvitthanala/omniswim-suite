/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A small in-memory failed-attempt limiter, used by the login and register routes
 * when authentication is required (improvement plan S4, decision U11).
 *
 * Fixed window per key: after `maxAttempts` failures inside `windowMs` the key is
 * blocked until the window that holds the first failure ends. State is in memory,
 * so a server restart clears it and several server processes do not share it. That
 * is acceptable for a single local or small-team server and is stated here so
 * nobody mistakes it for a distributed limiter.
 *
 * The map is bounded. When it passes `maxKeys` the expired windows go first, then
 * the oldest keys, so a flood of distinct keys cannot grow memory without limit.
 */

export interface AttemptLimiterOptions {
  readonly maxAttempts: number;
  readonly windowMs: number;
  /** Upper bound on tracked keys. Defaults to 10 000. */
  readonly maxKeys?: number;
  /** Clock. Defaults to `Date.now`. Tests inject their own. */
  readonly now?: () => number;
}

export type AttemptCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface AttemptLimiter {
  /** Is `key` currently allowed to try? Does not count an attempt. */
  check(key: string): AttemptCheck;
  /** Record one failed attempt for `key`. */
  fail(key: string): void;
  /** Forget `key`, for example after a successful login. */
  reset(key: string): void;
}

interface AttemptWindow {
  count: number;
  startedAt: number;
}

export function createAttemptLimiter(options: AttemptLimiterOptions): AttemptLimiter {
  const { maxAttempts, windowMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const windows = new Map<string, AttemptWindow>();

  const live = (key: string, at: number): AttemptWindow | undefined => {
    const entry = windows.get(key);
    if (entry === undefined) return undefined;
    if (at - entry.startedAt >= windowMs) {
      windows.delete(key);
      return undefined;
    }
    return entry;
  };

  const evict = (at: number): void => {
    for (const [key, entry] of windows) {
      if (at - entry.startedAt >= windowMs) windows.delete(key);
    }
    // Map iterates in insertion order, so the first keys are the oldest.
    for (const key of windows.keys()) {
      if (windows.size <= maxKeys) break;
      windows.delete(key);
    }
  };

  return {
    check(key) {
      const at = now();
      const entry = live(key, at);
      if (entry === undefined || entry.count < maxAttempts) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.startedAt + windowMs - at) / 1000)),
      };
    },
    fail(key) {
      const at = now();
      const entry = live(key, at);
      if (entry === undefined) {
        windows.set(key, { count: 1, startedAt: at });
        if (windows.size > maxKeys) evict(at);
      } else {
        entry.count += 1;
      }
    },
    reset(key) {
      windows.delete(key);
    },
  };
}
