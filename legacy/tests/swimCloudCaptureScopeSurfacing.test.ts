// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A narrowed capture must never read as an empty one — the UI half.
 *
 * `packages/swimcloud/src/captureStore.ts` documents the rule this file
 * enforces: there is deliberately no `'complete'` completeness value, because
 * `'every-planned-page-fetched'` is a claim about *the plan*, not about
 * SwimCloud. Since crawl scopes exist the plan itself can be narrow, so a
 * capture crawled as "Meet results only" reports every planned page fetched
 * while holding **zero** roster pages and **zero** swimmer-times pages. At the
 * completeness field alone it is indistinguishable from a full crawl.
 *
 * Shown as an empty roster list, that reads as "this meet has no rostered
 * swimmers" — `CLAUDE.md`'s "absent is not empty", which it names as the top
 * failure mode in this codebase. These tests pin the sentences that stop it,
 * including the third case nobody remembers: the real 234-page capture in
 * `data/swimcloud-captures/` records **no** scope at all, and must report that
 * rather than be assumed to have been a full crawl.
 *
 * Written without JSX (plain `React.createElement`) for the same reason
 * `swimCloudCapturePicker.test.ts` is — see that file's header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SwimCloudRosterParse, SwimCloudSwimmerTimesParse } from '@omniswim/swimcloud/parser';
import {
  SwimCloudCaptureBrowser,
  describeSwimCloudCaptureScope,
  describeSwimCloudUnplannedPass,
  swimCloudCapturePassStatus,
  type SwimCloudCaptureRecord,
  type SwimCloudCaptureParseResponse,
} from '@omniswim/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEET_RESULTS_SCOPE = {
  latestScopeId: 'meet-results',
  plannedPasses: ['meetTeamSwims', 'meetEvent'],
} as const;

const EVERYTHING_SCOPE = {
  latestScopeId: 'everything',
  plannedPasses: ['meetTeamSwims', 'meetEvent', 'teamRoster', 'swimmerTimes'],
} as const;

function captureRecord(overrides: Partial<SwimCloudCaptureRecord> = {}): SwimCloudCaptureRecord {
  return {
    captureId: 'meet-356467',
    subject: { kind: 'meet', meetId: '356467' },
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-20T01:00:00Z',
    // The value that makes this dangerous: a narrowed crawl really does fetch
    // every page it planned.
    completeness: 'every-planned-page-fetched',
    plannedPageCount: 42,
    pages: Array.from({ length: 42 }, (_, i) => ({ canonicalUrl: `https://x/${i}` })),
    notes: [],
    teamDiscovery: {
      source: 'topteams',
      genders: ['Men', 'Women'],
      teamIds: ['58'],
      completeness: 'user-confirmed',
    },
    ...overrides,
  };
}

/* ========================================================================== */
/* The pure sentences                                                         */
/* ========================================================================== */

describe('swimCloudCapturePassStatus', () => {
  it('is three-valued, and an unrecorded scope is its own answer', () => {
    const narrowed = captureRecord({ crawlScope: MEET_RESULTS_SCOPE });
    expect(swimCloudCapturePassStatus(narrowed, 'meetTeamSwims')).toBe('planned');
    expect(swimCloudCapturePassStatus(narrowed, 'teamRoster')).toBe('not-planned');
    // The real capture on disk. Never 'not-planned', never 'planned'.
    expect(swimCloudCapturePassStatus(captureRecord(), 'teamRoster')).toBe('not-recorded');
    expect(swimCloudCapturePassStatus(null, 'teamRoster')).toBe('not-recorded');
  });
});

