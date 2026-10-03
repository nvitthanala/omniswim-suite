/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared fixtures and the fake-dependency harness for the multi-team driver tests
 * (`swimCloudExtensionMultiTeamDriver.test.ts` and `...DriverReview.test.ts`).
 * Provenance of the fixtures is in the first of those two files. The fake relay
 * models the real app: a capture that was never opened is refused, and the page
 * goes to the downloads fallback instead.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureIdForSubject, type SwimCloudCaptureSubject } from '../../packages/swimcloud/src/entities';
import { parseTeamRosterHtml } from '../../packages/swimcloud/src/parser';
import { collectSwimmerIds } from '../../extensions/swimcloud-companion/src/swimmerTimes';
import {
  runMultiTeamCrawl,
  type MultiTeamControl,
  type MultiTeamDriverDeps,
  type MultiTeamDriverState,
  type MultiTeamFetchedPage,
  type MultiTeamRelayOutcome,
  type MultiTeamRelayRequest,
  type MultiTeamSummary,
  type TeamSeasonChoice,
} from '../../extensions/swimcloud-companion/src/multiTeamDriver';

export const here = dirname(fileURLToPath(import.meta.url)); // tests/helpers
export const fixturesDir = join(here, '..', 'fixtures', 'swimcloud');
export const SWIMMER_BODY = readFileSync(join(here, '..', 'fixtures', 'profile_fastest_times-1330318.json'), 'utf8');

type Gender = 'M' | 'F';
export const rosterPage = (team: string, gender: Gender): string =>
  readFileSync(join(fixturesDir, `team-${team}-roster-gender-${gender}-page.html`), 'utf8');

export const PAGES: Record<string, string> = {};
for (const team of ['412', '10002824']) for (const g of ['M', 'F'] as const) PAGES[`${team}|${g}`] = rosterPage(team, g);

