// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The bulk roster import, end to end: `RosterImportWizard`'s "Add from
 * SwimCloud" button, the shared `SwimCloudCaptureBrowser` (`@omniswim/ui`,
 * `mode="roster-history"`), and the state the wizard sets when the browser
 * hands its selection back via `handleCaptureBrowserRosterImport`.
 *
 * `fetch` is mocked throughout — this file never talks to a live server. The
 * three-call protocol (pairing token, capture list, parse) and the
 * `X-Omniswim-Capture-Token` header follow `tests/swimCloudCapturePicker.test.ts`
 * exactly, because the browser is the same component both files exercise.
 *
 * Selecting a capture parses it immediately (the `<select>`'s own `onChange`)
 * — there is no separate "Open" step, unlike the two independently-built
 * pickers this component replaced.
 *
 * ## Where the parse response's values come from
 *
 * The roster and the personal bests are parsed out of real captures at test
 * time — Henderson State's real men's and women's roster pages, and River
 * Paulk's real times page. Nothing is typed in by hand.
 *
 * The **pairing** between them is constructed, and says so: the real times
 * fixture belongs to an Auburn swimmer, so it is re-pointed at a real Henderson
 * State athlete's real `swimCloudSwimmerId`. That is what makes the partial-
 * coverage case real rather than staged — one roster athlete has captured
 * times, thirty-four do not — and it proves the id branch specifically, since
 * the two pages spell entirely different names.
 *
 * Written without JSX (plain `React.createElement`) so it stays a `.test.ts`
 * under this repo's `tests/**\/*.test.ts` include glob — the convention
 * `tests/swimCloudCapturePicker.test.ts` established.
 *
 * `useToast` outside a `ToastProvider` falls back to `console.error` /
 * `console.log`, so spying on the console is how this file reads what a coach
 * would have been shown.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type Workspace } from '@omniswim/core/types';
import {
  parseSwimmerTimesHtml,
  parseTeamRosterHtml,
  type SwimCloudParseContext,
  type SwimCloudRosterParse,
  type SwimCloudSwimmerTimesParse,
} from '@omniswim/swimcloud';
import RosterImportWizard from '@omniswim/manager/components/RosterImportWizard';

// React 18/19 warn on `act(...)` unless the environment declares itself.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

/** The real capture URLs, verbatim from the fixtures' own provenance headers. */
const MEN_ROSTER_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=29&sort=name',
  retrievedAt: '2026-09-09T02:08:38.793Z',
  track: 'browser-extension',
};
const WOMEN_ROSTER_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/team/58/roster/?page=1&gender=F&season_id=29&sort=name',
  retrievedAt: '2026-09-09T02:08:50.769Z',
  track: 'browser-extension',
};
const TIMES_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/swimmer/1472365/times/',
  retrievedAt: '2026-09-09T03:32:55.480Z',
  track: 'browser-extension',
};

function realRoster(gender: 'm' | 'f'): SwimCloudRosterParse {
  const result = parseTeamRosterHtml(
    fixture(`swimcloud-real-team-roster-58-gender-${gender}.html`),
    gender === 'm' ? MEN_ROSTER_CONTEXT : WOMEN_ROSTER_CONTEXT,
  );
  if (!result.ok) throw new Error(`roster fixture failed to parse: ${result.failure.message}`);
  return result.data;
}

function realSwimmerTimes(): SwimCloudSwimmerTimesParse {
  const result = parseSwimmerTimesHtml(fixture('swimcloud-real-swimmer-times-1472365.html'), TIMES_CONTEXT);
  if (!result.ok) throw new Error(`times fixture failed to parse: ${result.failure.message}`);
  return result.data;
}

/** The real times parse, re-pointed at a real roster athlete's real id. See this file's header. */
function timesFor(swimCloudSwimmerId: string): SwimCloudSwimmerTimesParse {
  return { ...realSwimmerTimes(), swimCloudSwimmerId };
}

/** Colin Candebat — a real row of the real men's roster (`tests/swimcloudTeamRosterParser.test.ts`). */
const COLIN_ID = '1865160';

