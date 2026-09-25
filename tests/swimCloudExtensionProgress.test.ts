/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the extension's progress-panel formatting
 * (`extensions/swimcloud-companion/src/progress.ts`), pinning the exact
 * strings shown in `plans/2026-09-08/03-extension-crawler.md`'s "Progress
 * and cancel" section.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateCrawlVolume,
  formatCrawlVolumeFloorLine,
  formatDownloadsFallbackNote,
  formatDownloadsFallbackSummary,
  formatEtaLabel,
  formatProgressLine1,
  formatProgressLine2,
  formatRefreshPersonalBestsAppliedLine,
  formatRefreshPersonalBestsOptionLine,
  formatResumeDegradationLine,
  formatResumeSkipLine,
  formatRosterSweepLine1,
  formatRosterSweepLine2,
  formatStoredCaptureLine,
  formatSwimmerTimesLine1,
  formatSwimmerTimesLine2,
  formatSwimmerTimesPlanLine,
  genderLabelFor,
  progressFraction,
  type SwimCloudCrawlProgressState,
  type SwimCloudCrawlRosterSweepState,
  type SwimCloudSwimmerTimesProgressState,
} from '../extensions/swimcloud-companion/src/progress';

/** A roster-pass state with every field set; individual tests override what they care about. */
function rosterState(overrides: Partial<SwimCloudCrawlRosterSweepState> = {}): SwimCloudCrawlRosterSweepState {
  return {
    teamIndex: 4,
    teamCount: 13,
    gender: 'Men',
    pagesDone: 7,
    pagesTotal: 26,
    swimmersSoFar: 118,
    minDelayMs: 3000,
    ...overrides,
  };
}

function swimmerTimesState(
  overrides: Partial<SwimCloudSwimmerTimesProgressState> = {},
): SwimCloudSwimmerTimesProgressState {
  return {
    fetched: 143,
    total: 412,
    alreadyCaptured: 0,
    failed: 0,
    notServed: 0,
    concurrency: 3,
    staggerMs: 400,
    ...overrides,
  };
}

describe('genderLabelFor', () => {
  it('maps M/F to Men/Women', () => {
    expect(genderLabelFor('M')).toBe('Men');
    expect(genderLabelFor('F')).toBe('Women');
  });
});

describe('formatProgressLine1', () => {
  it('matches the design doc example verbatim', () => {
    const state: SwimCloudCrawlProgressState = {
      teamIndex: 3,
      teamCount: 4,
      gender: 'Women',
      page: 5,
      pageCountForTeamGender: 8,
      pagesDone: 41,
      pagesTotal: 66,
      minDelayMs: 3000,
    };
    expect(formatProgressLine1(state)).toBe('Team 3 of 4 · Women · page 5 of 8');
  });
});

describe('formatProgressLine2', () => {
  it('matches the design doc example, including the ETA', () => {
    const state: SwimCloudCrawlProgressState = {
      teamIndex: 3,
      teamCount: 4,
      gender: 'Women',
      page: 5,
      pageCountForTeamGender: 8,
      pagesDone: 41,
      pagesTotal: 66,
      minDelayMs: 3000,
    };
    // 66 - 41 = 25 pages remaining, at 3s each = 75s -> "about 2 min left".
    expect(formatProgressLine2(state)).toBe('41 of 66 pages · about 2 min left');
  });
});

describe('formatEtaLabel', () => {
  it('reports "done" once nothing remains', () => {
    expect(formatEtaLabel(0, 3000)).toBe('done');
    expect(formatEtaLabel(-1, 3000)).toBe('done');
  });

  it('reports seconds under a minute', () => {
    expect(formatEtaLabel(1, 3000)).toBe('about 3 sec left');
  });

  it('reports whole minutes, rounded up', () => {
    expect(formatEtaLabel(21, 3000)).toBe('about 2 min left'); // 63s -> ceil to 2 min
  });

  it('matches the design doc\'s ~66-page and ~322-page scenarios', () => {
    expect(estimateCrawlVolume(66, 3000)).toEqual({ pages: 66, etaLabel: 'about 4 min left' });
    expect(estimateCrawlVolume(322, 3000)).toEqual({ pages: 322, etaLabel: 'about 17 min left' });
  });
});

describe('formatStoredCaptureLine', () => {
  it('says nothing at all for a first crawl', () => {
    expect(formatStoredCaptureLine(0)).toBe('');
    expect(formatStoredCaptureLine(-3)).toBe('');
  });

  it('names how many pages an earlier crawl left behind', () => {
    expect(formatStoredCaptureLine(1)).toBe(
      'An earlier crawl of this meet already stored 1 page. Those are not fetched again.',
    );
    expect(formatStoredCaptureLine(52)).toBe(
      'An earlier crawl of this meet already stored 52 pages. Those are not fetched again.',
    );
  });
});

