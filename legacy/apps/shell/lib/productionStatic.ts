/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Production static serving: the built SPA, behind the same Host allow-list as
 * `/api` (`OMNI_ALLOWED_HOSTS`, plus the loopback names on the server's own port).
 *
 * Kept out of `server.ts` so a test can mount it on a bare Express app. The order
 * is the point: the Host guard comes first, before the static handler and before
 * the history fallback, so no page or asset is served to a refused Host.
 */
import express, { type Express } from 'express';
import path from 'node:path';
import { createStaticHostGuard, resolveAllowedHosts } from './middleware/hostOriginGuard.ts';
import { apiError } from './middleware/apiError.ts';

export interface ProductionStaticOptions {
  /** Directory holding the built SPA (`index.html` and assets). */
  readonly distDir: string;
  /** The port the server listens on. */
  readonly port: number;
  /** Raw `OMNI_ALLOWED_HOSTS`. */
  readonly allowedHostsEnv?: string | undefined;
  /** The bind host (`OMNI_HOST`). */
  readonly bindHost: string;
}

/** Throws on a malformed `OMNI_ALLOWED_HOSTS`, as `installApiHostOriginGuard` does. */
export function mountProductionStatic(app: Express, options: ProductionStaticOptions): void {
  const extraHosts = resolveAllowedHosts({
    allowedHosts: options.allowedHostsEnv,
    bindHost: options.bindHost,
  });
  app.use(createStaticHostGuard({ port: options.port, extraHosts }));
  app.use(express.static(options.distDir));
  app.use('/api', (_req, res) => {
    apiError(res, 404, 'API_ROUTE_NOT_FOUND', 'API route not found — restart the server after updating');
  });
  // Express 5 (path-to-regexp 8) needs a named wildcard; the braces keep `/` matching.
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(options.distDir, 'index.html'));
  });
}
