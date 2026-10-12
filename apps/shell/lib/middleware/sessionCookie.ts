/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session cookie writer that adds `Secure` when the request is not loopback
 * (improvement plan S4, decision U11).
 *
 * `authMiddleware.ts` owns the cookie name and the read side (`getSessionToken`).
 * This module calls its `setSessionCookie` and appends the attribute it does not
 * set, so the name and every other attribute stay in one place.
 *
 * ## Loopback test
 *
 * A request is loopback only when BOTH the socket peer and the `Host` header are
 * loopback. A reverse proxy on the same machine has a loopback peer but forwards
 * a public `Host`, and the browser is on HTTPS there, so it must get `Secure`.
 * An unreadable peer or `Host` counts as not loopback.
 *
 * ## Consequence
 *
 * Off loopback over plain HTTP the browser drops a `Secure` cookie, so login will
 * not stick. Serve a non-loopback deployment over HTTPS.
 */
import type { Request, Response } from 'express';
import { setSessionCookie } from '../authMiddleware.ts';
import { isLoopbackHost } from '../loopbackHost.ts';
import { parseHostHeader } from './hostOriginGuard.ts';

export function isLoopbackRequest(req: Request): boolean {
  const host = parseHostHeader(req.headers.host);
  if (host === undefined || !isLoopbackHost(host.hostname)) return false;
  return isLoopbackHost(req.socket?.remoteAddress ?? '');
}

/** `setSessionCookie`, plus `Secure` when the request is not loopback. */
export function setSessionCookieForRequest(
  req: Request,
  res: Response,
  token: string,
  expiresAt: number,
  loopback: (req: Request) => boolean = isLoopbackRequest
): void {
  setSessionCookie(res, token, expiresAt);
  if (loopback(req)) return;
  const written = res.getHeader('Set-Cookie');
  const value = Array.isArray(written) ? written.join(', ') : String(written ?? '');
  res.setHeader('Set-Cookie', `${value}; Secure`);
}
