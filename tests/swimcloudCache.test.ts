/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the status-keyed cache (`packages/swimcloud/src/cache.ts`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSystemSwimCloudCache,
  InMemorySwimCloudCache,
  type SwimCloudCacheEntry,
  type SwimCloudCacheStore,
} from '@omniswim/swimcloud';

function entry(overrides: Partial<SwimCloudCacheEntry> = {}): SwimCloudCacheEntry {
  return {
    canonicalUrl: 'https://www.swimcloud.com/team/633/',
    html: '<div>fixture</div>',
    status: 'provisional',
    retrievedAt: '2026-09-07T00:00:00.000Z',
    track: 'synthetic-fixture',
    ...overrides,
  };
}

function sharedBehavior(name: string, makeStore: () => SwimCloudCacheStore) {
  describe(`${name} — shared SwimCloudCacheStore contract`, () => {
    it('returns undefined for a URL that was never set', async () => {
      const store = makeStore();
      expect(await store.get('https://www.swimcloud.com/team/999/')).toBeUndefined();
    });

    it('round-trips an entry by canonicalUrl', async () => {
      const store = makeStore();
      await store.set(entry());
      expect(await store.get(entry().canonicalUrl)).toEqual(entry());
    });

    it('overwrites an existing entry for the same canonicalUrl rather than duplicating it', async () => {
      const store = makeStore();
      await store.set(entry({ status: 'provisional', html: '<div>v1</div>' }));
      await store.set(entry({ status: 'final', html: '<div>v2</div>' }));
      expect(await store.get(entry().canonicalUrl)).toMatchObject({ status: 'final', html: '<div>v2</div>' });
      expect(await store.list()).toHaveLength(1);
    });

    it('delete removes the entry; deleting an absent one is a no-op, not an error', async () => {
      const store = makeStore();
      await store.set(entry());
      await store.delete(entry().canonicalUrl);
      expect(await store.get(entry().canonicalUrl)).toBeUndefined();
      await expect(store.delete('https://www.swimcloud.com/team/999/')).resolves.toBeUndefined();
    });

    it('list returns every stored entry, and an empty store is an empty array, not an error', async () => {
      const store = makeStore();
      expect(await store.list()).toEqual([]);
      await store.set(entry({ canonicalUrl: 'https://www.swimcloud.com/team/633/' }));
      await store.set(entry({ canonicalUrl: 'https://www.swimcloud.com/team/704/' }));
      const all = await store.list();
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.canonicalUrl).sort()).toEqual([
        'https://www.swimcloud.com/team/633/',
        'https://www.swimcloud.com/team/704/',
      ]);
    });

    it('distinguishes two canonicalUrls that differ only by query string', async () => {
      const store = makeStore();
      await store.set(entry({ canonicalUrl: 'https://www.swimcloud.com/team/633/roster/?page=1', html: 'page1' }));
      await store.set(entry({ canonicalUrl: 'https://www.swimcloud.com/team/633/roster/?page=2', html: 'page2' }));
      expect((await store.get('https://www.swimcloud.com/team/633/roster/?page=1'))?.html).toBe('page1');
      expect((await store.get('https://www.swimcloud.com/team/633/roster/?page=2'))?.html).toBe('page2');
    });
  });
}

sharedBehavior('InMemorySwimCloudCache', () => new InMemorySwimCloudCache());

describe('FileSystemSwimCloudCache', () => {
  let dir: string;

  const makeStore = () => {
    dir = mkdtempSync(join(tmpdir(), 'swimcloud-cache-test-'));
    return new FileSystemSwimCloudCache(dir);
  };

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  sharedBehavior('FileSystemSwimCloudCache', makeStore);

  it('creates the directory on first write if it does not exist yet', async () => {
    const nested = join(mkdtempSync(join(tmpdir(), 'swimcloud-cache-test-')), 'nested', 'deeper');
    const store = new FileSystemSwimCloudCache(nested);
    await store.set(entry());
    expect(await store.get(entry().canonicalUrl)).toEqual(entry());
    rmSync(nested, { recursive: true, force: true });
  });

  it('list on a directory that was never created returns [], not an error', async () => {
    const neverCreated = join(tmpdir(), `swimcloud-cache-never-${Date.now()}`);
    const store = new FileSystemSwimCloudCache(neverCreated);
    expect(await store.list()).toEqual([]);
  });

  it('persists across separate store instances pointed at the same directory', async () => {
    const first = new FileSystemSwimCloudCache(dir);
    await first.set(entry());
    const second = new FileSystemSwimCloudCache(dir);
    expect(await second.get(entry().canonicalUrl)).toEqual(entry());
  });
});
