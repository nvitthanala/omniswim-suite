/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/swimcloud/src/captureStore.ts` tests, against a real temp
 * directory on disk (not mocked fs) — the same posture `cache.ts`'s own
 * tests take, since this module's whole job is a correct filesystem layout.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  captureIdForSubject,
  FileSystemSwimCloudCaptureStore,
  type SwimCloudCapturePageRef,
  type SwimCloudCaptureRecord,
} from '@omniswim/swimcloud';
import { swimCloudPageBytesDiffer } from '@omniswim/swimcloud/captureStore';

const root = mkdtempSync(join(tmpdir(), 'omniswim-capture-store-test-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function blankMeetCapture(captureId: string, meetId: string): SwimCloudCaptureRecord {
  return {
    captureId,
    subject: { kind: 'meet', meetId },
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    track: 'browser-extension',
    completeness: 'in-progress',
    plannedPageCount: 2,
    pages: [],
    notes: [],
  };
}

/** A minimal successful page ref, distinguished only by its `canonicalUrl` — the merge key. */
function pageRefFor(canonicalUrl: string): SwimCloudCapturePageRef {
  return {
    canonicalUrl,
    resourceKind: 'meetEvent',
    retrievedAt: '2026-09-08T00:00:00.000Z',
    cacheStatus: 'final',
    outcome: 'ok',
  };
}

describe('captureIdForSubject', () => {
  it('derives a meet capture id from the meet id alone', () => {
    expect(captureIdForSubject({ kind: 'meet', meetId: '356467' })).toBe('meet-356467');
  });

  it('derives a team capture id, with and without a season', () => {
    expect(captureIdForSubject({ kind: 'team', teamId: '58' })).toBe('team-58');
    expect(captureIdForSubject({ kind: 'team', teamId: '58', season: '2026-2027' })).toBe('team-58-2026-2027');
  });
});

describe('FileSystemSwimCloudCaptureStore', () => {
  it('returns undefined for a capture that was never created', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'a'));
    expect(await store.getCapture('meet-999999')).toBeUndefined();
    expect(await store.listCaptures()).toHaveLength(0);
  });

  it('creates, reads back, and lists a capture', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'b'));
    const created = await store.upsertCapture(blankMeetCapture('meet-356467', '356467'));
    expect(created.captureId).toBe('meet-356467');

    const fetched = await store.getCapture('meet-356467');
    expect(fetched?.subject).toStrictEqual({ kind: 'meet', meetId: '356467' });

    const listed = await store.listCaptures();
    expect(listed).toHaveLength(1);
    expect(listed[0].captureId).toBe('meet-356467');
  });

  it('putPage refuses to write into a capture that was never opened', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'c'));
    await expect(
      store.putPage(
        'meet-000001',
        undefined,
        {
          canonicalUrl: 'https://www.swimcloud.com/results/1/topteams/?gender=M',
          resourceKind: 'meetTopTeams',
          retrievedAt: '2026-09-08T00:00:00.000Z',
          cacheStatus: 'final',
          outcome: 'ok',
        },
      ),
    ).rejects.toThrow(/no capture/i);
  });

  it('putPage stores the page bytes and patches the capture\'s page list', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'd'));
    await store.upsertCapture(blankMeetCapture('meet-356467', '356467'));

    const canonicalUrl = 'https://www.swimcloud.com/results/356467/topteams/?gender=M';
    await store.putPage(
      'meet-356467',
      { canonicalUrl, html: '<html>real page</html>', status: 'final', retrievedAt: '2026-09-08T00:00:00.000Z', track: 'browser-extension' },
      {
        canonicalUrl,
        resourceKind: 'meetTopTeams',
        retrievedAt: '2026-09-08T00:00:00.000Z',
        cacheStatus: 'final',
        outcome: 'ok',
      },
    );

    const page = await store.readPage(canonicalUrl);
    expect(page?.html).toBe('<html>real page</html>');
    // captureId is stamped onto the underlying cache entry too — additive field, additive behavior.
    expect(page?.captureId).toBe('meet-356467');

    const capture = await store.getCapture('meet-356467');
    expect(capture?.pages).toHaveLength(1);
    expect(capture?.pages[0].outcome).toBe('ok');
  });

  it('keeps the old bytes when a second capture overwrites the same URL with different bytes', async () => {
    const dir = join(root, 'superseded');
    const store = new FileSystemSwimCloudCaptureStore(dir);
    await store.upsertCapture(blankMeetCapture('meet-9', '9'));
    await store.upsertCapture({ ...blankMeetCapture('team-5', '5'), subject: { kind: 'team', teamId: '5' } });
    const canonicalUrl = 'https://www.swimcloud.com/team/5/roster/?gender=M';
    const ref = { canonicalUrl, resourceKind: 'teamRoster' as const, retrievedAt: '2026-09-22T00:00:00.000Z', cacheStatus: 'final' as const, outcome: 'ok' as const };
    const entry = (html: string, retrievedAt: string) => ({ canonicalUrl, html, status: 'final' as const, retrievedAt, track: 'browser-extension' as const });
    await store.putPage('meet-9', entry('<html>2025-26 roster</html>', '2026-09-22T00:00:00.000Z'), ref);
    await store.putPage('team-5', entry('<html>2026-27 roster</html>', '2026-10-04T00:00:00.000Z'), ref);

    // The cache holds the newest page (one file per URL, as before)...
    expect((await store.readPage(canonicalUrl))?.html).toBe('<html>2026-27 roster</html>');
    // ...and the old bytes survive in the archive.
    const { readdirSync, readFileSync } = await import('node:fs');
    const archived = readdirSync(join(dir, 'pages-superseded'));
    expect(archived).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'pages-superseded', archived[0]), 'utf8')).html).toBe('<html>2025-26 roster</html>');

    // The same bytes again archive nothing new; a repeat of the old overwrite is idempotent.
    await store.putPage('team-5', entry('<html>2026-27 roster</html>', '2026-10-05T00:00:00.000Z'), ref);
    expect(readdirSync(join(dir, 'pages-superseded'))).toHaveLength(1);
  });

  it('archives nothing when the store has no earlier page for the URL, or the capture was never opened', async () => {
    const dir = join(root, 'superseded-none');
    const store = new FileSystemSwimCloudCaptureStore(dir);
    await expect(
      store.putPage(
        'meet-404',
        { canonicalUrl: 'https://www.swimcloud.com/team/6/roster/?gender=M', html: '<html>x</html>', status: 'final', retrievedAt: '2026-10-04T00:00:00.000Z', track: 'browser-extension' },
        { canonicalUrl: 'https://www.swimcloud.com/team/6/roster/?gender=M', resourceKind: 'teamRoster', retrievedAt: '2026-10-04T00:00:00.000Z', cacheStatus: 'final', outcome: 'ok' },
      ),
    ).rejects.toThrow(/no capture/);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, 'pages-superseded'))).toBe(false);
    expect(existsSync(join(dir, 'pages'))).toBe(false);
  });

  it('re-capturing the same URL replaces the page ref, not appends a second one', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'e'));
    await store.upsertCapture(blankMeetCapture('meet-1', '1'));
    const canonicalUrl = 'https://www.swimcloud.com/results/1/topteams/?gender=M';
    const pageRef = (outcome: 'ok' | 'http-error') => ({
      canonicalUrl,
      resourceKind: 'meetTopTeams' as const,
      retrievedAt: '2026-09-08T00:00:00.000Z',
      cacheStatus: 'provisional' as const,
      outcome,
    });
    await store.putPage('meet-1', undefined, pageRef('http-error'));
    await store.putPage('meet-1', undefined, pageRef('ok'));
    const capture = await store.getCapture('meet-1');
    expect(capture?.pages).toHaveLength(1);
    expect(capture?.pages[0].outcome).toBe('ok');
  });

  it('upsertCapture preserves createdAt across a re-capture and moves updatedAt', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'f'));
    const first = await store.upsertCapture(blankMeetCapture('meet-2', '2'));
    const second = await store.upsertCapture({ ...blankMeetCapture('meet-2', '2'), createdAt: '2099-01-01T00:00:00.000Z' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.createdAt);
  });

  it('deleteCapture removes the manifest, and withPages also removes its pages', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'g'));
    await store.upsertCapture(blankMeetCapture('meet-3', '3'));
    const canonicalUrl = 'https://www.swimcloud.com/results/3/topteams/?gender=M';
    await store.putPage(
      'meet-3',
      { canonicalUrl, html: '<html></html>', status: 'final', retrievedAt: '2026-09-08T00:00:00.000Z', track: 'browser-extension' },
      { canonicalUrl, resourceKind: 'meetTopTeams', retrievedAt: '2026-09-08T00:00:00.000Z', cacheStatus: 'final', outcome: 'ok' },
    );

    await store.deleteCapture('meet-3', { withPages: true });
    expect(await store.getCapture('meet-3')).toBeUndefined();
    expect(await store.readPage(canonicalUrl)).toBeUndefined();
  });

  it('does not drop page refs when many putPage calls race on one captureId', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'i'));
    await store.upsertCapture(blankMeetCapture('meet-race', 'race'));

    // Fired without awaiting each one: every call reaches its `getCapture`
    // read before any of them writes, which is exactly the read-modify-write
    // race. Against an unlocked store this leaves one page ref, not 20 —
    // the other 19 are silently overwritten and become invisible to parsing.
    const count = 20;
    const urls = Array.from({ length: count }, (_, i) => `https://www.swimcloud.com/results/race/event/${i}/`);
    await Promise.all(urls.map((canonicalUrl) => store.putPage('meet-race', undefined, pageRefFor(canonicalUrl))));

    const capture = await store.getCapture('meet-race');
    expect(capture?.pages).toHaveLength(count);
    expect(capture?.pages.map((p) => p.canonicalUrl).sort()).toStrictEqual([...urls].sort());
  });

  it('does not drop page refs when upsertCapture calls race on one captureId', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'j'));
    await store.upsertCapture(blankMeetCapture('meet-upsert-race', 'upsert-race'));

    const count = 12;
    const urls = Array.from({ length: count }, (_, i) => `https://www.swimcloud.com/results/upsert/event/${i}/`);
    await Promise.all(
      urls.map((canonicalUrl) =>
        store.upsertCapture({ ...blankMeetCapture('meet-upsert-race', 'upsert-race'), pages: [pageRefFor(canonicalUrl)] }),
      ),
    );

    const capture = await store.getCapture('meet-upsert-race');
    expect(capture?.pages.map((p) => p.canonicalUrl).sort()).toStrictEqual([...urls].sort());
  });

  it('serializes per captureId without serializing different captureIds', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'k'));
    await store.upsertCapture(blankMeetCapture('meet-busy', 'busy'));
    await store.upsertCapture(blankMeetCapture('meet-idle', 'idle'));

    // Completion order, recorded as each putPage resolves. Two properties are
    // read off it, neither of them a wall-clock measurement.
    const completed: string[] = [];
    const busyCount = 20;
    const busy = Array.from({ length: busyCount }, (_, i) =>
      store
        .putPage('meet-busy', undefined, pageRefFor(`https://www.swimcloud.com/results/busy/event/${i}/`))
        .then(() => completed.push(`busy-${i}`)),
    );
    const idle = store
      .putPage('meet-idle', undefined, pageRefFor('https://www.swimcloud.com/results/idle/event/0/'))
      .then(() => completed.push('idle'));

    await Promise.all([...busy, idle]);

    // 1. Same-id operations complete in call order. This is exact, not
    //    approximate: operation k+1 does not begin until operation k has
    //    settled, so its `.then` cannot run first.
    expect(completed.filter((name) => name.startsWith('busy-'))).toStrictEqual(
      Array.from({ length: busyCount }, (_, i) => `busy-${i}`),
    );

    // 2. The lone `meet-idle` write is not queued behind the `meet-busy`
    //    backlog. A global lock would make it strictly last (index 20), since
    //    it was enqueued after all 20 busy writes. Under a per-id lock it runs
    //    alongside busy-0 and needs one round of disk I/O, while busy-19 needs
    //    twenty sequential rounds — a ~20x margin, so this discriminates on
    //    ordering rather than on how fast the machine is.
    //    Measured: index 0-1 in practice, against 20 for a global lock.
    expect(completed.indexOf('idle')).toBeLessThan(5);

    // Both captures still hold exactly their own pages.
    expect((await store.getCapture('meet-busy'))?.pages).toHaveLength(busyCount);
    expect((await store.getCapture('meet-idle'))?.pages).toHaveLength(1);
  });

  it('a rejected write does not block the writes queued behind it', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'l'));
    await store.upsertCapture(blankMeetCapture('meet-reject', 'reject'));

    const doomed = store.putPage('meet-never-opened', undefined, pageRefFor('https://www.swimcloud.com/results/x/1/'));
    const ok = store.putPage('meet-reject', undefined, pageRefFor('https://www.swimcloud.com/results/reject/1/'));
    // Same-id follow-up, so it queues behind a sibling rather than starting clean.
    const alsoOk = store.putPage('meet-reject', undefined, pageRefFor('https://www.swimcloud.com/results/reject/2/'));

    await expect(doomed).rejects.toThrow(/no capture/i);
    await expect(Promise.all([ok, alsoOk])).resolves.toBeDefined();
    expect((await store.getCapture('meet-reject'))?.pages).toHaveLength(2);
  });

  it('rebuildIndex writes index.json summarizing every capture on disk', async () => {
    const dir = join(root, 'h');
    const store = new FileSystemSwimCloudCaptureStore(dir);
    await store.upsertCapture(blankMeetCapture('meet-4', '4'));
    await store.upsertCapture(blankMeetCapture('meet-5', '5'));

    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(join(dir, 'index.json'), 'utf8');
    const index = JSON.parse(raw) as Array<{ captureId: string }>;
    expect(index.map((entry) => entry.captureId).sort()).toStrictEqual(['meet-4', 'meet-5']);
  });
});

