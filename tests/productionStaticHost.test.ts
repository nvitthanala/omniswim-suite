/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Production static serving applies the same Host allow-list as /api
 * (OMNI_ALLOWED_HOSTS; loopback names on the server's own port always pass).
 * Vite's `allowedHosts` covers dev only, so a production page, asset or history
 * fallback must not be served to a Host the guard refuses (DNS rebinding).
 *
 * Mounts `mountProductionStatic`, the function server.ts calls, on a bare app and
 * sends the Host header through `node:http` so the test names it.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountProductionStatic } from '../apps/shell/lib/productionStatic.ts';
import { startTestServer, type TestServer } from './helpers/rawHttp';

const INDEX = '<!doctype html><title>Omni test bundle</title>';
const ASSET = 'console.log("omni asset");';

let dist: string;
beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-static-'));
  fs.writeFileSync(path.join(dist, 'index.html'), INDEX);
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), ASSET);
});
afterAll(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

function build(options: { allowedHostsEnv?: string; bindHost?: string } = {}): Promise<TestServer> {
  return startTestServer(port => {
    const app = express();
    mountProductionStatic(app, {
      distDir: dist,
      port,
      allowedHostsEnv: options.allowedHostsEnv,
      bindHost: options.bindHost ?? '127.0.0.1',
    });
    return app;
  });
}

describe('production static serving, Host check', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await build();
  });
  afterAll(async () => {
    await server.close();
  });

  it('serves the page, an asset and a deep link on the loopback names and the configured port', async () => {
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`, `[::1]:${server.port}`]) {
      const page = await server.request({ path: '/', headers: { Host: host } });
      expect(page.status, host).toBe(200);
      expect(page.text).toBe(INDEX);
      const asset = await server.request({ path: '/assets/app.js', headers: { Host: host } });
      expect(asset.status, host).toBe(200);
      expect(asset.text).toBe(ASSET);
      const deep = await server.request({ path: '/matrix/some/deep/link', headers: { Host: host } });
      expect(deep.status, host).toBe(200);
      expect(deep.text).toBe(INDEX);
    }
  });

  it('answers 421 for an unknown Host on the page, an asset, a deep link and an unknown /api path', async () => {
    for (const route of ['/', '/index.html', '/assets/app.js', '/matrix/some/deep/link', '/api/anything']) {
      const res = await server.request({ path: route, headers: { Host: 'evil.example' } });
      expect(res.status, route).toBe(421);
      expect(res.headers['content-type'], route).toMatch(/^text\/plain/);
      expect(res.text, route).toContain('OMNI_ALLOWED_HOSTS');
      expect(res.text, route).not.toContain('Omni test bundle');
      expect(res.text, route).not.toContain('omni asset');
    }
  });

  it('answers 421 for a rebinding style name and for a loopback name on the wrong port', async () => {
    for (const host of [
      `localhost.evil.example:${server.port}`,
      `127.0.0.1.evil.example:${server.port}`,
      '127.0.0.1:9',
      'localhost',
    ]) {
      const res = await server.request({ path: '/', headers: { Host: host } });
      expect(res.status, host).toBe(421);
    }
  });

  it('keeps an /api path that passes the host check as a JSON 404', async () => {
    const res = await server.request({ path: '/api/nope', headers: { Host: `127.0.0.1:${server.port}` } });
    expect(res.status).toBe(404);
    expect(res.json.code ?? res.json.error).toBeTruthy();
  });
});

describe('production static serving, OMNI_ALLOWED_HOSTS and the bind host', () => {
  it('serves a listed host (any port, or only the listed port) and still refuses an unlisted one', async () => {
    const server = await build({ allowedHostsEnv: 'omni.lan, other.lan:4321' });
    try {
      const any = await server.request({ path: '/', headers: { Host: `omni.lan:${server.port}` } });
      expect(any.status).toBe(200);
      const exact = await server.request({ path: '/assets/app.js', headers: { Host: 'other.lan:4321' } });
      expect(exact.status).toBe(200);
      const wrongPort = await server.request({ path: '/', headers: { Host: 'other.lan:80' } });
      expect(wrongPort.status).toBe(421);
      const unlisted = await server.request({ path: '/', headers: { Host: 'evil.example' } });
      expect(unlisted.status).toBe(421);
    } finally {
      await server.close();
    }
  });

  it('serves the address of a deliberate non-loopback bind, and nothing else', async () => {
    const server = await build({ bindHost: '192.168.1.20' });
    try {
      const bound = await server.request({ path: '/', headers: { Host: '192.168.1.20' } });
      expect(bound.status).toBe(200);
      const other = await server.request({ path: '/', headers: { Host: '192.168.1.21' } });
      expect(other.status).toBe(421);
    } finally {
      await server.close();
    }
  });

  it('refuses to start on a malformed OMNI_ALLOWED_HOSTS instead of dropping the entry', () => {
    expect(() =>
      mountProductionStatic(express(), { distDir: dist, port: 3000, allowedHostsEnv: 'https://omni.lan', bindHost: '127.0.0.1' })
    ).toThrow(/OMNI_ALLOWED_HOSTS entry/);
  });
});
