/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host and Origin guard for every `/api/*` route (improvement plan S1).
 *
 * ## The threat
 *
 * The server binds loopback and, by default, runs with authentication off. That
 * leaves two ways for a web page the coach happens to have open to reach it:
 *
 * 1. A simple cross-site POST. A page on another origin can make the browser
 *    send `POST http://127.0.0.1:3000/api/...`. It cannot read the response, but
 *    the write lands.
 * 2. DNS rebinding. A page on `evil.example` re-points that name at 127.0.0.1.
 *    The page is now same-origin with the server and can read every response,
 *    including `/api/swimcloud/pairing-token`, whose safety comment assumes that
 *    same-origin means "this app".
 *
 * ## The rules
 *
 * - **Host**: the `Host` header must name `localhost`, `127.0.0.1` or `[::1]`
 *   on the configured port, or a host listed in `OMNI_ALLOWED_HOSTS`. Anything
 *   else is answered 421 (Misdirected Request). This is what defeats rebinding:
 *   a rebound request still carries the attacker's name in `Host`.
 * - **Origin**, on every method except GET and HEAD:
 *   - If `Origin` is present it alone decides. It must name an allowed host.
 *   - If `Origin` is absent, `Sec-Fetch-Site` decides: `same-origin` and `none`
 *     pass, `same-site` and `cross-site` fail.
 *   - If neither header is present the caller is not a browser (curl, a Node
 *     script, the test suite). A cross-site request from a browser always
 *     carries at least one of them, so this is not the attack being defended
 *     against, and rejecting it would break every script that talks to the API.
 * - **Extension**: the SwimCloud companion extension posts from a
 *   `chrome-extension://<id>` origin. That origin is accepted on the capture
 *   routes only, and only together with the pairing token. It is never accepted
 *   on any other `/api` route.
 *
 * ## What this does not cover
 *
 * Only `/api/*` is guarded. Vite dev HMR runs over the HTTP `upgrade` event, which
 * never reaches Express middleware. Non-API paths (the SPA, `/share/:token`) are
 * not guarded here; Vite applies its own `allowedHosts` check in dev.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { isLoopbackHost } from '../loopbackHost.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Bind addresses that name "every interface" and so identify no single host. */
const WILDCARD_BINDS = new Set(['', '0.0.0.0', '::', '[::]']);
/** Chrome extension ids are 32 characters from a-p. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/;
const CAPTURE_TOKEN_HEADER = 'x-omniswim-capture-token';

export interface HostParts {
  /** Lowercase. IPv6 literals keep their brackets, as they appear in a `Host` header. */
  readonly hostname: string;
  readonly port: string | undefined;
}

/** Parse a `Host` header value or an `OMNI_ALLOWED_HOSTS` entry. `undefined` when malformed. */
export function parseHostHeader(raw: string | undefined): HostParts | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = HOST_PATTERN.exec(raw.trim().toLowerCase());
  if (match === null) return undefined;
  return { hostname: match[1], port: match[2] };
}

/**
 * Read `OMNI_ALLOWED_HOSTS`: comma or whitespace separated `name` or `name:port`
 * entries. A bare name matches any port. A malformed entry throws, because a
 * silently dropped entry reads as "I allowed that host" and then answers 421.
 */
export function parseAllowedHosts(raw: string | undefined): HostParts[] {
  if (raw === undefined) return [];
  const out: HostParts[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    if (token === '') continue;
    const parts = parseHostHeader(token);
    if (parts === undefined) {
      throw new Error(
        `OMNI_ALLOWED_HOSTS entry ${JSON.stringify(token)} is not a host. Use a bare name or name:port, with no scheme, path or user info.`
      );
    }
    out.push(parts);
  }
  return out;
}

/**
 * The allowed-host list for a server: `OMNI_ALLOWED_HOSTS` plus, when the
 * operator bound one specific non-loopback address on purpose (`OMNI_HOST`), that
 * address. A wildcard bind names no host, so it adds nothing.
 */
export function resolveAllowedHosts(env: {
  readonly allowedHosts?: string | undefined;
  readonly bindHost?: string | undefined;
}): HostParts[] {
  const hosts = parseAllowedHosts(env.allowedHosts);
  const bind = (env.bindHost ?? '').trim().toLowerCase();
  if (!WILDCARD_BINDS.has(bind) && !isLoopbackHost(bind)) {
    const parts = parseHostHeader(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind);
    if (parts !== undefined) hosts.push(parts);
  }
  return hosts;
}

export interface HostOriginGuardOptions {
  /** The port the server listens on. The loopback names are only valid on it. */
  readonly port: number;
  /** Extra allowed hosts. See {@link resolveAllowedHosts}. */
  readonly extraHosts?: readonly HostParts[];
  /** Mount path of the capture routes, for example `/api/swimcloud/captures`. Lowercase. */
  readonly captureRoutePrefix: string;
  /**
   * Tells the guard whether a received pairing token is the real one. Omit it when
   * the capture routes are not registered: the extension origin is then never accepted.
   */
  readonly verifyPairingToken?: (received: string | undefined) => boolean;
  /** `OMNI_SWIMCLOUD_EXTENSION_ORIGIN`. When set, only this exact origin is accepted. */
  readonly extensionOrigin?: string;
}

