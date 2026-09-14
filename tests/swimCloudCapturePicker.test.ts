// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the shared `SwimCloudCaptureBrowser` (`packages/ui/src/components/SwimCloudCaptureBrowser.tsx`),
 * used here in `mode="meet-results"` — the mode Matrix's `OpsModule.tsx` opens.
 * This file replaces the tests for the deleted, Matrix-only
 * `SwimCloudCapturePicker.tsx`, which this shared component supersedes (see
 * `plans/2026-09-09/01-UI-REDESIGN-PLAN.md` §3 and
 * `plans/2026-09-10/02-UI-REDESIGN-WHOLE-APP.md` §0 for why one component now
 * serves both Matrix and Manager).
 *
 * The browser only browses. Unlike the deleted picker, it never calls
 * `applySwimCloudRows`/`onUpdate` itself — it hands the checked team/gender
 * selection to `onImportMeetResults` and lets the caller (`OpsModule.tsx`'s
 * `handleSwimCloudBrowserImport`) decide what happens to the workspace. So
 * these tests assert what the browser itself is responsible for: listing,
 * selecting-and-parsing (a `<select>`'s own `onChange`, no separate "Select"
 * step), the checkbox filter, and progressive disclosure of rosters/swimmer
 * times/meet results — not the apply-to-workspace pipeline, which is
 * `packages/matrix/src/lib/swimCloudMeetImportBridge.ts`'s own, separately
 * tested territory.
 *
 * `fetch` is mocked throughout — this file never talks to a live server,
 * including `GET /api/swimcloud/pairing-token`. Every mock below answers it
 * before answering any capture route.
 *
 * Written without JSX (plain `React.createElement` calls) so this file can
 * stay a `.test.ts` under this repo's existing `tests/**\/*.test.ts` vitest
 * include glob rather than requiring a new `.tsx` test convention or a
 * React Testing Library dependency, neither of which exist in this repo yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SwimCloudTeamMeetSwimsParse,
  SwimCloudTeamMeetSwim,
  SwimCloudRosterParse,
  SwimCloudSwimmerTimesParse,
  SwimCloudAthlete,
  SwimCloudPersonalBestSwim,
} from '@omniswim/swimcloud/parser';
import {
  SwimCloudCaptureBrowser,
  describeSwimCloudCaptureCompleteness,
  type SwimCloudCaptureRecord,
  type SwimCloudCaptureParseResponse,
  type SwimCloudCaptureMeetResultsSelection,
} from '@omniswim/ui';

// React 18/19 warn on `act(...)` unless the environment declares itself.
// This test file is the environment declaring itself.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ========================================================================== */
/* describeSwimCloudCaptureCompleteness — honest completeness text, never bare "Complete" */
/* ========================================================================== */

function baseCapture(overrides: Partial<SwimCloudCaptureRecord> = {}): SwimCloudCaptureRecord {
  return {
    captureId: 'meet-356467',
    subject: { kind: 'meet', meetId: '356467' },
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T01:00:00Z',
    completeness: 'every-planned-page-fetched',
    plannedPageCount: 64,
    pages: Array.from({ length: 64 }, (_, i) => ({ canonicalUrl: `https://x/${i}` })),
    notes: [],
    teamDiscovery: { source: 'topteams', genders: ['Men', 'Women'], teamIds: ['58'], completeness: 'unproven' },
    ...overrides,
  };
}

describe('describeSwimCloudCaptureCompleteness', () => {
  it('never renders the bare word "Complete" for every-planned-page-fetched, per the design spec', () => {
    const text = describeSwimCloudCaptureCompleteness(baseCapture());
    expect(text).not.toContain('Complete');
    expect(text).toContain('64 of 64 planned page');
    expect(text).toContain('team list unverified');
  });

  it('folds a verified team-discovery completeness into the sentence honestly', () => {
    const text = describeSwimCloudCaptureCompleteness(
      baseCapture({
        teamDiscovery: { source: 'topteams', genders: ['Men', 'Women'], teamIds: ['58'], completeness: 'verified-complete-for-this-capture' },
      })
    );
    expect(text).toContain('team list verified complete for this capture');
  });

  it('reports missing pages and missing team/gender combos for a partial capture', () => {
    const text = describeSwimCloudCaptureCompleteness(
      baseCapture({
        completeness: 'partial',
        plannedPageCount: 10,
        pages: [{ canonicalUrl: 'https://x/1', teamId: '58', gender: 'Men' }],
        teamDiscovery: { source: 'topteams', genders: ['Men', 'Women'], teamIds: ['58'], completeness: 'unproven' },
      })
    );
    expect(text).toContain('1 of 10 planned page');
    expect(text).toContain('9 planned pages not yet fetched');
    expect(text).toContain('58 (Women)');
    expect(text).not.toContain('Complete');
  });

  it('reports a failed capture plainly', () => {
    expect(describeSwimCloudCaptureCompleteness(baseCapture({ completeness: 'failed' }))).toBe(
      'Capture failed — see notes below.'
    );
  });
});

