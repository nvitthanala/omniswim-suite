/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared data-directory and "is a server holding this store" guard for the
 * scripts that WRITE workspaces (seed_hsu_roster, seed_obu_roster,
 * migrate-json-to-sqlite, reextract_meet_workspace).
 *
 * Before this existed those scripts hardcoded the real `data/` folder. A test
 * run of a seed script wrote into the live store, and a running server could
 * overwrite or corrupt what the script wrote.
 *
 * ## Resolution (same as apps/shell/server.ts)
 *
 *   OMNI_DATA_DIR set  -> path.resolve(OMNI_DATA_DIR)
 *   otherwise          -> <repo>/data
 *
 * ## The server guard
 *
 * `assertNoServerHoldsStore` probes `http://127.0.0.1:<port>/api/scoring-presets`
 * (the server has no dedicated health route; this is an unauthenticated GET that
 * every server build registers). Port resolution mirrors server.ts:
 * `PORT`, then `OMNI_PORT`, then 3000.
 *
 * The guard FAILS CLOSED. Any HTTP answer -- including a 404 or a 500 -- means
 * something is listening, so the script refuses. A refused connection means the
 * port is free and the script proceeds. A timeout or any other error is treated
 * as "cannot prove it is safe" and also refuses. `--force` skips the guard.
 *
 * The probe cannot tell WHICH data directory the listening server uses. A server
 * on the port with a different OMNI_DATA_DIR still blocks the script; pass
 * `--force` (or point the script at a free port with PORT=...) in that case.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Same resolution as `DATA_DIR` in apps/shell/server.ts. */
export function resolveDataDir(env = process.env) {
  return env.OMNI_DATA_DIR ? path.resolve(env.OMNI_DATA_DIR) : path.join(REPO_ROOT, 'data');
}

/** Same precedence as `PORT` in apps/shell/server.ts. */
export function resolveServerPort(env = process.env) {
  return Number(env.PORT ?? env.OMNI_PORT ?? 3000);
}

/**
 * Probe the server port. Returns `{ state: 'free' | 'answered' | 'unknown', detail }`.
 * Exported so tests can exercise it against a throwaway listener.
 */
export async function probeServer(port, timeoutMs = 1500) {
  const url = `http://127.0.0.1:${port}/api/scoring-presets`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { state: 'answered', detail: `HTTP ${res.status} from ${url}` };
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    if (code === 'ECONNREFUSED') return { state: 'free', detail: `connection refused on port ${port}` };
    return { state: 'unknown', detail: `${err?.name ?? 'Error'}${code ? ` (${code})` : ''} probing ${url}` };
  }
}

/**
 * Throw (via the caller's `fail`) when a server may be holding the store.
 * `force` bypasses the check. Returns the probe result so callers can log it.
 */
export async function assertNoServerHoldsStore({ force, what, fail, env = process.env, probe = probeServer }) {
  if (force) {
    console.warn(`WARNING: --force given; skipping the running-server check for ${what}.`);
    return { state: 'skipped', detail: '--force' };
  }
  const port = resolveServerPort(env);
  const result = await probe(port);
  if (result.state !== 'free') {
    fail(
      `A server may be holding ${what} (${result.detail}). ` +
        `Writing while it runs can corrupt the store or be overwritten. ` +
        `Stop the server, point OMNI_DATA_DIR at a copy, or re-run with --force if that server uses a different data dir.`
    );
  }
  return result;
}
