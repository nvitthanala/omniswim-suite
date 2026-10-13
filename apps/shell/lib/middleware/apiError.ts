/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One error shape for every `/api` response that is not a success (improvement
 * plan P5).
 *
 * ```json
 * { "error": "Failed to update workspace", "code": "WORKSPACE_UPDATE_FAILED", "details": "..." }
 * ```
 *
 * - `error` is a short sentence this server wrote. Clients read it and show it.
 *   It is never the text of a caught exception. One named case is allowed: a typed
 *   domain error whose message is display text taken from the data, not from a
 *   failure (`HostPublishedTableRequiredError` carries a preset's description).
 * - `code` is a stable machine name. Clients branch on it, never on `error`.
 * - `details` is the technical reason: a stringified exception, a validation
 *   issue list, a header value. It is sent ONLY when `NODE_ENV !== 'production'`.
 *   In production an exception message can carry file paths, SQL or the contents
 *   of a request, so it stays in the server log.
 * - `extra` holds the other top-level fields a client reads on that status (the
 *   `rows` of a 422, `lastAppliedSeq` of a stale save). It is part of the contract
 *   of that one response, so it is sent in production too. Do not put anything
 *   derived from an exception in it. It can not override `error`, `code` or
 *   `details`.
 *
 * `NODE_ENV` is read on each call, not at import, so a test can switch it.
 */
import type { Response } from 'express';

/** True when the process runs with `NODE_ENV=production`. Read per call. */
export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

export interface ApiErrorBody {
  readonly error: string;
  readonly code: string;
  /** Present only outside production. */
  readonly details?: unknown;
  readonly [field: string]: unknown;
}

/**
 * Send the error body and return `res`.
 *
 * @param message A fixed sentence for the user. Never `err.message`.
 * @param details The technical reason. Dropped in production.
 * @param extra   Other top-level fields of this response, sent in production too.
 */
export function apiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
  extra?: Readonly<Record<string, unknown>>
): Response {
  // `details` is the one reserved key that would leak in production if `extra` could
  // set it, so reserved keys are removed from `extra` rather than overwritten after.
  const { error: _e, code: _c, details: _d, ...safeExtra } = extra ?? {};
  const body: ApiErrorBody = {
    ...safeExtra,
    error: message,
    code,
    ...(details !== undefined && !isProductionEnv() ? { details } : {}),
  };
  return res.status(status).json(body);
}