/* ========================================================================== */
/* Fixtures for the parse response                                            */
/* ========================================================================== */

let nextId = 0;
function fakeSwim(opts: { athleteName: string; teamName: string; gender: 'Men' | 'Women' }): SwimCloudTeamMeetSwim {
  const id = ++nextId;
  const event = {
    eventId: `evt-${id}`,
    swimCloudMeetId: '356467',
    label: '100 Y Free',
    kind: 'individual' as const,
    course: 'SCY' as const,
    gender: opts.gender,
    distance: 100,
    stroke: 'Freestyle' as const,
  };
  return {
    swimKey: `356467:swim:${id}`,
    event,
    entry: { entryId: `entry-${id}`, eventId: event.eventId, athleteName: opts.athleteName, teamName: opts.teamName },
    result: { resultId: `res-${id}`, entryId: `entry-${id}`, eventId: event.eventId, place: 1, finalTime: '50.00' },
    relayLeadoff: false,
    cutStandards: [],
  };
}

function fakeParse(opts: { teamName: string; gender: 'Men' | 'Women'; swims: SwimCloudTeamMeetSwim[] }): SwimCloudTeamMeetSwimsParse {
  return {
    swimCloudMeetId: '356467',
    meetName: 'Test Championships',
    meet: { swimCloudMeetId: '356467', name: 'Test Championships', format: 'unknown', ruleset: 'unknown', course: 'unknown' },
    teamName: opts.teamName,
    gender: opts.gender,
    swims: opts.swims,
    events: [],
    rowCount: opts.swims.length,
  };
}

function fakeAthlete(opts: { name: string; hometown?: string; classYear?: SwimCloudAthlete['classYear']; swimCloudSwimmerId?: string }): SwimCloudAthlete {
  return {
    swimCloudSwimmerId: opts.swimCloudSwimmerId,
    name: opts.name,
    hometown: opts.hometown,
    classYear: opts.classYear,
  };
}

function fakeRoster(opts: { teamName: string; gender: 'Men' | 'Women'; season: string; athletes: SwimCloudAthlete[] }): SwimCloudRosterParse {
  return {
    swimCloudTeamId: '58',
    teamName: opts.teamName,
    gender: opts.gender,
    season: opts.season,
    athletes: opts.athletes,
    rowCount: opts.athletes.length,
  };
}

function fakePersonalBest(opts: { eventLabel: string; time?: string; meetName?: string; date?: string }): SwimCloudPersonalBestSwim {
  return {
    swimKey: `pb:${opts.eventLabel}`,
    eventId: `evt:${opts.eventLabel}`,
    eventLabel: opts.eventLabel,
    time: opts.time,
    meetName: opts.meetName,
    date: opts.date,
    tags: [],
    relayLeadoff: false,
  };
}

function fakeSwimmerTimes(opts: { swimCloudSwimmerId: string; name?: string; personalBests: SwimCloudPersonalBestSwim[] }): SwimCloudSwimmerTimesParse {
  return {
    swimCloudSwimmerId: opts.swimCloudSwimmerId,
    swimmerIdSource: 'capture-url',
    name: opts.name,
    personalBests: opts.personalBests,
    rowCount: opts.personalBests.length,
  };
}

