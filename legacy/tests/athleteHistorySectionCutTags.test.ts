// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The athlete drawer's "Supplemental history" list judges each stored swim
 * against the published standards. Two kinds of stored row are not results
 * and must never show a cut (plans/2026-09-22/01, P12 defect 1):
 *
 *  - an extracted split (SwimCloud `X`), flagged or carrying only the pasted
 *    badge, as every row in `data/meets.json` does today;
 *  - a self-reported time (SwimCloud `U`), flagged or badge-only.
 *
 * The section used to pass only `isUserInputted`, so an extracted row got a
 * cut badge and a badge-only `U` row did too.
 *
 * Written without JSX, matching every other DOM-render test in this repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type HistoricalSwim } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import AthleteHistorySection from '../packages/manager/src/components/AthleteHistorySection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HSU = 'Henderson State';
const NAME = 'Avery Henke';

/** Avery Henke's real 100 Breast SCY 54.09 (swimmer 1330318). It earns a D2 B cut. */
const REAL: HistoricalSwim = {
  id: 'real',
  name: NAME,
  team: HSU,
  gender: Gender.MEN,
  event: '100 Breaststroke',
  time: '54.09',
  timeType: 'SCY',
  source: 'paste',
  meetLabel: 'real',
};

const ROWS: HistoricalSwim[] = [
  REAL,
  { ...REAL, id: 'x-flag', meetLabel: 'x-flag', isExtractedSplit: true },
  { ...REAL, id: 'x-badge', meetLabel: 'x-badge', swimcloudBadge: 'extracted' },
  { ...REAL, id: 'u-flag', meetLabel: 'u-flag', isUserInputted: true },
  { ...REAL, id: 'u-badge', meetLabel: 'u-badge', swimcloudBadge: 'user_input' },
];

describe('AthleteHistorySection cut tags', () => {
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
  });

  it('shows the cut on the real swim only', async () => {
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
    // The section starts collapsed; open it the way a coach does.
    const toggle = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
    if (!toggle) throw new Error('no section toggle');
    await act(async () => {
      toggle.click();
    });
    const items = [...container.querySelectorAll('li')];
    expect(items).toHaveLength(ROWS.length);
    const textOf = (meet: string) => {
      const li = items.find(el => el.textContent?.includes(meet));
      if (!li) throw new Error(`no row for ${meet}`);
      return li.textContent ?? '';
    };
    expect(textOf('real')).toContain('D2 B CUT');
    for (const meet of ['x-flag', 'x-badge', 'u-flag', 'u-badge']) {
      expect(textOf(meet)).not.toContain('CUT');
    }
  });
});