describe('FileSystemSwimCloudCaptureStore: a saved page is not erased by a later failure', () => {
  const swimmerUrl = 'https://www.swimcloud.com/api/swimmers/123/profile_fastest_times/';
  const ref = (outcome: 'ok' | 'http-error' | 'forbidden', httpStatus?: number): SwimCloudCapturePageRef => ({
    canonicalUrl: swimmerUrl,
    resourceKind: 'swimmerFastestTimes',
    retrievedAt: '2026-10-03T00:00:00.000Z',
    cacheStatus: 'final',
    outcome,
    ...(outcome === 'ok' ? { sha256: 'a'.repeat(64) } : { error: `HTTP ${httpStatus ?? 0}` }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

  it('keeps an ok entry when a later non-ok entry arrives for the same URL', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'merge-1'));
    await store.upsertCapture(blankMeetCapture('meet-m1', 'm1'));
    await store.putPage(
      'meet-m1',
      { canonicalUrl: swimmerUrl, html: '{"x":1}', status: 'final', retrievedAt: '2026-10-03T00:00:00.000Z', track: 'browser-extension' },
      ref('ok', 200),
    );
    await store.putPage('meet-m1', undefined, ref('http-error', 500));
    await store.putPage('meet-m1', undefined, ref('forbidden', 403));
    const capture = await store.getCapture('meet-m1');
    expect(capture?.pages).toHaveLength(1);
    expect(capture?.pages[0].outcome).toBe('ok');
    expect(capture?.pages[0].sha256).toBe('a'.repeat(64));
    expect((await store.readPage(swimmerUrl))?.html).toBe('{"x":1}');
  });

  it('still records an error status for a URL that was never ok', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'merge-2'));
    await store.upsertCapture(blankMeetCapture('meet-m2', 'm2'));
    await store.putPage('meet-m2', undefined, ref('http-error', 404));
    const capture = await store.getCapture('meet-m2');
    expect(capture?.pages).toHaveLength(1);
    expect(capture?.pages[0]).toMatchObject({ outcome: 'http-error', httpStatus: 404 });
  });

  it('an error entry is replaced by a later ok entry, and a later error replaces an earlier error', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'merge-3'));
    await store.upsertCapture(blankMeetCapture('meet-m3', 'm3'));
    await store.putPage('meet-m3', undefined, ref('http-error', 500));
    await store.putPage('meet-m3', undefined, ref('forbidden', 403));
    expect((await store.getCapture('meet-m3'))?.pages[0].outcome).toBe('forbidden');
    await store.putPage('meet-m3', undefined, ref('ok', 200));
    expect((await store.getCapture('meet-m3'))?.pages[0].outcome).toBe('ok');
  });

  it('upsertCapture follows the same rule', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'merge-4'));
    const first = { ...blankMeetCapture('meet-m4', 'm4'), pages: [ref('ok', 200)] };
    await store.upsertCapture(first);
    await store.upsertCapture({ ...blankMeetCapture('meet-m4', 'm4'), pages: [ref('http-error', 429)] });
    expect((await store.getCapture('meet-m4'))?.pages[0].outcome).toBe('ok');
  });
});