interface OriginParts {
  readonly hostname: string;
  readonly port: string;
}

/** A serialized origin, or `undefined` for `null`, a path-bearing value, or a non-http(s) scheme. */
function parseOrigin(raw: string): OriginParts | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (raw.trim().toLowerCase() !== url.origin) return undefined;
  return { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80') };
}

function sendDenied(res: Response, status: 403 | 421, error: string, details: string): void {
  res.status(status).json({ error, details });
}

export function createHostOriginGuard(options: HostOriginGuardOptions): RequestHandler {
  const extras = options.extraHosts ?? [];
  const loopbackPort = String(options.port);
  const prefix = options.captureRoutePrefix.toLowerCase();

  const hostAllowed = (hostname: string, port: string): boolean => {
    if (LOOPBACK_NAMES.has(hostname) && port === loopbackPort) return true;
    return extras.some(entry => entry.hostname === hostname && (entry.port === undefined || entry.port === port));
  };

  const isCapturePath = (req: Request): boolean => {
    const pathOnly = req.originalUrl.split('?')[0].toLowerCase();
    return pathOnly === prefix || pathOnly.startsWith(`${prefix}/`);
  };

  /** The extension's own origin, on a capture route, with the pairing token. */
  const extensionAllowed = (req: Request, origin: string): boolean => {
    if (options.verifyPairingToken === undefined) return false;
    const configured = options.extensionOrigin;
    const originOk =
      configured !== undefined && configured !== '' ? origin === configured : EXTENSION_ORIGIN.test(origin);
    if (!originOk || !isCapturePath(req)) return false;
    // A preflight cannot carry the token by definition. It is let through only for
    // the exact origin the operator configured, and the router answers it itself.
    if (req.method === 'OPTIONS') return configured !== undefined && configured !== '';
    return options.verifyPairingToken(req.get(CAPTURE_TOKEN_HEADER));
  };

  return (req, res, next) => {
    const host = parseHostHeader(req.headers.host);
    if (host === undefined || !hostAllowed(host.hostname, host.port ?? '80')) {
      const shown = String(req.headers.host ?? '(none)').slice(0, 80);
      sendDenied(
        res,
        421,
        'Host not allowed',
        `This server answers /api requests addressed to localhost, 127.0.0.1 or [::1] on port ${options.port}. ` +
          `To allow ${JSON.stringify(shown)}, add it to OMNI_ALLOWED_HOSTS and restart.`
      );
      return;
    }
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      const parsed = parseOrigin(origin);
      if ((parsed !== undefined && hostAllowed(parsed.hostname, parsed.port)) || extensionAllowed(req, origin)) {
        next();
        return;
      }
      sendDenied(
        res,
        403,
        'Origin not allowed',
        `Requests that change data must come from this app. Origin ${JSON.stringify(origin.slice(0, 80))} is not an allowed origin.`
      );
      return;
    }

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none') {
      next();
      return;
    }
    sendDenied(
      res,
      403,
      'Cross-site request refused',
      `Requests that change data must come from this app. Sec-Fetch-Site was ${JSON.stringify(String(fetchSite).slice(0, 40))}.`
    );
  };
}

export interface InstallApiGuardOptions {
  readonly port: number;
  /** Raw `OMNI_ALLOWED_HOSTS`. */
  readonly allowedHostsEnv?: string | undefined;
  /** The bind host (`OMNI_HOST`). */
  readonly bindHost: string;
  readonly captureRoutePrefix: string;
  readonly verifyPairingToken?: (received: string | undefined) => boolean;
  readonly extensionOrigin?: string;
}

/**
 * Mount the guard on `/api` and return the startup banner lines for it.
 * Call it before any other route is registered, so no `/api` route runs unguarded.
 * Throws on a malformed `OMNI_ALLOWED_HOSTS`.
 */
export function installApiHostOriginGuard(app: Express, options: InstallApiGuardOptions): readonly string[] {
  const extraHosts = resolveAllowedHosts({ allowedHosts: options.allowedHostsEnv, bindHost: options.bindHost });
  app.use(
    '/api',
    createHostOriginGuard({
      port: options.port,
      extraHosts,
      captureRoutePrefix: options.captureRoutePrefix,
      ...(options.verifyPairingToken === undefined ? {} : { verifyPairingToken: options.verifyPairingToken }),
      ...(options.extensionOrigin === undefined ? {} : { extensionOrigin: options.extensionOrigin }),
    })
  );
  const names = extraHosts.map(h => (h.port === undefined ? h.hostname : `${h.hostname}:${h.port}`));
  const lines = [
    `API Host/Origin guard: /api accepts Host localhost, 127.0.0.1 or [::1] on port ${options.port}${
      names.length > 0 ? ` plus ${names.join(', ')}` : ''
    }.`,
  ];
  if (!isLoopbackHost(options.bindHost) && names.length === 0) {
    lines.push(
      '  The server is bound to the network but OMNI_ALLOWED_HOSTS is empty, so other machines get 421.',
      '  Set OMNI_ALLOWED_HOSTS to the address they use, for example OMNI_ALLOWED_HOSTS=192.168.1.20.'
    );
  }
  return lines;
}