/** Swimmer ids per roster page, read by the real parser, in page order. */
export function idsOf(team: string, gender: Gender, pages: Record<string, string> = PAGES): string[] {
  const parsed = parseTeamRosterHtml(pages[`${team}|${gender}`], {
    sourceUrl: `https://www.swimcloud.com/team/${team}/roster/?gender=${gender}`,
    retrievedAt: '2026-10-03T00:00:00.000Z',
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error('fixture does not parse');
  return collectSwimmerIds([parsed.data.athletes]).swimmerIds;
}

export const IDS_412M = idsOf('412', 'M');
export const IDS_412F = idsOf('412', 'F');
export const IDS_10002824M = idsOf('10002824', 'M');
export const IDS_10002824F = idsOf('10002824', 'F');
export const ALL_IDS = [...IDS_412M, ...IDS_412F, ...IDS_10002824M, ...IDS_10002824F];

export const swimmerUrl = (id: string): string => `https://www.swimcloud.com/api/swimmers/${id}/profile_fastest_times/`;
export const seasonRosterUrl = (team: string, gender: Gender, seasonId: string): string =>
  `https://www.swimcloud.com/team/${team}/roster/?page=1&gender=${gender}&season_id=${seasonId}&sort=name`;
export const optionsUrl = (team: string): string => `https://www.swimcloud.com/team/${team}/roster/?gender=M`;

export const ROSTER_URL = /^https:\/\/www\.swimcloud\.com\/team\/(\d+)\/roster\/\?(?:page=1&)?gender=([MF])(?:&season_id=(\d+)&sort=name)?$/;

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

export interface Harness {
  readonly deps: MultiTeamDriverDeps;
  readonly control: MultiTeamControl;
  /** Every request, with the virtual time it started. */
  readonly fetches: { url: string; at: number }[];
  readonly relays: MultiTeamRelayRequest[];
  readonly sleeps: number[];
  readonly states: MultiTeamDriverState[];
  /** The keys of each save, in order. `saveKeys` holds the run key each save used. */
  readonly saves: (readonly string[])[];
  readonly saveKeys: string[];
  readonly clears: string[];
  /** The saved-progress store, keyed by run key. */
  readonly store: Map<string, readonly string[]>;
  readonly chooseCalls: number[];
  /** Capture ids the app has been told to open, with the last planned page count. */
  readonly opened: Map<string, number>;
  readonly openCalls: { subject: SwimCloudCaptureSubject; planned: number }[];
  readonly marks: { subject: SwimCloudCaptureSubject; completeness: string }[];
  readonly flushes: (readonly SwimCloudCaptureSubject[])[];
  /** Source URLs that really reached the app, per capture id. */
  readonly appPages: Map<string, string[]>;
  /** Pages the fake app refused (capture never opened): they would go to the downloads fallback. */
  readonly fallbackPages: MultiTeamRelayRequest[];
  /** The shared pacing clock. A second run on the same harness shares it, as the real page does. */
  readonly clock: { last: number | undefined };
}

export interface HarnessOptions {
  /** Override one response. Return `null` for "use the default server". `n` counts requests from 1. */
  readonly respond?: (url: string, n: number) => (Omit<MultiTeamFetchedPage, 'finalUrl'> & { finalUrl?: string }) | undefined | null;
  readonly pages?: Record<string, string>;
  readonly choose?: (teamId: string) => string | undefined;
  /** Preset saved progress, returned for any run key. */
  readonly finished?: readonly string[];
  /** Called after each request is answered, before the driver sees the answer. */
  readonly afterFetch?: (n: number, h: Harness) => void;
  /** Called on every sleep. */
  readonly onSleep?: (ms: number, h: Harness) => void;
  /** Force a relay outcome for one request; `undefined` means the fake app decides. */
  readonly relayOutcome?: (request: MultiTeamRelayRequest) => MultiTeamRelayOutcome | undefined;
  /** Make opening this subject fail (no capture id comes back). */
  readonly openFails?: (subject: SwimCloudCaptureSubject) => boolean;
  /** A server that honours `season_id` by marking that season selected in the page it serves. */
  readonly serveBySeason?: boolean;
  /** Share the clock and the saved-progress store with an earlier harness (a second run on the same page). */
  readonly shareWith?: Harness;
}

export function selectSeasonInPage(html: string, seasonId: string): string {
  const unselected = html.replace(/<option value="(\d+)" selected>/g, '<option value="$1">');
  return unselected.replace(`<option value="${seasonId}">`, `<option value="${seasonId}" selected>`);
}

export let virtualNow = 1_000_000;

export function makeHarness(options: HarnessOptions = {}): Harness {
  const pages = options.pages ?? PAGES;
  const control: MultiTeamControl = { cancelled: false, paused: false };
  const shared = options.shareWith;
  if (shared === undefined) virtualNow = 1_000_000;
  const h: Harness = {
    control,
    fetches: [],
    relays: [],
    sleeps: [],
    states: [],
    saves: [],
    saveKeys: [],
    clears: [],
    store: shared?.store ?? new Map(),
    chooseCalls: [],
    opened: new Map(),
    openCalls: [],
    marks: [],
    flushes: [],
    appPages: new Map(),
    fallbackPages: [],
    clock: shared?.clock ?? { last: undefined },
    // Filled below; `deps` closes over `h` through the const binding.
    deps: undefined as unknown as MultiTeamDriverDeps,
  };
  const defaultServe = (url: string): MultiTeamFetchedPage => {
    const roster = ROSTER_URL.exec(url);
    if (roster !== null) {
      const html = pages[`${roster[1]}|${roster[2]}`];
      if (html === undefined) return { html: 'not found', httpStatus: 404, finalUrl: url };
      // By default a server that ignores `season_id`: it always serves the page it has.
      const served = options.serveBySeason === true && roster[3] !== undefined ? selectSeasonInPage(html, roster[3]) : html;
      return { html: served, httpStatus: 200, finalUrl: url };
    }
    if (/\/api\/swimmers\/\d+\/profile_fastest_times\/$/.test(url)) return { html: SWIMMER_BODY, httpStatus: 200, finalUrl: url };
    return { html: 'not found', httpStatus: 404, finalUrl: url };
  };
  const deps: MultiTeamDriverDeps = {
    async fetchPage(url) {
      h.fetches.push({ url, at: virtualNow });
      const n = h.fetches.length;
      virtualNow += 200; // the request takes a little while
      const override = options.respond === undefined ? null : options.respond(url, n);
      const answer: MultiTeamFetchedPage | undefined =
        override === null ? defaultServe(url) : override === undefined ? undefined : { ...override, finalUrl: override.finalUrl ?? url };
      options.afterFetch?.(n, h);
      return answer;
    },
    async relay(request) {
      h.relays.push(request);
      const forced = options.relayOutcome?.(request);
      const id = captureIdForSubject(request.subject);
      // The real app answers 404 for a capture that was never opened; the worker then falls back to Downloads.
      if (!h.opened.has(id)) {
        h.fallbackPages.push(request);
        return forced ?? 'fallback';
      }
      if (forced !== undefined && forced !== 'landed') return forced;
      h.appPages.set(id, [...(h.appPages.get(id) ?? []), request.sourceUrl]);
      return 'landed';
    },
    async openCapture(subject, planned) {
      h.openCalls.push({ subject, planned });
      if (options.openFails?.(subject) === true) return undefined;
      const id = captureIdForSubject(subject);
      h.opened.set(id, planned);
      return id;
    },
    async markCapture(subject, completeness) {
      h.marks.push({ subject, completeness });
    },
    async flushDownloads(subjects) {
      h.flushes.push([...subjects]);
      return [];
    },
    async sleep(ms) {
      h.sleeps.push(ms);
      virtualNow += ms;
      options.onSleep?.(ms, h);
    },
    now: () => virtualNow,
    isoNow: () => '2026-10-03T12:00:00.000Z',
    paceClock: {
      get: () => h.clock.last,
      set: (ms) => {
        h.clock.last = ms;
      },
    },
    async loadFinished(runKey) {
      return options.finished ?? h.store.get(runKey) ?? [];
    },
    async saveFinished(runKey, keys) {
      h.saves.push([...keys]);
      h.saveKeys.push(runKey);
      h.store.set(runKey, [...keys]);
    },
    async clearFinished(runKey) {
      h.clears.push(runKey);
      h.store.delete(runKey);
    },
    onProgress(state) {
      h.states.push(state);
    },
    async chooseSeasons(reports) {
      h.chooseCalls.push(reports.length);
      const choices: TeamSeasonChoice[] = [];
      for (const report of reports) {
        if (report.options === undefined) continue;
        const label = options.choose === undefined ? '2025-2026' : options.choose(report.teamId);
        if (label !== undefined) choices.push({ teamId: report.teamId, seasonLabel: label });
      }
      return choices;
    },
    control,
  };
  return Object.assign(h, { deps });
}


export const TEAMS = ['412', '10002824'] as const;
export const run = (h: Harness, teamIds: readonly string[] = TEAMS): Promise<MultiTeamSummary> => runMultiTeamCrawl(h.deps, { teamIds });
export const urls = (h: Harness): string[] => h.fetches.map((f) => f.url);

/** The roster-side URLs of the two-team run, in the order the queue hands them out. */
export const EXPECTED_ROSTER_SIDE = [
  optionsUrl('412'),
  optionsUrl('10002824'),
  seasonRosterUrl('412', 'M', '29'),
  seasonRosterUrl('412', 'F', '29'),
  seasonRosterUrl('10002824', 'M', '29'),
  seasonRosterUrl('10002824', 'F', '29'),
];