describe('FileSystemSwimCloudCaptureStore: deleting one capture keeps a page another still lists', () => {
  const shared = 'https://www.swimcloud.com/api/swimmers/123/profile_fastest_times/';
  const own = 'https://www.swimcloud.com/team/412/roster/?page=1&gender=M&season_id=29&sort=name';
  const pageRef = (canonicalUrl: string): SwimCloudCapturePageRef => ({
    canonicalUrl,
    resourceKind: canonicalUrl.includes('/api/') ? 'swimmerFastestTimes' : 'teamRoster',
    retrievedAt: '2026-10-03T00:00:00.000Z',
    cacheStatus: 'final',
    outcome: 'ok',
  });
  const entry = (canonicalUrl: string, html: string) => ({
    canonicalUrl,
    html,
    status: 'final' as const,
    retrievedAt: '2026-10-03T00:00:00.000Z',
    track: 'browser-extension' as const,
  });
  const teamCapture = (captureId: string, teamId: string): SwimCloudCaptureRecord => ({
    ...blankMeetCapture(captureId, '0'),
    subject: { kind: 'team', teamId, season: '2025-2026' },
  });

  it('skips the bytes of a page another capture lists, and deletes them with the last reference', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'share-1'));
    await store.upsertCapture(teamCapture('team-412-2025-2026', '412'));
    await store.upsertCapture(teamCapture('team-10002824-2025-2026', '10002824'));
    await store.putPage('team-412-2025-2026', entry(shared, '{"x":1}'), pageRef(shared));
    await store.putPage('team-10002824-2025-2026', entry(shared, '{"x":1}'), pageRef(shared));
    await store.putPage('team-412-2025-2026', entry(own, '<html>roster</html>'), pageRef(own));

    await store.deleteCapture('team-412-2025-2026', { withPages: true });
    // The shared page is still listed by the other capture, so its bytes stay. The roster page was only ours.
    expect((await store.readPage(shared))?.html).toBe('{"x":1}');
    expect(await store.readPage(own)).toBeUndefined();
    expect((await store.getCapture('team-10002824-2025-2026'))?.pages.map((p) => p.canonicalUrl)).toEqual([shared]);

    await store.deleteCapture('team-10002824-2025-2026', { withPages: true });
    expect(await store.readPage(shared)).toBeUndefined();
  });

  it('delete without pages leaves every page', async () => {
    const store = new FileSystemSwimCloudCaptureStore(join(root, 'share-2'));
    await store.upsertCapture(teamCapture('team-412-2025-2026', '412'));
    await store.putPage('team-412-2025-2026', entry(own, '<html>roster</html>'), pageRef(own));
    await store.deleteCapture('team-412-2025-2026', { withPages: false });
    expect((await store.readPage(own))?.html).toBe('<html>roster</html>');
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrent writes to one URL, and form-token noise                          */
/* -------------------------------------------------------------------------- */

describe('FileSystemSwimCloudCaptureStore: two captures write one URL at once', () => {
  const url = (n: number) => `https://www.swimcloud.com/team/${n}/roster/?gender=M`;
  const refFor = (canonicalUrl: string): SwimCloudCapturePageRef => ({ canonicalUrl, resourceKind: 'teamRoster', retrievedAt: '2026-10-04T00:00:00.000Z', cacheStatus: 'final', outcome: 'ok' });
  const entryFor = (canonicalUrl: string, html: string) => ({ canonicalUrl, html, status: 'final' as const, retrievedAt: '2026-10-04T00:00:00.000Z', track: 'browser-extension' as const });

  it('keeps every version on disk, 50 times over', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    for (let round = 0; round < 50; round += 1) {
      const dir = join(root, `race-${round}`);
      const store = new FileSystemSwimCloudCaptureStore(dir);
      await store.upsertCapture({ ...blankMeetCapture('meet-9', '9'), subject: { kind: 'meet', meetId: '9' } });
      await store.upsertCapture({ ...blankMeetCapture('team-a', 'a'), subject: { kind: 'team', teamId: 'a' } });
      await store.upsertCapture({ ...blankMeetCapture('team-b', 'b'), subject: { kind: 'team', teamId: 'b' } });
      const target = url(round);
      await store.putPage('meet-9', entryFor(target, '<html>P earlier</html>'), refFor(target));
      await Promise.all([
        store.putPage('team-a', entryFor(target, '<html>NA from team a</html>'), refFor(target)),
        store.putPage('team-b', entryFor(target, '<html>NB from team b</html>'), refFor(target)),
      ]);
      const inCache = (await store.readPage(target))?.html as string;
      const archiveDir = join(dir, 'pages-superseded');
      const archived = existsSync(archiveDir) ? readdirSync(archiveDir).map(f => (JSON.parse(readFileSync(join(archiveDir, f), 'utf8')) as { html: string }).html) : [];
      const all = new Set([inCache, ...archived]);
      expect(all, `round ${round}: cache ${inCache}, archive ${JSON.stringify(archived)}`).toEqual(new Set(['<html>P earlier</html>', '<html>NA from team a</html>', '<html>NB from team b</html>']));
      expect(['<html>NA from team a</html>', '<html>NB from team b</html>']).toContain(inCache);
    }
    // 50 rounds of real disk work: a loaded full run can pass the 30 s default.
  }, 120_000);
});

describe('FileSystemSwimCloudCaptureStore: a recrawl that changes only the form token archives nothing', () => {
  const input = (token: string, extra = ''): string => `<form action="/logout/"><input type="hidden" name="csrfmiddlewaretoken" value="${token}"></form><table>${extra}</table>`;
  const inputValueFirst = (token: string): string => `<input value='${token}' type="hidden" name='csrfmiddlewaretoken'>`;

  it('swimCloudPageBytesDiffer ignores csrfmiddlewaretoken values and nothing else', () => {
    expect(swimCloudPageBytesDiffer(input('AAAA'), input('BBBB'))).toBe(false);
    expect(swimCloudPageBytesDiffer(input('AAAA'), input('AAAA'))).toBe(false);
    expect(swimCloudPageBytesDiffer(inputValueFirst('AAAA'), inputValueFirst('BBBB'))).toBe(false);
    expect(swimCloudPageBytesDiffer(input('AAAA', '<tr>1</tr>'), input('BBBB', '<tr>2</tr>'))).toBe(true);
    // A different value on some other input is content, not a token.
    expect(swimCloudPageBytesDiffer('<input name="season_id" value="29">', '<input name="season_id" value="30">')).toBe(true);
    expect(swimCloudPageBytesDiffer('', input('AAAA'))).toBe(true);
  });

  it('writes the new bytes but keeps no archive copy for a token-only change, and archives a real change', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const dir = join(root, 'token-noise');
    const store = new FileSystemSwimCloudCaptureStore(dir);
    await store.upsertCapture({ ...blankMeetCapture('team-t', 't'), subject: { kind: 'team', teamId: 't' } });
    const canonicalUrl = 'https://www.swimcloud.com/team/77/roster/?gender=F';
    const ref: SwimCloudCapturePageRef = { canonicalUrl, resourceKind: 'teamRoster', retrievedAt: '2026-10-04T00:00:00.000Z', cacheStatus: 'final', outcome: 'ok' };
    const entry = (html: string) => ({ canonicalUrl, html, status: 'final' as const, retrievedAt: '2026-10-04T00:00:00.000Z', track: 'browser-extension' as const });
    await store.putPage('team-t', entry(input('TOKEN-1', '<tr>same</tr>')), ref);
    await store.putPage('team-t', entry(input('TOKEN-2', '<tr>same</tr>')), ref);
    await store.putPage('team-t', entry(input('TOKEN-3', '<tr>same</tr>')), ref);
    expect(existsSync(join(dir, 'pages-superseded'))).toBe(false);
    // What is stored is unchanged: the newest bytes, token included.
    expect((await store.readPage(canonicalUrl))?.html).toBe(input('TOKEN-3', '<tr>same</tr>'));
    await store.putPage('team-t', entry(input('TOKEN-4', '<tr>different</tr>')), ref);
    expect(readdirSync(join(dir, 'pages-superseded'))).toHaveLength(1);
  });
});

