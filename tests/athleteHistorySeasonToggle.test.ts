// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P5 (season vs. lifetime) and P7 ("Bests pulled <date>") on the athlete
 * drawer's Supplemental history section. Written without JSX, matching
 * `athleteHistorySectionCutTags.test.ts`.
 *
 * Season identity is `HistoricalSwim.seasonId` only — never derived from a
 * meet label or a date guess — and the season's own display label is the
 * real date range of that season's own swims, never the bare id. A row with
 * no `seasonId` (paste/PDF) can never join a season, so switching to "This
 * season" must both drop it AND say how many were dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type HistoricalSwim } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import AthleteHistorySection from '../packages/manager/src/components/AthleteHistorySection';
import {
  formatCaptureDate,
  highestSeasonId,
  latestRetrievedAt,
  rowsInSeason,
  rowsWithoutSeason,
  seasonDateRangeLabel,
} from '../packages/manager/src/components/athleteHistorySeasonView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HSU = 'Henderson State';
const NAME = 'Season Swimmer';

const BASE: HistoricalSwim = {
  name: NAME,
  team: HSU,
  gender: Gender.MEN,
  event: '100 Freestyle',
  time: '48.00',
  timeType: 'SCY',
  source: 'swimcloud',
};

const OLD_SEASON: HistoricalSwim = {
  ...BASE,
  id: 'old',
  seasonId: '28',
  date: '2024-11-05',
  meetLabel: 'old-season',
  retrievedAt: '2026-01-01T00:00:00.000Z',
};

const NEW_SEASON_EARLY: HistoricalSwim = {
  ...BASE,
  id: 'new-early',
  event: '200 Freestyle',
  seasonId: '29',
  date: '2025-10-12',
  meetLabel: 'new-season-early',
  retrievedAt: '2026-09-20T00:00:00.000Z',
};

const NEW_SEASON_LATE: HistoricalSwim = {
  ...BASE,
  id: 'new-late',
  event: '500 Freestyle',
  seasonId: '29',
  date: '2026-07-03',
  meetLabel: 'new-season-late',
  retrievedAt: '2026-09-22T12:00:00.000Z',
};

const NO_SEASON: HistoricalSwim = {
  ...BASE,
  id: 'pasted',
  event: '50 Freestyle',
  meetLabel: 'no-season',
  source: 'paste',
};

const ROWS: HistoricalSwim[] = [OLD_SEASON, NEW_SEASON_EARLY, NEW_SEASON_LATE, NO_SEASON];

describe('athleteHistorySeasonView (pure helpers)', () => {
  it('picks the numerically highest seasonId present', () => {
    expect(highestSeasonId(ROWS)).toBe('29');
    expect(highestSeasonId([NO_SEASON])).toBeNull();
  });

  it('scopes rowsInSeason to exactly that id, and rowsWithoutSeason to rows carrying none', () => {
    expect(rowsInSeason(ROWS, '29').map((r) => r.id)).toStrictEqual(['new-early', 'new-late']);
    expect(rowsWithoutSeason(ROWS).map((r) => r.id)).toStrictEqual(['pasted']);
  });

  it('labels the season from its own swims’ dates, not the id', () => {
    expect(seasonDateRangeLabel(rowsInSeason(ROWS, '29'))).toBe('Oct 2025 – Jul 2026');
    expect(seasonDateRangeLabel([])).toBeNull();
    // A row with an unparseable/absent date does not fabricate a range.
    expect(seasonDateRangeLabel([{ ...NEW_SEASON_EARLY, date: undefined }])).toBeNull();
  });

  it('reports the latest capture instant, and a short display date for it', () => {
    expect(latestRetrievedAt(ROWS)).toBe('2026-09-22T12:00:00.000Z');
    expect(latestRetrievedAt([NO_SEASON])).toBeNull();
    expect(formatCaptureDate('2026-09-22T12:00:00.000Z')).toBe('Sep 22, 2026');
  });
});

describe('AthleteHistorySection season/lifetime toggle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const openSection = async () => {
    const toggle = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
    if (!toggle) throw new Error('no section toggle');
    await act(async () => {
      toggle.click();
    });
  };

  it('defaults to Lifetime (every row shown) and shows the pulled date', async () => {
    const athlete = { key: 'k', name: NAME, team: HSU } as unknown as ScorerRosterRow;
    await act(async () => {
      root.render(
        createElement(AthleteHistorySection, {
          rows: ROWS,
          athlete,
          gender: Gender.MEN,
          editable: false,
          applyPatch: () => undefined,
        })
      );
    });
    await openSection();
    expect(container.querySelectorAll('li')).toHaveLength(ROWS.length);
    expect(container.textContent).toContain('Bests pulled Sep 22, 2026');
  });

  it('switches to This season: drops the older season and the season-less row, and says how many were excluded', async () => {
    const athlete = { key: 'k2', name: NAME, team: HSU } as unknown as ScorerRosterRow;
    await act(async () => {
      root.render(
        createElement(AthleteHistorySection, {
          rows: ROWS,
          athlete,
          gender: Gender.MEN,
          editable: false,
          applyPatch: () => undefined,
        })
      );
    });
    await openSection();

    const seasonButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'This season'
    ) as HTMLButtonElement | null;
    if (!seasonButton) throw new Error('no "This season" toggle button');
    await act(async () => {
      seasonButton.click();
    });

    const items = [...container.querySelectorAll('li')];
    expect(items).toHaveLength(2);
    const meets = items.map((li) => (li.textContent?.includes('new-season-early') ? 'early' : 'late'));
    expect(meets.sort()).toStrictEqual(['early', 'late']);
    expect(container.textContent).not.toContain('old-season');
    expect(container.textContent).not.toContain('no-season');
    expect(container.textContent).toContain('Oct 2025 – Jul 2026');
    expect(container.textContent).toContain('1 without a season excluded');
  });

  it('never shows the toggle when no swim carries a seasonId', async () => {
    const athlete = { key: 'k3', name: NAME, team: HSU } as unknown as ScorerRosterRow;
    await act(async () => {
      root.render(
        createElement(AthleteHistorySection, {
          rows: [NO_SEASON],
          athlete,
          gender: Gender.MEN,
          editable: false,
          applyPatch: () => undefined,
        })
      );
    });
    await openSection();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'This season')).toBe(false);
    // No swim carries retrievedAt either, so the pulled-date line is hidden.
    expect(container.textContent).not.toContain('Bests pulled');
  });
});