/* ========================================================================== */
/* Component behavior against a mocked fetch                                  */
/* ========================================================================== */

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('SwimCloudCaptureBrowser (mode="meet-results")', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    nextId = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Picks a capture from the `<select>` — parsing fires on `onChange`, no separate "Select" step. */
  async function selectCapture(captureId: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="SwimCloud capture"]');
    if (select === null) throw new Error('capture select not rendered');
    const setValue = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set;
    if (setValue === undefined) throw new Error('no native value setter for select');
    await act(async () => {
      setValue.call(select, captureId);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
  }

  it('lists captures from GET, parses on selection, applies the checkbox filter, and hands back only what is checked', async () => {
    const capture = baseCapture({ label: 'HSU @ Test Championships' });

    const teamAMen = fakeParse({
      teamName: 'Team A',
      gender: 'Men',
      swims: [
        fakeSwim({ athleteName: 'Alice Swimmer', teamName: 'Team A', gender: 'Men' }),
        fakeSwim({ athleteName: 'Bob Swimmer', teamName: 'Team A', gender: 'Men' }),
      ],
    });
    const teamBWomen = fakeParse({
      teamName: 'Team B',
      gender: 'Women',
      swims: [fakeSwim({ athleteName: 'Cara Swimmer', teamName: 'Team B', gender: 'Women' })],
    });

    const parseResponse: SwimCloudCaptureParseResponse = {
      captureId: capture.captureId,
      subject: capture.subject,
      parses: [teamAMen, teamBWomen],
      rosters: [],
      swimmerTimes: [],
      eventResults: [],
      warnings: [],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/swimcloud/pairing-token' && method === 'GET') {
        return jsonResponse(200, { token: 'test-pairing-token' });
      }
      if (url === '/api/swimcloud/captures' && method === 'GET') {
        expect((init?.headers as Record<string, string> | undefined)?.['X-Omniswim-Capture-Token']).toBe(
          'test-pairing-token'
        );
        return jsonResponse(200, [capture]);
      }
      if (url === `/api/swimcloud/captures/${capture.captureId}/parse` && method === 'POST') {
        expect((init?.headers as Record<string, string> | undefined)?.['X-Omniswim-Capture-Token']).toBe(
          'test-pairing-token'
        );
        return jsonResponse(200, parseResponse);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onClose = vi.fn();
    const onImportMeetResults = vi.fn();

    await act(async () => {
      root.render(
        createElement(SwimCloudCaptureBrowser, {
          mode: 'meet-results',
          onClose,
          onImportMeetResults,
        })
      );
    });
    await flush();

    // The list rendered from GET, with the honest completeness phrase folded
    // into the option text (never the bare word "Complete").
    expect(container.textContent).toContain('HSU @ Test Championships');
    const optionText = [...container.querySelectorAll('option')].map(o => o.textContent).join(' | ');
    expect(optionText).toContain('64 of 64 planned page');
    expect(optionText).not.toContain('Complete');

    // Select the capture -> POST /parse, no separate "Select" step.
    await selectCapture(capture.captureId);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/swimcloud/captures/${capture.captureId}/parse`,
      expect.objectContaining({ method: 'POST' })
    );

    // Two team/gender groups, both checked by default.
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every(c => c.checked)).toBe(true);
    expect(container.textContent).toContain('Team A · Men');
    expect(container.textContent).toContain('Team B · Women');

    // Uncheck Team B · Women.
    const teamBCheckbox = checkboxes.find(c => {
      const label = container.querySelector<HTMLLabelElement>(`label[for="${c.id}"]`);
      return label?.textContent === 'Team B · Women';
    });
    expect(teamBCheckbox).toBeTruthy();
    await act(async () => {
      teamBCheckbox!.click();
    });
    expect(teamBCheckbox!.checked).toBe(false);

    // Import selected -> only Team A's parse reaches onImportMeetResults; the
    // browser never touches a workspace itself.
    const importButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'Import selected');
    expect(importButton).toBeTruthy();
    await act(async () => {
      importButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(onImportMeetResults).toHaveBeenCalledTimes(1);
    const selection = onImportMeetResults.mock.calls[0][0] as SwimCloudCaptureMeetResultsSelection;
    expect(selection.parses).toStrictEqual([teamAMen]);
    expect(selection.pageCount).toBe(1);
    expect(selection.groups.map(g => g.label)).toStrictEqual(['Team A · Men']);
    // The browser does not close itself on import — the consumer decides
    // that after applying the selection (see `handleSwimCloudBrowserImport`).
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders rosters and swimmer-times sections with counts, and their detail once expanded, even in meet-results mode', async () => {
    const capture = baseCapture({ label: 'HSU @ Test Championships' });

    const roster = fakeRoster({
      teamName: 'Team A',
      gender: 'Men',
      season: '2025-2026',
      athletes: [
        fakeAthlete({ name: 'Alice Swimmer', hometown: 'Norco, LA', classYear: 'senior', swimCloudSwimmerId: 'sw-1' }),
        fakeAthlete({ name: 'Bob Swimmer' }),
      ],
    });
    const swimmerTimes = fakeSwimmerTimes({
      swimCloudSwimmerId: 'sw-1',
      name: 'Swimmer, Alice',
      personalBests: [
        fakePersonalBest({ eventLabel: '100 Free SCY', time: '50.00', meetName: 'Test Championships', date: 'Mar 1, 2025' }),
        fakePersonalBest({ eventLabel: '200 IM SCY', time: '1:55.00', meetName: 'Test Championships', date: 'Mar 2, 2025' }),
      ],
    });

    const parseResponse: SwimCloudCaptureParseResponse = {
      captureId: capture.captureId,
      subject: capture.subject,
      parses: [],
      rosters: [roster],
      swimmerTimes: [swimmerTimes],
      eventResults: [],
      warnings: [],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/swimcloud/pairing-token' && method === 'GET') {
        return jsonResponse(200, { token: 'test-pairing-token' });
      }
      if (url === '/api/swimcloud/captures' && method === 'GET') return jsonResponse(200, [capture]);
      if (url === `/api/swimcloud/captures/${capture.captureId}/parse` && method === 'POST') {
        return jsonResponse(200, parseResponse);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        createElement(SwimCloudCaptureBrowser, {
          mode: 'meet-results',
          onClose: vi.fn(),
          onImportMeetResults: vi.fn(),
        })
      );
    });
    await flush();
    await selectCapture(capture.captureId);

    // Both sections render with counts. In meet-results mode neither is the
    // lead section, so both start collapsed — only their header (with count)
    // shows until a coach opens them.
    expect(container.textContent).toContain('Rosters in this capture (1 team)');
    expect(container.textContent).toContain('Swimmer times in this capture (1 swimmer)');
    expect(container.textContent).not.toContain('Team A'); // section body not yet expanded
    expect(container.textContent).not.toContain('Swimmer, Alice');

    // Expand the "Rosters" section itself first.
    const rostersSectionToggle = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Rosters in this capture')
    );
    expect(rostersSectionToggle).toBeTruthy();
    await act(async () => {
      rostersSectionToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Team A');
    expect(container.textContent).toContain('2 athletes');
    expect(container.textContent).not.toContain('Norco, LA'); // athlete detail not yet expanded

    // Then expand the roster row within it -> athlete detail appears.
    const rosterRowToggle = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Team A'));
    expect(rosterRowToggle).toBeTruthy();
    await act(async () => {
      rosterRowToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Alice Swimmer');
    expect(container.textContent).toContain('Norco, LA');
    expect(container.textContent).toContain('senior');
    expect(container.textContent).toContain('Bob Swimmer');

    // Expand the "Swimmer times" section, then the swimmer row within it.
    const swimmerSectionToggle = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Swimmer times in this capture')
    );
    expect(swimmerSectionToggle).toBeTruthy();
    await act(async () => {
      swimmerSectionToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Swimmer, Alice');
    expect(container.textContent).not.toContain('100 Free SCY'); // personal-best detail not yet expanded

    const swimmerRowToggle = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Swimmer, Alice'));
    expect(swimmerRowToggle).toBeTruthy();
    await act(async () => {
      swimmerRowToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('100 Free SCY');
    expect(container.textContent).toContain('50.00');
    expect(container.textContent).toContain('Test Championships');
    expect(container.textContent).toContain('Mar 1, 2025');
    expect(container.textContent).toContain('200 IM SCY');
  });

  it('omits the rosters and swimmer-times sections entirely when their arrays are empty', async () => {
    const capture = baseCapture({ label: 'HSU @ Test Championships' });
    const parseResponse: SwimCloudCaptureParseResponse = {
      captureId: capture.captureId,
      subject: capture.subject,
      parses: [],
      rosters: [],
      swimmerTimes: [],
      eventResults: [],
      warnings: [],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/swimcloud/pairing-token' && method === 'GET') {
        return jsonResponse(200, { token: 'test-pairing-token' });
      }
      if (url === '/api/swimcloud/captures' && method === 'GET') return jsonResponse(200, [capture]);
      if (url === `/api/swimcloud/captures/${capture.captureId}/parse` && method === 'POST') {
        return jsonResponse(200, parseResponse);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        createElement(SwimCloudCaptureBrowser, {
          mode: 'meet-results',
          onClose: vi.fn(),
          onImportMeetResults: vi.fn(),
        })
      );
    });
    await flush();
    await selectCapture(capture.captureId);

    expect(container.textContent).not.toContain('Rosters in this capture');
    expect(container.textContent).not.toContain('Swimmer times in this capture');
    // Meet results is the lead section in this mode, so it still renders (at
    // "(0 team/gender groups)") rather than disappearing, with its body
    // saying plainly that there is nothing to import.
    expect(container.textContent).toContain('Meet results in this capture (0 team/gender groups)');
    expect(container.textContent).toContain('Nothing parseable in this capture yet.');
  });

  it('renders an empty-store message when GET returns no captures, and offers the demoted clipboard fallback', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/swimcloud/pairing-token') return jsonResponse(200, { token: 'test-pairing-token' });
      return jsonResponse(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onPaste = vi.fn();

    await act(async () => {
      root.render(
        createElement(SwimCloudCaptureBrowser, {
          mode: 'meet-results',
          onClose: vi.fn(),
          onImportMeetResults: vi.fn(),
          pasteFallback: { label: 'or paste a single page instead', onPaste },
        })
      );
    });
    await flush();

    expect(container.textContent).toContain('No captures yet');
    expect(container.textContent).toContain('or paste a single page instead');
  });

  it('shows the token error and never calls the capture routes when the pairing-token fetch fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/swimcloud/pairing-token') return jsonResponse(404, {});
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        createElement(SwimCloudCaptureBrowser, {
          mode: 'meet-results',
          onClose: vi.fn(),
          onImportMeetResults: vi.fn(),
        })
      );
    });
    await flush();

    expect(container.textContent).toContain('not available on this server');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/swimcloud/pairing-token');
  });
});
