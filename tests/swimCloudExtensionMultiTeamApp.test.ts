/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `extensions/swimcloud-companion/src/multiTeamApp.ts`: how the multi-team crawl
 * reads the background worker's answers. A fake worker models the real one: it
 * answers `relayed: true, via: 'downloads'` for a page the app refused.
 */
import { describe, expect, it } from 'vitest';

import type { BackgroundRoundTrip } from '../extensions/swimcloud-companion/src/backgroundRoundTrip';
import { RELAY_FAILURE_STOP_THRESHOLD } from '../extensions/swimcloud-companion/src/backgroundRoundTrip';
import { createMultiTeamApp, type SendToWorker } from '../extensions/swimcloud-companion/src/multiTeamApp';

const SUBJECT = { kind: 'team', teamId: '412', season: '2025-2026' } as const;
const REQUEST = { subject: SUBJECT, sourceUrl: 'https://www.swimcloud.com/api/swimmers/1/profile_fastest_times/', httpStatus: 200, html: '{}' };

function worker(answer: (message: Readonly<Record<string, unknown>>) => BackgroundRoundTrip<unknown>): { send: SendToWorker; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send: async (message) => {
      sent.push({ ...message });
      return answer(message);
    },
  };
}

const ok = (value: unknown): BackgroundRoundTrip<unknown> => ({ kind: 'ok', value });

describe('relay', () => {
  it('is landed only on the HTTP path', async () => {
    const w = worker(() => ok({ relayed: true, via: 'http' }));
    const app = createMultiTeamApp(w.send, () => '2026-10-03T00:00:00.000Z');
    expect(await app.relay(REQUEST)).toBe('landed');
    expect(w.sent[0]).toMatchObject({
      type: 'omniswim-swimcloud-relay-page',
      subject: SUBJECT,
      sourceUrl: REQUEST.sourceUrl,
      httpStatus: 200,
      retrievedAt: '2026-10-03T00:00:00.000Z',
    });
  });

  it('a downloads fallback is a fallback, not landed', async () => {
    const app = createMultiTeamApp(worker(() => ok({ relayed: true, via: 'downloads' })).send);
    expect(await app.relay(REQUEST)).toBe('fallback');
  });

  it('an unnamed path is not landed', async () => {
    const app = createMultiTeamApp(worker(() => ok({ relayed: true })).send);
    expect(await app.relay(REQUEST)).toBe('fallback');
  });

  it('a refused or failed round trip is lost', async () => {
    expect(await createMultiTeamApp(worker(() => ok({ relayed: false, via: 'downloads' })).send).relay(REQUEST)).toBe('lost');
    expect(await createMultiTeamApp(worker(() => ({ kind: 'timeout', timeoutMs: 30000 })).send).relay(REQUEST)).toBe('lost');
    expect(await createMultiTeamApp(worker(() => ({ kind: 'error', message: 'x' })).send).relay(REQUEST)).toBe('lost');
  });

  it('stops after a streak of fallbacks, and a landed page resets the streak', async () => {
    let via: 'http' | 'downloads' = 'downloads';
    const app = createMultiTeamApp(worker(() => ok({ relayed: true, via })).send);
    const outcomes: string[] = [];
    for (let i = 0; i < RELAY_FAILURE_STOP_THRESHOLD; i += 1) outcomes.push(await app.relay(REQUEST));
    expect(outcomes).toEqual(['fallback', 'fallback', 'streak-stop']);
    via = 'http';
    expect(await app.relay(REQUEST)).toBe('landed');
    via = 'downloads';
    expect(await app.relay(REQUEST)).toBe('fallback'); // the streak started over
  });

  it('reset clears the streak at the start of a run', async () => {
    const app = createMultiTeamApp(worker(() => ok({ relayed: false })).send);
    await app.relay(REQUEST);
    await app.relay(REQUEST);
    app.reset();
    expect(await app.relay(REQUEST)).toBe('lost');
    expect(await app.relay(REQUEST)).toBe('lost');
    expect(await app.relay(REQUEST)).toBe('streak-stop');
  });
});

describe('openCapture', () => {
  it('sends the subject and page count and returns the id', async () => {
    const w = worker(() => ok({ captureId: 'team-412-2025-2026' }));
    const id = await createMultiTeamApp(w.send).openCapture(SUBJECT, 64);
    expect(id).toBe('team-412-2025-2026');
    expect(w.sent[0]).toEqual({ type: 'omniswim-swimcloud-open-capture', subject: SUBJECT, plannedPageCount: 64 });
  });

  it('returns nothing when the app gave no id, or the worker did not answer', async () => {
    expect(await createMultiTeamApp(worker(() => ok({ captureId: undefined })).send).openCapture(SUBJECT, 1)).toBeUndefined();
    expect(await createMultiTeamApp(worker(() => ok({ captureId: '' })).send).openCapture(SUBJECT, 1)).toBeUndefined();
    expect(await createMultiTeamApp(worker(() => ({ kind: 'timeout', timeoutMs: 1 })).send).openCapture(SUBJECT, 1)).toBeUndefined();
  });
});

describe('markCapture and flushDownloads', () => {
  it('marks through the worker', async () => {
    const w = worker(() => ok({ captureId: 'x' }));
    await createMultiTeamApp(w.send).markCapture(SUBJECT, 'partial');
    expect(w.sent[0]).toEqual({ type: 'omniswim-swimcloud-mark-capture', subject: SUBJECT, completeness: 'partial' });
  });

  it('sends the school name as the label, and only when there is one', async () => {
    const w = worker(() => ok({ captureId: 'x' }));
    const app = createMultiTeamApp(w.send);
    await app.markCapture(SUBJECT, 'every-planned-page-fetched', 'Henderson State University');
    await app.markCapture(SUBJECT, 'partial');
    expect(w.sent[0]).toEqual({ type: 'omniswim-swimcloud-mark-capture', subject: SUBJECT, completeness: 'every-planned-page-fetched', label: 'Henderson State University' });
    expect('label' in w.sent[1]).toBe(false);
  });

  it('flushes each subject and reports counts, filenames and failures', async () => {
    const other = { kind: 'team', teamId: '58' } as const;
    const w = worker((m) =>
      (m.subject as { teamId: string }).teamId === '412'
        ? ok({ flushed: true, pageCount: 3, filename: 'omniswim-swimcloud-captures/team-412/combined-capture.json' })
        : { kind: 'timeout', timeoutMs: 10000 },
    );
    const results = await createMultiTeamApp(w.send).flushDownloads([SUBJECT, other]);
    expect(w.sent.map((m) => m.type)).toEqual(['omniswim-swimcloud-flush-downloads', 'omniswim-swimcloud-flush-downloads']);
    expect(results[0]).toEqual({ subject: SUBJECT, pageCount: 3, filename: 'omniswim-swimcloud-captures/team-412/combined-capture.json' });
    expect(results[1].subject).toEqual(other);
    expect(results[1].pageCount).toBe(0);
    expect(results[1].error).toBeDefined();
  });
});
