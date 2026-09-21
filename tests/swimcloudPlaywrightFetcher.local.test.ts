/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one test in this repo that actually launches a browser via
 * `PlaywrightSwimCloudFetcher`. It never points at swimcloud.com or any
 * other real site — only at a throwaway `node:http` server on `127.0.0.1`
 * serving a local fixture file, started and stopped within this file. That
 * is a deliberate boundary: `01-legal-and-access-strategy.md`'s posture for
 * Track B is that touching the *live* site is a human-present action, never
 * something automated, including for testing. This file proves the
 * *mechanism* — launch, navigate, extract `page.content()`, persist and
 * reuse `storageState` — works, which is a different, fully answerable
 * question from "can it pass SwimCloud's Cloudflare challenge," which it
 * still cannot answer and does not attempt to.
 *
 * Skips itself (not fails) when no Chromium binary is installed, matching
 * this repo's existing convention for environment-dependent tests (see
 * `scripts/run-tests.mjs`'s own fixture-skip pattern) — `npx playwright
 * install chromium` is a one-time, ~115 MB download this repo does not
 * assume every environment has done.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightSwimCloudFetcher } from '@omniswim/swimcloud/playwrightFetcher';

function chromiumIsInstalled(): boolean {
  try {
    // playwright-core can report where it *expects* the binary without
    // launching anything — a synchronous, side-effect-free check.

    const { chromium } = require('playwright-core') as typeof import('playwright-core');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const FIXTURE_PATH = join(__dirname, 'fixtures', 'swimcloud-synthetic-team-roster.html');
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf8');

describe.skipIf(!chromiumIsInstalled())('PlaywrightSwimCloudFetcher — local mechanics (no real site touched)', () => {
  let server: Server;
  let baseUrl: string;
  let lastCookieHeaderSeen: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastCookieHeaderSeen = req.headers.cookie;
      res.setHeader('Set-Cookie', 'omniswim_smoke_test=1; Path=/');
      res.setHeader('Content-Type', 'text/html');
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the local test server to bind a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('launches, navigates, and returns the real page content and a 200 status', async () => {
    const fetcher = new PlaywrightSwimCloudFetcher({ userAgent: 'omniswim-suite-local-smoke-test/0.1' });
    const result = await fetcher.fetchRaw(baseUrl);

    expect(result.httpStatus).toBe(200);
    // Confirms this is real, rendered page content from the local server —
    // not a stub, not the fixture read directly off disk by this test.
    expect(result.html).toContain('Henderson State University');
    expect(result.html).toContain('Landon Dehn');
  }, 30_000);

  it('persists a storageState file after a fetch when storageStatePath is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swimcloud-storagestate-smoke-'));
    const storageStatePath = join(dir, 'state.json');
    try {
      expect(existsSync(storageStatePath)).toBe(false);

      const fetcher = new PlaywrightSwimCloudFetcher({
        userAgent: 'omniswim-suite-local-smoke-test/0.1',
        storageStatePath,
      });
      await fetcher.fetchRaw(baseUrl);

      expect(existsSync(storageStatePath)).toBe(true);
      const state = JSON.parse(readFileSync(storageStatePath, 'utf8'));
      expect(Array.isArray(state.cookies)).toBe(true);
      // The local server set a cookie on the response; a real session was
      // established and its state was actually captured, not an empty stub.
      expect(state.cookies.some((c: { name: string }) => c.name === 'omniswim_smoke_test')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('reuses a persisted session on a second, separate fetcher instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swimcloud-storagestate-smoke-'));
    const storageStatePath = join(dir, 'state.json');
    try {
      const first = new PlaywrightSwimCloudFetcher({
        userAgent: 'omniswim-suite-local-smoke-test/0.1',
        storageStatePath,
      });
      await first.fetchRaw(baseUrl);
      lastCookieHeaderSeen = undefined; // reset before the request we actually care about

      // A brand-new fetcher instance — nothing in memory carries over except
      // the file on disk, which is the entire point of storageState reuse.
      const second = new PlaywrightSwimCloudFetcher({
        userAgent: 'omniswim-suite-local-smoke-test/0.1',
        storageStatePath,
      });
      await second.fetchRaw(baseUrl);

      expect(lastCookieHeaderSeen).toContain('omniswim_smoke_test=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