describe('formatResumeSkipLine', () => {
  it('says nothing on a first crawl, when nothing is stored at all', () => {
    expect(formatResumeSkipLine({ skippedPages: 0, pagesTotal: 66, storedPageCount: 0 })).toBe('');
  });

  it('states the skip count and why page 1 is still re-read', () => {
    expect(formatResumeSkipLine({ skippedPages: 52, pagesTotal: 66, storedPageCount: 52 })).toBe(
      'Resuming: 52 of 66 planned pages are already captured and are not being fetched again. ' +
        "Page 1 of each team is always re-read, because only a fresh page 1 proves that team's page count.",
    );
  });

  it('does not claim a saving when the stored pages are not in this plan', () => {
    // The coach unchecked the teams the earlier crawl covered. Leaving the
    // "already stored N pages" line up would promise a resume this run is not
    // getting.
    expect(formatResumeSkipLine({ skippedPages: 0, pagesTotal: 12, storedPageCount: 40 })).toBe(
      'The 40 pages stored for this meet are not in this plan. All 12 planned pages will be fetched.',
    );
    expect(formatResumeSkipLine({ skippedPages: 0, pagesTotal: 12, storedPageCount: 1 })).toBe(
      'The 1 page stored for this meet is not in this plan. All 12 planned pages will be fetched.',
    );
  });
});

describe('progressFraction', () => {
  it('is 0 with no planned pages, never NaN', () => {
    expect(progressFraction(0, 0)).toBe(0);
  });

  it('clamps into [0, 1]', () => {
    expect(progressFraction(10, 5)).toBe(1);
    expect(progressFraction(-5, 10)).toBe(0);
    expect(progressFraction(5, 10)).toBe(0.5);
  });
});

/* -------------------------------------------------------------------------- */
/* Pass 3 — rosters                                                            */
/* -------------------------------------------------------------------------- */

describe('formatRosterSweepLine1', () => {
  it('names the pass, so a coach can tell it apart from the two swims passes', () => {
    expect(formatRosterSweepLine1(rosterState())).toBe('Rosters · Team 4 of 13 · Men');
  });
});

