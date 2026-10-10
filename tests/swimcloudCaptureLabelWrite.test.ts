/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The school-name cache write that `GET /api/swimcloud/captures` does (`withTeamName`) writes ONLY
 * the label. It must never roll back a re-crawl that landed after the list call read its copy of the
 * record. Pages come from the committed theoretical-meet fixture store; no competition value is typed.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemSwimCloudCaptureStore, type SwimCloudCaptureRecord } from '../packages/swimcloud/src/captureStore';
import { withTeamName } from '../apps/shell/lib/swimcloudCaptureTeamName';
import {
  createSwimCloudCaptureRouter,
  SWIMCLOUD_CAPTURE_ROUTE_BASE,
  SWIMCLOUD_CAPTURE_TOKEN_HEADER,
} from '../apps/shell/lib/swimcloudCaptureRoutes';
import { FIXTURE_ROOT } from './theoreticalMeetUiFixtures';

const ID = 'team-412-2026-2027';
const TOKEN = 'c'.repeat(48);
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function copyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-label-'));
  dirs.push(dir);
  cpSync(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

/** A store that runs `beforeLabelWrite` once, right after the first roster page is read. */
class RacingStore extends FileSystemSwimCloudCaptureStore {
  hook: (() => Promise<void>) | undefined;
  override async readPage(url: string) {
    const entry = await super.readPage(url);
    const hook = this.hook;
    this.hook = undefined;
    if (hook !== undefined) await hook();
    return entry;
  }
}

function newerPages(record: SwimCloudCaptureRecord): SwimCloudCaptureRecord['pages'] {
  return record.pages.map((p, i) =>
    i === 0 ? { ...p, retrievedAt: '2026-10-08T00:00:00.000Z', sha256: 'f'.repeat(64) } : p
  );
}

describe('FileSystemSwimCloudCaptureStore.setCaptureLabel', () => {
  it('sets only the label and keeps updatedAt, pages and counts', async () => {
    const store = new FileSystemSwimCloudCaptureStore(copyDir());
    const before = (await store.getCapture(ID))!;
    const saved = await store.setCaptureLabel(ID, 'Some University');
    expect(saved).toEqual({ ...before, label: 'Some University' });
    expect(await store.getCapture(ID)).toEqual({ ...before, label: 'Some University' });
  });

  it('keeps an existing label, skips an in-progress capture, and creates nothing for an unknown id', async () => {
    const store = new FileSystemSwimCloudCaptureStore(copyDir());
    const before = (await store.getCapture(ID))!;
    await store.upsertCapture({ ...before, label: 'First' });
    const labelled = (await store.getCapture(ID))!;
    expect((await store.setCaptureLabel(ID, 'Second'))?.label).toBe('First');
    expect(await store.getCapture(ID)).toEqual(labelled);

    await store.upsertCapture({ ...labelled, label: undefined, completeness: 'in-progress' });
    const running = (await store.getCapture(ID))!;
    expect((await store.setCaptureLabel(ID, 'Third'))?.completeness).toBe('in-progress');
    expect(await store.getCapture(ID)).toEqual(running);

    expect(await store.setCaptureLabel('team-999-2026-2027', 'X')).toBeUndefined();
    expect(await store.getCapture('team-999-2026-2027')).toBeUndefined();
  });
});

describe('withTeamName against a concurrent re-crawl', () => {
  it('keeps the newer record (pages, completeness, planned count) and adds only the label', async () => {
    const store = new RacingStore(copyDir());
    const stale = (await store.getCapture(ID))!;
    expect(stale.label).toBeUndefined();
    // A re-crawl finishes between the list read and the label write.
    store.hook = async () => {
      await store.upsertCapture({
        ...stale,
        completeness: 'partial',
        plannedPageCount: stale.plannedPageCount + 7,
        pages: newerPages(stale),
      });
    };
    const listed = await withTeamName(store, stale);
    const stored = (await store.getCapture(ID))!;
    expect(listed.teamName).toMatch(/\S/);
    expect(stored.label).toBe(listed.teamName);
    expect(stored.completeness).toBe('partial');
    expect(stored.plannedPageCount).toBe(stale.plannedPageCount + 7);
    expect(stored.pages).toEqual(newerPages(stale));
    expect(stored.pages[0].sha256).toBe('f'.repeat(64));
    // The answer handed back is the newer record too, not the stale copy.
    expect(listed.plannedPageCount).toBe(stale.plannedPageCount + 7);
    expect(listed.pages).toEqual(newerPages(stale));
  });

  it('never writes a capture whose re-crawl started after the list read it', async () => {
    const store = new RacingStore(copyDir());
    const stale = (await store.getCapture(ID))!;
    store.hook = async () => {
      await store.upsertCapture({ ...stale, completeness: 'in-progress', plannedPageCount: 40, pages: [] });
    };
    const listed = await withTeamName(store, stale);
    const stored = (await store.getCapture(ID))!;
    expect(listed.teamName).toMatch(/\S/);
    expect(stored.label).toBeUndefined();
    expect(stored.completeness).toBe('in-progress');
    expect(stored.plannedPageCount).toBe(40);
    expect(stored.pages).toEqual(stale.pages);
    expect(stored.updatedAt).not.toBe(stale.updatedAt);
  });

  it('returns the parsed name when the label write fails', async () => {
    const store = new FileSystemSwimCloudCaptureStore(copyDir());
    const stale = (await store.getCapture(ID))!;
    vi.spyOn(store, 'setCaptureLabel').mockRejectedValue(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listed = await withTeamName(store, stale);
    expect(listed.teamName).toMatch(/\S/);
    expect(warn).toHaveBeenCalled();
    expect((await store.getCapture(ID))?.label).toBeUndefined();
  });
});

describe('GET /api/swimcloud/captures when a label write fails', () => {
  it('answers 200 with the name instead of a 500', async () => {
    const root = copyDir();
    const store = new FileSystemSwimCloudCaptureStore(root);
    vi.spyOn(store, 'setCaptureLabel').mockRejectedValue(new Error('disk full'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = express();
    app.use(SWIMCLOUD_CAPTURE_ROUTE_BASE, createSwimCloudCaptureRouter({ store, captureRoot: root, pairingToken: TOKEN }));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${SWIMCLOUD_CAPTURE_ROUTE_BASE}`, {
        headers: { [SWIMCLOUD_CAPTURE_TOKEN_HEADER]: TOKEN },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ captureId: string; teamName?: string }>;
      expect(body.find(c => c.captureId === ID)?.teamName).toMatch(/\S/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