describe('describeSwimCloudCaptureScope', () => {
  it('names the scope and the passes it never planned', () => {
    const line = describeSwimCloudCaptureScope(captureRecord({ crawlScope: MEET_RESULTS_SCOPE }));
    expect(line).toContain('Meet results only');
    expect(line).toContain('never planned');
    expect(line).toContain('team rosters');
    // The sentence a coach needs: absent by plan, not missing from the meet.
    expect(line).toContain('absent by plan');
  });

  it('says a full crawl planned every pass', () => {
    const line = describeSwimCloudCaptureScope(captureRecord({ crawlScope: EVERYTHING_SCOPE }));
    expect(line).toContain('every pass was planned');
    expect(line).not.toContain('never planned');
  });

  it('says "not recorded" for a capture stored before scopes existed', () => {
    const line = describeSwimCloudCaptureScope(captureRecord());
    expect(line).toContain('Crawl scope not recorded');
    // It must not read as either extreme.
    expect(line).not.toContain('every pass was planned');
    expect(line.length).toBeGreaterThan(0);
  });

  it('never returns an empty string — a blank row would read as "all fetched"', () => {
    for (const crawlScope of [undefined, MEET_RESULTS_SCOPE, EVERYTHING_SCOPE]) {
      expect(describeSwimCloudCaptureScope(captureRecord({ crawlScope })).length).toBeGreaterThan(0);
    }
  });

  it('reports a scope id this build does not know without pretending to read it', () => {
    const line = describeSwimCloudCaptureScope(
      captureRecord({
        crawlScope: { latestScopeId: 'future-scope', plannedPasses: ['teamRoster'] } as never,
      }),
    );
    expect(line).toContain('unrecognised scope');
    expect(line).toContain('never planned');
  });
});

describe('describeSwimCloudUnplannedPass', () => {
  it('stays null when the pass was planned, so the caller\'s own text wins', () => {
    // A capture that planned rosters and holds none genuinely holds none. This
    // helper must not overwrite that honest sentence with a scope excuse.
    expect(describeSwimCloudUnplannedPass(captureRecord({ crawlScope: EVERYTHING_SCOPE }), 'teamRoster')).toBeNull();
  });

  it('explains a declined pass, and says re-crawling fixes it', () => {
    const text = describeSwimCloudUnplannedPass(captureRecord({ crawlScope: MEET_RESULTS_SCOPE }), 'teamRoster');
    expect(text).not.toBeNull();
    expect(text).toContain('Meet results only');
    expect(text).toContain('none are missing');
    expect(text).toContain('wider scope');
  });

  it('refuses to guess for a capture that records no scope', () => {
    const text = describeSwimCloudUnplannedPass(captureRecord(), 'swimmerTimes');
    expect(text).not.toBeNull();
    expect(text).toContain('does not record which passes');
    // Neither "they were never requested" nor "none exist" is asserted.
    expect(text).toContain('could mean');
  });

  it('is null for no capture at all — nothing is known, and nothing is claimed', () => {
    expect(describeSwimCloudUnplannedPass(null, 'teamRoster')).toBeNull();
    expect(describeSwimCloudUnplannedPass(undefined, 'teamRoster')).toBeNull();
  });
});

/* ========================================================================== */
/* The rendered browser                                                       */
/* ========================================================================== */

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function emptyParse(captureId: string, subject: SwimCloudCaptureRecord['subject']): SwimCloudCaptureParseResponse {
  return {
    captureId,
    subject,
    parses: [],
    rosters: [],
    swimmerTimes: [],
    eventResults: [],
    warnings: [],
  };
}