describe('formatRosterSweepLine2', () => {
  it('reports the running swimmer count as "so far", never as a total', () => {
    // The swimmer-times pass's size is not knowable until the last roster is
    // parsed. Printing "118 swimmers" without the qualifier would read as the
    // meet's swimmer count, which it is not yet.
    // 26 - 7 = 19 roster pages left, at 3 s each = 57 s.
    expect(formatRosterSweepLine2(rosterState())).toBe(
      '7 of 26 roster pages · about 57 sec left · 118 swimmers so far, total known when this pass ends',
    );
  });

  it('says zero swimmers so far rather than going quiet before the first roster parses', () => {
    expect(formatRosterSweepLine2(rosterState({ pagesDone: 0, swimmersSoFar: 0 }))).toContain(
      '0 swimmers so far, total known when this pass ends',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Pass 4 — swimmer times                                                      */
/* -------------------------------------------------------------------------- */

describe('formatSwimmerTimesLine1', () => {
  it('matches the requested shape', () => {
    expect(formatSwimmerTimesLine1(swimmerTimesState())).toBe('Swimmer times: 143 of 412 fetched');
  });

  it('shows skipped and failed pages only when there are some', () => {
    // A pass with two lost pages must not look identical to a clean one. A pass
    // with none must not carry two zeroes that invite a coach to hunt for a
    // problem that is not there.
    expect(formatSwimmerTimesLine1(swimmerTimesState({ failed: 2 }))).toBe(
      'Swimmer times: 143 of 412 fetched · 2 not saved',
    );
    expect(formatSwimmerTimesLine1(swimmerTimesState({ alreadyCaptured: 40, failed: 2 }))).toBe(
      'Swimmer times: 143 of 412 fetched · 40 already captured · 2 not saved',
    );
  });

  it('keeps "SwimCloud did not serve it" separate from "we lost it"', () => {
    // A 404 is SwimCloud's real answer — that swimmer has no times page, and
    // the outcome is filed against the capture. A lost relay is a page this run
    // had and could not save. One is information; the other is a problem.
    expect(formatSwimmerTimesLine1(swimmerTimesState({ notServed: 12 }))).toBe(
      'Swimmer times: 143 of 412 fetched · 12 not served by SwimCloud',
    );
    expect(formatSwimmerTimesLine1(swimmerTimesState({ notServed: 12, failed: 2 }))).toBe(
      'Swimmer times: 143 of 412 fetched · 12 not served by SwimCloud · 2 not saved',
    );
  });
});

describe('formatSwimmerTimesLine2', () => {
  it('puts the pass\'s different pacing on the panel, not only in a doc comment', () => {
    // This pass overlaps its fetches. A coach watching the Network tab should be
    // able to read on the panel that the overlap is intended.
    expect(formatSwimmerTimesLine2(swimmerTimesState())).toBe('3 at a time, 400 ms apart · about 2 min left');
  });

  it('counts already-captured pages as done rather than as remaining work', () => {
    const state = swimmerTimesState({ fetched: 0, total: 412, alreadyCaptured: 412 });
    expect(formatSwimmerTimesLine2(state)).toBe('3 at a time, 400 ms apart · done');
  });
});

describe('formatSwimmerTimesPlanLine', () => {
  it('says nothing when the swimmer count needs no explanation', () => {
    expect(
      formatSwimmerTimesPlanLine({
        steps: new Array(412),
        rosterRowsSeen: 412,
        withoutSwimmerId: 0,
        duplicates: 0,
      }),
    ).toBe('');
  });

  it('explains a swimmer count that is smaller than the roster rows', () => {
    // Otherwise "412 swimmers" from 431 rows looks like an under-fetch, and a
    // real under-fetch looks like this.
    expect(
      formatSwimmerTimesPlanLine({
        steps: new Array(412),
        rosterRowsSeen: 431,
        withoutSwimmerId: 17,
        duplicates: 2,
      }),
    ).toBe(
      '412 swimmer times pages from 431 roster rows: 17 roster rows carry no SwimCloud profile link, so those swimmers have no times page to fetch; 2 listed on more than one roster and are fetched once.',
    );
  });

  it('reads correctly for a single dropped row', () => {
    expect(
      formatSwimmerTimesPlanLine({
        steps: new Array(34),
        rosterRowsSeen: 35,
        withoutSwimmerId: 1,
        duplicates: 0,
      }),
    ).toBe(
      '34 swimmer times pages from 35 roster rows: 1 roster row carries no SwimCloud profile link, so that swimmer has no times page to fetch.',
    );
  });
});

describe('formatRefreshPersonalBestsOptionLine', () => {
  it('states the pace, not a page count, since the swimmer count is not yet known', () => {
    const line = formatRefreshPersonalBestsOptionLine(3000);
    expect(line).toContain('one swimmer every 3s');
    expect(line).toContain('rosters are always re-read');
  });
});

describe('formatRefreshPersonalBestsAppliedLine', () => {
  it('is empty when nothing was already stored — there is no difference to explain', () => {
    expect(formatRefreshPersonalBestsAppliedLine(0, 3000)).toBe('');
  });

  it('names how many stored pages this run is re-fetching anyway', () => {
    const line = formatRefreshPersonalBestsAppliedLine(37, 3000);
    expect(line).toContain('37');
    expect(line).toContain('one swimmer every 3s');
    expect(line).not.toBe('');
  });

  it('uses singular phrasing for exactly one', () => {
    expect(formatRefreshPersonalBestsAppliedLine(1, 3000)).toContain('re-fetches it anyway');
  });
});

describe('formatCrawlVolumeFloorLine', () => {
  it('presents four pages per team as a floor, and says what is still unknown', () => {
    // The confirm dialog is the last point before requests start. A single
    // confident number here is what gets a coach to click Start on what they
    // think is a four-minute job.
    const line = formatCrawlVolumeFloorLine(13, 3000);
    expect(line).toContain('13 teams · at least 52 requests');
    expect(line).toContain('about 3 min left');
    expect(line).toContain('one page per rostered swimmer');
  });
});

describe('formatResumeDegradationLine — app-unreachable', () => {
  it('says plainly that the extension is not paired, and what to do about it', () => {
    // This is the exact case a real 234-page crawl hit with zero warning of
    // any kind on 2026-09-09: `app-unreachable` fell through this function's
    // switch to the empty-string default, so nothing was ever shown before
    // every page silently fell back to a separate downloaded file.
    const line = formatResumeDegradationLine('app-unreachable');
    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain('Not connected to the Omniswim app');
    expect(line).toContain('pairing token');
    expect(line).toContain('options page');
  });

  it('still returns empty for the healthy case, unchanged', () => {
    expect(formatResumeDegradationLine('none')).toBe('');
  });
});

describe('formatDownloadsFallbackNote', () => {
  it('hides when nothing has fallen back yet', () => {
    expect(formatDownloadsFallbackNote(0)).toBe('');
  });

  it('shows a running, singular-aware count while the crawl is still going', () => {
    expect(formatDownloadsFallbackNote(1)).toBe(
      '1 page saved to Downloads instead of the app so far — combined into one file when this crawl finishes.',
    );
    expect(formatDownloadsFallbackNote(234)).toContain('234 pages saved to Downloads');
  });
});

describe('formatDownloadsFallbackSummary', () => {
  it('is silent when nothing fell back', () => {
    expect(formatDownloadsFallbackSummary(0, 'omniswim-swimcloud-captures/meet-1/combined-capture.json')).toBe('');
  });

  it('names the one combined file when the flush succeeded', () => {
    const summary = formatDownloadsFallbackSummary(234, 'omniswim-swimcloud-captures/meet-379295/combined-capture.json');
    expect(summary).toContain('234 pages were saved to Downloads');
    expect(summary).toContain('combined into one file: omniswim-swimcloud-captures/meet-379295/combined-capture.json');
    // The whole point of this feature: never implies 234 separate files.
    expect(summary).not.toMatch(/234 (files|downloads)/i);
  });

  it('says the combine step itself failed, distinctly from a successful flush, when no filename comes back', () => {
    const summary = formatDownloadsFallbackSummary(12, undefined);
    expect(summary).toContain('combining them into one file failed');
    expect(summary).not.toContain('combined into one file:');
  });
});