describe('FileSystemSwimCloudCaptureStore: many captures write at once', () => {
  it('never lets an index rebuild read a half-written capture file', async () => {
    const { readFileSync } = await import('node:fs');
    const dir = join(root, 'many-at-once');
    const store = new FileSystemSwimCloudCaptureStore(dir);
    const ids = Array.from({ length: 24 }, (_, i) => `team-${i + 100}`);
    for (const id of ids) {
      await store.upsertCapture({ ...blankMeetCapture(id, '1'), subject: { kind: 'team', teamId: id.slice(5) } });
    }
    // Each putPage rewrites its own capture file and then rebuilds the index, which reads every
    // capture file. Without one lock over those reads and writes, a reader catches a file that
    // writeFile has truncated and not yet filled, and JSON.parse throws.
    for (let round = 0; round < 6; round += 1) {
      await Promise.all(
        ids.map((id, i) => {
          const url = `https://www.swimcloud.com/team/${id.slice(5)}/roster/?gender=M&round=${round}`;
          return store.putPage(
            id,
            { canonicalUrl: url, html: `<html>${id} round ${round} ${'x'.repeat(2000 + i)}</html>`, status: 'final', retrievedAt: '2026-10-04T00:00:00.000Z', track: 'browser-extension' },
            { canonicalUrl: url, resourceKind: 'teamRoster', retrievedAt: '2026-10-04T00:00:00.000Z', cacheStatus: 'final', outcome: 'ok' },
          );
        }),
      );
    }
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { captureId: string; pageCount: number }[];
    expect(index).toHaveLength(ids.length);
    for (const row of index) expect(row.pageCount, row.captureId).toBe(6);
  }, 120_000);
});