describe('SwimCloudCaptureBrowser — a narrowed capture never reads as empty', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(
    capture: SwimCloudCaptureRecord,
    parse: SwimCloudCaptureParseResponse,
    mode: 'meet-results' | 'roster-history',
  ): Promise<void> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/swimcloud/pairing-token' && method === 'GET') {
        return jsonResponse(200, { token: 'test-pairing-token' });
      }
      if (url === '/api/swimcloud/captures' && method === 'GET') return jsonResponse(200, [capture]);
      if (url === `/api/swimcloud/captures/${capture.captureId}/parse` && method === 'POST') {
        return jsonResponse(200, parse);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        mode === 'meet-results'
          ? createElement(SwimCloudCaptureBrowser, {
              mode: 'meet-results',
              onClose: vi.fn(),
              onImportMeetResults: vi.fn(),
            })
          : createElement(SwimCloudCaptureBrowser, {
              mode: 'roster-history',
              team: 'Henderson State',
              genderLabel: 'Men',
              rosterCoverage: (roster: SwimCloudRosterParse, times: readonly SwimCloudSwimmerTimesParse[]) => ({
                rosterAthleteCount: roster.athletes.length,
                withCapturedTimes: times.length,
                withoutCapturedTimes: Math.max(0, roster.athletes.length - times.length),
              }),
              onClose: vi.fn(),
              onImportRoster: vi.fn(),
            }),
      );
    });
    await flush();

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="SwimCloud capture"]');
    if (select === null) throw new Error('capture select not rendered');
    const setValue = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set;
    if (setValue === undefined) throw new Error('no native value setter for select');
    await act(async () => {
      setValue.call(select, capture.captureId);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
  }

  it('states the crawl scope beside the completeness sentence', async () => {
    const capture = captureRecord({ crawlScope: MEET_RESULTS_SCOPE });
    await mount(capture, emptyParse(capture.captureId, capture.subject), 'meet-results');
    const text = container.textContent ?? '';
    // Completeness still says every planned page was fetched — that is true.
    expect(text).toContain('42 of 42 planned pages fetched');
    // And the scope line is what stops that from reading as a full crawl.
    expect(text).toContain('Crawled as “Meet results only”');
    expect(text).toContain('never planned');
  });

  it('tells a coach the roster list is empty by plan, not by absence of swimmers', async () => {
    const capture = captureRecord({ crawlScope: MEET_RESULTS_SCOPE });
    await mount(capture, emptyParse(capture.captureId, capture.subject), 'roster-history');
    const text = container.textContent ?? '';
    // The observed fact still leads — it is true under every scope.
    expect(text).toContain('This capture holds no team-roster page');
    // What it is evidence of is what changes.
    expect(text).toContain('which never plans team rosters');
    expect(text).toContain('none are missing');
    // And the "keep working the clipboard" hint, which is the answer to a real
    // empty, is not the advice given for a pass that was never requested.
    expect(text).not.toContain('The clipboard path still works for one swimmer at a time.');
  });

  it('renders a swimmer-times section purely to say the scope never planned it', async () => {
    // Before this, an empty swimmer-times list rendered no section at all, and
    // a missing section reads as "there was nothing of this kind here".
    const capture = captureRecord({ crawlScope: MEET_RESULTS_SCOPE });
    await mount(capture, emptyParse(capture.captureId, capture.subject), 'roster-history');
    const text = container.textContent ?? '';
    expect(text).toContain('Swimmer times in this capture (0 swimmers)');
    // Changed 2026-09-22. From 2026-09-20 no scope could fetch this pass, and
    // the section said so. The pass now fetches the times JSON, so a wider
    // re-crawl does add them, and that is the advice the section gives.
    const swimmerTimesSection = text.slice(text.indexOf('Swimmer times in this capture'));
    expect(swimmerTimesSection).toContain('re-crawl this meet with a wider scope to add them.');
    expect(text).not.toContain('No crawl fetches swimmers’ personal-best pages');
  });

  it('says "not recorded" for the real capture shape on disk today', async () => {
    const capture = captureRecord();
    await mount(capture, emptyParse(capture.captureId, capture.subject), 'roster-history');
    const text = container.textContent ?? '';
    expect(text).toContain('Crawl scope not recorded');
    expect(text).toContain('does not record which passes its crawl planned');
    expect(text).not.toContain('Crawled as');
    // An uncertainty does not conjure a section that would otherwise not
    // render — the status line above already carries it.
    expect(text).not.toContain('Swimmer times in this capture');
  });

  it('leaves a full crawl\'s honest empty sentences exactly as they were', async () => {
    const capture = captureRecord({ crawlScope: EVERYTHING_SCOPE });
    await mount(capture, emptyParse(capture.captureId, capture.subject), 'roster-history');
    const text = container.textContent ?? '';
    // Rosters were planned and none came back: that is a real empty, and the
    // original sentence is the right one.
    expect(text).toContain('This capture holds no team-roster page, so there is no roster to import.');
    expect(text).not.toContain('never plans team rosters');
    // A planned-but-empty swimmer-times list still renders no section.
    expect(text).not.toContain('Swimmer times in this capture');
    expect(text).toContain('every pass was planned');
  });

  it('explains the meet-results section too, when that is the declined pass', async () => {
    const capture = captureRecord({
      crawlScope: { latestScopeId: 'roster-and-season-bests', plannedPasses: ['teamRoster', 'swimmerTimes'] },
    });
    await mount(capture, emptyParse(capture.captureId, capture.subject), 'meet-results');
    const text = container.textContent ?? '';
    expect(text).toContain('Nothing parseable in this capture yet.');
    expect(text).toContain('which never plans this meet’s team results');
  });
});
