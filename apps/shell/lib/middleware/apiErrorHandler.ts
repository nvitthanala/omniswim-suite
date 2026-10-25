/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Last-resort Express error handler for `/api` (improvement plan P5).
 *
 * Without it, a malformed JSON body or a synchronous throw outside a route's own
 * try/catch reaches Express's default handler. That sends an HTML page, and
 * outside production the page holds the stack trace. A client that calls
 * `res.json()` on it fails with an unrelated parse error.
 *
 * Express 4 does not forward a rejected promise from an async handler to this
 * handler. Every async route has its own try/catch, and a new one must too.
 *
 * Mount it AFTER every route and the app-wide `express.json`, so errors from
 * both reach it. A request outside `/api` goes on to the next handler.
 */
import type { ErrorRequestHandler } from 'express';
import { apiError } from './apiError.ts';

export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent || !req.originalUrl.startsWith('/api')) {
    next(err);
    return;
  }
  const type = (err as { type?: unknown } | null)?.type;
  const status = (err as { status?: unknown } | null)?.status;
  const detail = err instanceof Error ? err.message : String(err);

  if (type === 'entity.parse.failed') {
    apiError(res, 400, 'BAD_JSON', 'The request body is not valid JSON.', detail);
    return;
  }
  if (type === 'entity.too.large') {
    apiError(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.', detail);
    return;
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    apiError(res, status, 'BAD_REQUEST', 'The request could not be read.', detail);
    return;
  }
  // The cause goes to the log, never to the caller in production.
  console.error('Unhandled API error:', err);
  apiError(res, 500, 'INTERNAL_ERROR', 'The server hit an unexpected error.', detail);
};
