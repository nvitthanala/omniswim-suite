/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * S1: the Host and Origin guard on `/api/*`
 * (`apps/shell/lib/middleware/hostOriginGuard.ts`).
 *
 * Each test drives a real Express app on a real ephemeral socket. Requests go
 * through `node:http` so the `Host` header is the one the test names, not the one
 * the client derives from the URL. The real SwimCloud capture router sits behind
 * the guard for the extension cases.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHostOriginGuard,
  installApiHostOriginGuard,
  parseAllowedHosts,
  resolveAllowedHosts,
} from '../apps/shell/lib/middleware/hostOriginGuard';
import {
  createSwimCloudCaptureRouter,
  SWIMCLOUD_CAPTURE_ROUTE_BASE,
  SWIMCLOUD_CAPTURE_TOKEN_HEADER,
  timingSafeTokenEquals,
} from '../apps/shell/lib/swimcloudCaptureRoutes';
import { FileSystemSwimCloudCaptureStore } from '../packages/swimcloud/src/captureStore';
import { startTestServer, type TestServer } from './helpers/rawHttp';

const TOKEN = 'a'.repeat(48);
const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_EXTENSION_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;

let sandbox: string;
/** Counts requests that got past the guard into a data-changing handler. */
let handlerHits = 0;

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-host-guard-'));
});
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

interface AppOptions {
  readonly allowedHostsEnv?: string;
  readonly bindHost?: string;
  /** Register the capture router and give the guard the pairing token check. */
  readonly captureRoutes?: boolean;
  readonly extensionOrigin?: string;
}

function buildServer(options: AppOptions = {}): Promise<TestServer> {
  return startTestServer(port => {
    const app = express();
    installApiHostOriginGuard(app, {
      port,
      allowedHostsEnv: options.allowedHostsEnv,
      bindHost: options.bindHost ?? '127.0.0.1',
      captureRoutePrefix: SWIMCLOUD_CAPTURE_ROUTE_BASE,
      ...(options.captureRoutes === false
        ? {}
        : { verifyPairingToken: (received: string | undefined) => typeof received === 'string' && timingSafeTokenEquals(TOKEN, received) }),
      ...(options.extensionOrigin === undefined ? {} : { extensionOrigin: options.extensionOrigin }),
    });
    if (options.captureRoutes !== false) {
      const captureRoot = fs.mkdtempSync(path.join(sandbox, 'captures-'));
      app.use(
        SWIMCLOUD_CAPTURE_ROUTE_BASE,
        createSwimCloudCaptureRouter({
          store: new FileSystemSwimCloudCaptureStore(captureRoot),
          captureRoot,
          pairingToken: TOKEN,
          ...(options.extensionOrigin === undefined ? {} : { extensionOrigin: options.extensionOrigin }),
        })
      );
    }
    app.use(express.json());
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    app.post('/api/workspaces', (_req, res) => {
      handlerHits += 1;
      res.json({ ok: true });
    });
    return app;
  });
}

const capturePost = { subject: { kind: 'meet', meetId: '123' } };

