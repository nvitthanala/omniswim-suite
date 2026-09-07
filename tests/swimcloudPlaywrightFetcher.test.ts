/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `packages/swimcloud/src/playwrightFetcher.ts`.
 *
 * This suite deliberately never calls `.fetchRaw()` — doing so launches a
 * real Chromium browser, and no Chromium binary is installed in the
 * environment this was written in (`npx playwright install` was never run;
 * see the file's own header and the Phase 1a commit's "environment issues"
 * note). What's tested here is everything that doesn't require a running
 * browser: constructor validation and the `storageState` path helper. The
 * class's actual fetch behavior — and, more importantly, whether it can pass
 * SwimCloud's Cloudflare challenge at all — is unverified. That is not a gap
 * this test file can close; it needs one supervised, human-present run
 * against a real SwimCloud URL (04-phasing.md Phase 2 acceptance criterion).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaywrightSwimCloudFetcher, storageStateArgument } from '@omniswim/swimcloud';

describe('PlaywrightSwimCloudFetcher — construction', () => {
  it('accepts a well-formed, honest User-Agent, and an optional storageStatePath regardless of whether that file exists', () => {
    // Also confirms construction never touches playwright-core: if it did,
    // this would throw for a different reason (no Chromium binary installed
    // in this environment — see the file header). The class is documented to
    // defer that import until fetchRaw() is actually called.
    expect(() => new PlaywrightSwimCloudFetcher({ userAgent: 'omniswim-suite-swimcloud-fetcher/0.1' })).not.toThrow();
    expect(
      () =>
        new PlaywrightSwimCloudFetcher({
          userAgent: 'omniswim-suite-swimcloud-fetcher/0.1',
          storageStatePath: '/does/not/exist/yet.json',
        }),
    ).not.toThrow();
  });

  it('refuses a blank User-Agent rather than silently falling back to a default browser string', () => {
    expect(() => new PlaywrightSwimCloudFetcher({ userAgent: '' })).toThrow(/User-Agent/);
    expect(() => new PlaywrightSwimCloudFetcher({ userAgent: '   ' })).toThrow(/User-Agent/);
  });
});

describe('storageStateArgument — the actual missing-file-means-no-session-yet logic', () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves to undefined when the file does not exist yet — the normal state before any session is warmed up', async () => {
    dir = mkdtempSync(join(tmpdir(), 'swimcloud-storagestate-test-'));
    const path = join(dir, 'never-created.json');
    expect(await storageStateArgument(path)).toBeUndefined();
  });

  it('resolves to the path itself when the file exists, so Playwright can rehydrate the session', async () => {
    dir = mkdtempSync(join(tmpdir(), 'swimcloud-storagestate-test-'));
    const path = join(dir, 'session.json');
    writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    expect(await storageStateArgument(path)).toBe(path);
  });

  it('resolves to undefined for a path whose parent directory does not even exist', async () => {
    expect(await storageStateArgument('/definitely/not/a/real/path/session.json')).toBeUndefined();
  });
});