/** Mirrors `captureStore.ts`'s `SwimCloudCaptureRecord`, only what the panel reads. */
function captureRecord() {
  return {
    captureId: 'team-58',
    subject: { kind: 'team' as const, teamId: '58', season: '2025-2026' },
    label: 'Henderson State — full team crawl',
    createdAt: '2026-09-09T02:00:00Z',
    updatedAt: '2026-09-09T02:10:00Z',
    completeness: 'partial' as const,
    plannedPageCount: 37,
    pages: [{ canonicalUrl: 'https://www.swimcloud.com/team/58/roster/' }],
    notes: [],
  };
}

function parseResponseWith(
  rosters: readonly SwimCloudRosterParse[],
  swimmerTimes: readonly SwimCloudSwimmerTimesParse[],
) {
  return {
    captureId: 'team-58',
    subject: captureRecord().subject,
    parses: [],
    rosters,
    swimmerTimes,
    warnings: [],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function testWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Test workspace',
    menResults: [],
    womenResults: [],
    recruits: [],
    createdAt: Date.now(),
    ...overrides,
  } as Workspace;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('RosterImportWizard — bulk roster import from a completed capture', () => {
  let container: HTMLDivElement;
  let root: Root;
  let errors: string[];
  let logs: string[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    errors = [];
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(String(args[0]));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockCaptureRoutes(parseResponse: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/swimcloud/pairing-token' && method === 'GET') {
        return jsonResponse(200, { token: 'test-pairing-token' });
      }
      if (url === '/api/swimcloud/captures' && method === 'GET') {
        expect((init?.headers as Record<string, string> | undefined)?.['X-Omniswim-Capture-Token']).toBe(
          'test-pairing-token',
        );
        return jsonResponse(200, [captureRecord()]);
      }
      if (url === '/api/swimcloud/captures/team-58/parse' && method === 'POST') {
        expect((init?.headers as Record<string, string> | undefined)?.['X-Omniswim-Capture-Token']).toBe(
          'test-pairing-token',
        );
        return jsonResponse(200, parseResponse);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function findButton(text: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text));
    if (button === undefined) throw new Error(`no button matching ${JSON.stringify(text)}`);
    return button;
  }

  async function click(button: HTMLElement): Promise<void> {
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  }

  function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
    const proto = el instanceof HTMLSelectElement ? globalThis.HTMLSelectElement.prototype : globalThis.HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setValue === undefined) throw new Error('no native value setter');
    setValue.call(el, value);
  }

  /** Picks a capture from the browser's own `<select>` — parsing fires on `onChange`, no separate "Open" step. */
  async function selectCapture(captureId: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="SwimCloud capture"]');
    if (select === null) throw new Error('capture select not rendered');
    await act(async () => {
      setNativeValue(select, captureId);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
  }

  /** Mount the wizard, name a team, open the capture browser, and parse the one capture. */
  async function openCaptureAndParse(gender: Gender, teamName = 'Henderson State'): Promise<void> {
    await act(async () => {
      root.render(
        createElement(RosterImportWizard, {
          workspace: testWorkspace(),
          gender,
          onClose: () => undefined,
          onUpdate: () => undefined,
        }),
      );
    });

    const teamInput = container.querySelector<HTMLInputElement>('input[aria-label="Custom team name"]');
    if (teamInput === null) throw new Error('team input not rendered');
    await act(async () => {
      setNativeValue(teamInput, teamName);
      teamInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await click(findButton('Add from SwimCloud'));
    await selectCapture('team-58');
  }

  it('disables "Add from SwimCloud" before a team is named', async () => {
    await act(async () => {
      root.render(
        createElement(RosterImportWizard, {
          workspace: testWorkspace(),
          gender: Gender.MEN,
          onClose: () => undefined,
          onUpdate: () => undefined,
        }),
      );
    });

    expect(findButton('Add from SwimCloud').disabled).toBe(true);
  });

  it('keeps the manual clipboard path reachable, as the browser\'s own empty-state fallback', async () => {
    // No stored captures at all — the browser's empty state is what a coach
    // sees before the extension has ever fetched anything.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/swimcloud/pairing-token' && method === 'GET') {
        return jsonResponse(200, { token: 'test-pairing-token' });
      }
      if (url === '/api/swimcloud/captures' && method === 'GET') return jsonResponse(200, []);
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        createElement(RosterImportWizard, {
          workspace: testWorkspace(),
          gender: Gender.MEN,
          onClose: () => undefined,
          onUpdate: () => undefined,
        }),
      );
    });
    const teamInput = container.querySelector<HTMLInputElement>('input[aria-label="Custom team name"]');
    if (teamInput === null) throw new Error('team input not rendered');
    await act(async () => {
      setNativeValue(teamInput, 'Henderson State');
      teamInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(findButton('Add from SwimCloud'));

    expect(container.textContent).toContain('No captures yet');
    // The demoted fallback — a secondary link, not a peer button — reads the
    // same clipboard-import affordance the old, deleted "From clipboard"
    // toolbar button offered, per plans/2026-09-10/02-UI-REDESIGN-WHOLE-APP.md §0.
    expect(container.textContent).toContain('or paste a single swimmer instead');
  });

  it('states coverage honestly before the coach commits', async () => {
    mockCaptureRoutes(parseResponseWith([realRoster('m')], [timesFor(COLIN_ID)]));
    await openCaptureAndParse(Gender.MEN);

    expect(container.textContent).toContain('Henderson State University · Men · 2025-2026');
    // One athlete of thirty-five, and the other thirty-four named as work left.
    expect(container.textContent).toContain(
      '1 of 35 athletes have captured times · 34 will need a manual capture.',
    );
    // Never the bare word "Complete" for a partial crawl.
    expect(container.textContent).toContain('1 of 37 planned pages');
    expect(container.textContent).not.toContain('Complete');
  });

  it('imports the covered swimmer, seeds the whole roster, and leaves the rest for manual capture', async () => {
    mockCaptureRoutes(parseResponseWith([realRoster('m')], [timesFor(COLIN_ID)]));
    await openCaptureAndParse(Gender.MEN);

    await click(findButton('Import this roster'));

    expect(errors).toStrictEqual([]);

    // The whole roster is on the checklist; exactly the covered athlete is checked off.
    expect(container.textContent).toContain('Roster queue — Henderson State University (1/35 captured)');
    expect(container.textContent).toContain('✓ Colin Candebat');
    expect(container.textContent).toContain('Bartu Akin');

    // The preview holds the real swims off the real times capture — 9 rows on
    // the page, less the one the page's own chip flags as a relay leadoff.
    expect(container.textContent).toContain('8 swims parsed');
    expect(container.textContent).toContain('Paulk, River J');
    expect(container.textContent).toContain('50 Free SCY');
    expect(container.textContent).toContain('19.42');
    expect(container.textContent).toContain('1000 Free SCY');
    expect(container.textContent).toContain('10:37.48');
    expect(container.textContent).not.toContain('50 Back SCY');
    expect(container.textContent).toContain('1 row(s) skipped — relay leadoff.');

    // And the toast said what was and was not imported.
    const summary = logs.find(line => line.includes('imported 8 swim(s)'));
    expect(summary).toContain('Henderson State University: imported 8 swim(s) for 1 of 35 roster swimmer(s).');
    expect(summary).toContain('34 still need a "Copy for Omniswim" capture');
    expect(summary).toContain('35 not yet in this workspace:');
  });

  it('does not re-flag a swimmer the workspace already holds', async () => {
    mockCaptureRoutes(parseResponseWith([realRoster('m')], [timesFor(COLIN_ID)]));

    const roster = realRoster('m');
    const alreadyHere = roster.athletes.slice(0, 34).map(a => ({
      name: a.name,
      team: 'Henderson State',
      gender: Gender.MEN,
      classYear: 'FR',
    }));

    await act(async () => {
      root.render(
        createElement(RosterImportWizard, {
          workspace: testWorkspace({ recruits: alreadyHere as Workspace['recruits'] }),
          gender: Gender.MEN,
          onClose: () => undefined,
          onUpdate: () => undefined,
        }),
      );
    });
    const teamInput = container.querySelector<HTMLInputElement>('input[aria-label="Custom team name"]');
    if (teamInput === null) throw new Error('team input not rendered');
    await act(async () => {
      setNativeValue(teamInput, 'Henderson State');
      teamInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(findButton('Add from SwimCloud'));
    await selectCapture('team-58');
    await click(findButton('Import this roster'));

    // 34 of the 35 are already recruits on this team, so only one is new — the
    // same `rosterNamesForTeam` check the clipboard roster path has always made.
    const summary = logs.find(line => line.includes('not yet in this workspace'));
    expect(summary).toContain('1 not yet in this workspace:');
    // Everyone still gets a checklist entry; being known is not being captured.
    expect(container.textContent).toContain('(1/35 captured)');
  });

  it('warns rather than silently importing a roster of the other gender', async () => {
    mockCaptureRoutes(parseResponseWith([realRoster('f')], []));
    await openCaptureAndParse(Gender.MEN);

    // The panel says so before the coach commits, and the button says what it
    // would be doing.
    expect(container.textContent).toContain('This roster is Women; this importer is scoped to Men.');
    expect(findButton('Import anyway')).toBeTruthy();
  });

  it('carries the gender disagreement into the import warnings', async () => {
    const womens = realRoster('f');
    const emma = womens.athletes.find(a => a.name === 'Emma Crowe');
    if (emma?.swimCloudSwimmerId === undefined) throw new Error('Emma Crowe missing from the roster fixture');

    mockCaptureRoutes(parseResponseWith([womens], [timesFor(emma.swimCloudSwimmerId)]));
    await openCaptureAndParse(Gender.MEN);
    await click(findButton('Import anyway'));

    expect(container.textContent).toContain(
      "This capture's roster is Women; this importer is scoped to Men. Every swim below is recorded as Men.",
    );
    // The swims still landed, under the wizard's own scope — stated, not hidden.
    expect(container.textContent).toContain('Roster queue — Henderson State University (1/16 captured)');
    expect(container.textContent).toContain('✓ Emma Crowe');
    expect(container.textContent).toContain('19.42');
  });

  it('seeds the checklist without a preview when the capture holds no times for anybody', async () => {
    mockCaptureRoutes(parseResponseWith([realRoster('m')], []));
    await openCaptureAndParse(Gender.MEN);

    expect(container.textContent).toContain('0 of 35 athletes have captured times');
    await click(findButton('Import this roster'));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('No importable times in this capture for Henderson State University');
    // The roster still became a checklist, and the wizard stayed on the paste
    // step rather than showing an empty preview.
    expect(container.textContent).toContain('Roster queue — Henderson State University (0/35 captured)');
    expect(container.textContent).toContain('Capture next swimmer');
    expect(container.textContent).not.toContain('swims parsed');
  });

  it('says plainly when a capture holds no roster page at all', async () => {
    mockCaptureRoutes(parseResponseWith([], [timesFor(COLIN_ID)]));
    await openCaptureAndParse(Gender.MEN);

    expect(container.textContent).toContain('This capture holds no team-roster page');
    // Nothing to import, so the action stays disabled.
    expect(findButton('Import this roster').disabled).toBe(true);
  });

  it('never calls a capture route when the pairing token is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/swimcloud/pairing-token') return jsonResponse(404, {});
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        createElement(RosterImportWizard, {
          workspace: testWorkspace(),
          gender: Gender.MEN,
          onClose: () => undefined,
          onUpdate: () => undefined,
        }),
      );
    });
    const teamInput = container.querySelector<HTMLInputElement>('input[aria-label="Custom team name"]');
    if (teamInput === null) throw new Error('team input not rendered');
    await act(async () => {
      setNativeValue(teamInput, 'Henderson State');
      teamInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(findButton('Add from SwimCloud'));

    expect(container.textContent).toContain('not available on this server');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/swimcloud/pairing-token');
  });
});