describe('S1 Host check', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildServer();
  });
  afterAll(() => server.close());

  it('answers 421 for a Host that is not localhost, 127.0.0.1 or [::1]', async () => {
    const res = await server.request({ path: '/api/ping', headers: { Host: 'evil.example' } });
    expect(res.status).toBe(421);
    expect(res.json.error).toBe('Host not allowed');
    expect(res.text).not.toContain('"ok":true');
  });

  it('answers 421 for a DNS-rebinding style name that merely contains a loopback name', async () => {
    for (const host of [
      `localhost.evil.example:${server.port}`,
      `127.0.0.1.evil.example:${server.port}`,
      `evil.example:${server.port}`,
    ]) {
      const res = await server.request({ path: '/api/ping', headers: { Host: host } });
      expect(res.status, host).toBe(421);
    }
  });

  it('answers 421 for a loopback name on the wrong port, and for a missing port', async () => {
    const wrong = await server.request({ path: '/api/ping', headers: { Host: '127.0.0.1:9' } });
    expect(wrong.status).toBe(421);
    const none = await server.request({ path: '/api/ping', headers: { Host: 'localhost' } });
    expect(none.status).toBe(421);
  });

  it('accepts localhost, 127.0.0.1 and [::1] on the configured port', async () => {
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`, `[::1]:${server.port}`]) {
      const res = await server.request({ path: '/api/ping', headers: { Host: host } });
      expect(res.status, host).toBe(200);
    }
  });

  it('guards every /api path, including a different letter case', async () => {
    const res = await server.request({ path: '/API/ping', headers: { Host: 'evil.example' } });
    expect(res.status).toBe(421);
  });
});

describe('S1 Origin check on data-changing methods', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildServer();
  });
  afterAll(() => server.close());

  const post = (headers: Record<string, string>, extra: { path?: string; method?: string } = {}) =>
    server.request({ method: extra.method ?? 'POST', path: extra.path ?? '/api/workspaces', headers, body: {} });

  it('answers 403 for a POST from another origin and never runs the handler', async () => {
    const before = handlerHits;
    const res = await post({ Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('Origin not allowed');
    expect(handlerHits).toBe(before);
  });

  it('answers 403 for PUT and DELETE from another origin, and for Origin: null', async () => {
    expect((await post({ Origin: 'https://evil.example' }, { method: 'PUT' })).status).toBe(403);
    expect((await post({ Origin: 'https://evil.example' }, { method: 'DELETE' })).status).toBe(403);
    expect((await post({ Origin: 'null' })).status).toBe(403);
  });

  it('answers 403 for another local app on a different port', async () => {
    expect((await post({ Origin: 'http://localhost:5173' })).status).toBe(403);
  });

  it('accepts a same-origin POST', async () => {
    const before = handlerHits;
    const res = await post({ Origin: `http://127.0.0.1:${server.port}` });
    expect(res.status).toBe(200);
    expect(handlerHits).toBe(before + 1);
    const viaLocalhost = await post({
      Host: `localhost:${server.port}`,
      Origin: `http://localhost:${server.port}`,
    });
    expect(viaLocalhost.status).toBe(200);
  });

  it('lets Origin decide when it is present, even if Sec-Fetch-Site says same-origin', async () => {
    const res = await post({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(403);
  });

  it('with no Origin, lets Sec-Fetch-Site decide', async () => {
    expect((await post({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await post({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await post({ 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  });

  it('accepts a request with neither header, which is a script and not a browser', async () => {
    expect((await post({})).status).toBe(200);
  });

  it('does not apply the Origin rule to GET', async () => {
    const res = await server.request({ path: '/api/ping', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
  });

  it('still applies the Host rule to a POST that has a good Origin', async () => {
    const res = await post({ Host: 'evil.example', Origin: 'http://evil.example' });
    expect(res.status).toBe(421);
  });
});

describe('S1 extension origin on the capture routes', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildServer();
  });
  afterAll(() => server.close());

  const capture = (headers: Record<string, string>) =>
    server.request({ method: 'POST', path: SWIMCLOUD_CAPTURE_ROUTE_BASE, headers, body: capturePost });

  it('accepts a chrome-extension origin with the pairing token on a capture route', async () => {
    const res = await capture({ Origin: EXTENSION_ORIGIN, [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN });
    expect([200, 201]).toContain(res.status);
    expect(res.json.captureId).toBe('meet-123');
  });

  it('refuses a chrome-extension origin with no token or the wrong token', async () => {
    expect((await capture({ Origin: EXTENSION_ORIGIN })).status).toBe(403);
    expect((await capture({ Origin: EXTENSION_ORIGIN, [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: 'b'.repeat(48) })).status).toBe(403);
  });

  it('refuses a chrome-extension origin on any route that is not a capture route', async () => {
    const before = handlerHits;
    const res = await server.request({
      method: 'POST',
      path: '/api/workspaces',
      headers: { Origin: EXTENSION_ORIGIN, [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN },
      body: {},
    });
    expect(res.status).toBe(403);
    expect(handlerHits).toBe(before);
  });

  it('refuses a web page origin on a capture route even with the token', async () => {
    const res = await capture({ Origin: 'https://evil.example', [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin POST to a capture route with the token (the app UI path)', async () => {
    const res = await capture({
      Origin: `http://127.0.0.1:${server.port}`,
      [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN,
    });
    expect([200, 201]).toContain(res.status);
  });

  it('refuses a malformed extension origin', async () => {
    const res = await capture({ Origin: 'chrome-extension://short', [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(403);
  });
});

describe('S1 configured extension origin', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildServer({ extensionOrigin: EXTENSION_ORIGIN });
  });
  afterAll(() => server.close());

  it('accepts only the exact configured origin', async () => {
    const headers = { [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN };
    const ok = await server.request({
      method: 'POST',
      path: SWIMCLOUD_CAPTURE_ROUTE_BASE,
      headers: { ...headers, Origin: EXTENSION_ORIGIN },
      body: capturePost,
    });
    expect(ok.status).toBe(201);
    const other = await server.request({
      method: 'POST',
      path: SWIMCLOUD_CAPTURE_ROUTE_BASE,
      headers: { ...headers, Origin: OTHER_EXTENSION_ORIGIN },
      body: capturePost,
    });
    expect(other.status).toBe(403);
  });

  it('lets the configured origin preflight, and refuses another origin', async () => {
    const ok = await server.request({
      method: 'OPTIONS',
      path: SWIMCLOUD_CAPTURE_ROUTE_BASE,
      headers: { Origin: EXTENSION_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);
    const other = await server.request({
      method: 'OPTIONS',
      path: SWIMCLOUD_CAPTURE_ROUTE_BASE,
      headers: { Origin: OTHER_EXTENSION_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(other.status).toBe(403);
  });
});

describe('S1 extension origin when capture routes are not registered', () => {
  it('is never accepted', async () => {
    const server = await buildServer({ captureRoutes: false });
    try {
      const res = await server.request({
        method: 'POST',
        path: SWIMCLOUD_CAPTURE_ROUTE_BASE,
        headers: { Origin: EXTENSION_ORIGIN, [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN },
        body: capturePost,
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe('S1 OMNI_ALLOWED_HOSTS and the bind host', () => {
  it('allows a listed host on any port, and a host:port entry only on that port', async () => {
    const server = await buildServer({ allowedHostsEnv: `omni.lan, other.lan:${4321}` });
    try {
      const any = await server.request({ path: '/api/ping', headers: { Host: `omni.lan:${server.port}` } });
      expect(any.status).toBe(200);
      const exact = await server.request({ path: '/api/ping', headers: { Host: 'other.lan:4321' } });
      expect(exact.status).toBe(200);
      const wrongPort = await server.request({ path: '/api/ping', headers: { Host: 'other.lan:80' } });
      expect(wrongPort.status).toBe(421);
      const unlisted = await server.request({ path: '/api/ping', headers: { Host: 'evil.example' } });
      expect(unlisted.status).toBe(421);
      const post = await server.request({
        method: 'POST',
        path: '/api/workspaces',
        headers: { Host: 'omni.lan', Origin: 'http://omni.lan' },
        body: {},
      });
      expect(post.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('parseAllowedHosts rejects an entry that is a URL, instead of dropping it', () => {
    expect(() => parseAllowedHosts('https://omni.lan')).toThrow(/OMNI_ALLOWED_HOSTS entry/);
    expect(() => parseAllowedHosts('omni.lan/path')).toThrow(/OMNI_ALLOWED_HOSTS entry/);
    expect(parseAllowedHosts(' a.lan , b.lan:3000 ')).toEqual([
      { hostname: 'a.lan', port: undefined },
      { hostname: 'b.lan', port: '3000' },
    ]);
  });

  it('adds a specific non-loopback bind host, and nothing for a wildcard or loopback bind', () => {
    expect(resolveAllowedHosts({ bindHost: '192.168.1.20' })).toEqual([{ hostname: '192.168.1.20', port: undefined }]);
    expect(resolveAllowedHosts({ bindHost: '0.0.0.0' })).toEqual([]);
    expect(resolveAllowedHosts({ bindHost: '127.0.0.1' })).toEqual([]);
    expect(resolveAllowedHosts({ bindHost: '::' })).toEqual([]);
  });

  it('warns in the banner when the bind is the network and no host is allowed', () => {
    const app = express();
    const wildcard = installApiHostOriginGuard(app, {
      port: 3000,
      bindHost: '0.0.0.0',
      captureRoutePrefix: SWIMCLOUD_CAPTURE_ROUTE_BASE,
    });
    expect(wildcard.join('\n')).toMatch(/OMNI_ALLOWED_HOSTS is empty/);
    const loopback = installApiHostOriginGuard(express(), {
      port: 3000,
      bindHost: '127.0.0.1',
      captureRoutePrefix: SWIMCLOUD_CAPTURE_ROUTE_BASE,
    });
    expect(loopback.join('\n')).not.toMatch(/OMNI_ALLOWED_HOSTS is empty/);
  });
});

describe('S1 mount order in server.ts', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'apps', 'shell', 'server.ts'), 'utf8');

  it('mounts the guard before the capture routes, the parsers and every other route', () => {
    const guard = source.indexOf('installApiHostOriginGuard(app');
    expect(guard).toBeGreaterThan(-1);
    for (const later of [
      'registerSwimCloudCaptureRoutes(app',
      'express.json({ limit',
      'registerAuthRoutes(app',
      'registerWorkspaceRoutes(app',
      'registerParsingRoutes(app',
    ]) {
      const at = source.indexOf(later);
      expect(at, later).toBeGreaterThan(-1);
      expect(guard, `guard must precede ${later}`).toBeLessThan(at);
    }
  });

  it('exposes the same guard factory the tests build on', () => {
    expect(typeof createHostOriginGuard).toBe('function');
  });
});
