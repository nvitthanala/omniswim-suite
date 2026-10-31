// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P16: TeamRosterRow's per-athlete event hint used to print the raw HyTek
 * label an AthleteEventProfile.primaryEvents entry is now keyed by ("Event 4
 * Men 1000 Yard Freestyle"). It must show the compact display label instead
 * — the profile's own keys (used for lookups elsewhere) stay untouched.
 *
 * Written without JSX, matching every other DOM-render test in this repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender } from '@omniswim/core/types';
import type { AthleteEventProfile } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import TeamRosterRow from '../packages/manager/src/components/TeamRosterRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW: ScorerRosterRow = {
  key: 'k',
  name: 'Avery Henke',
  team: 'Henderson State',
  gender: Gender.MEN,
  classYear: 'JR',
  athleteRole: 'swimmer',
  isScorer: true,
  source: 'auto',
};

const PROFILE: AthleteEventProfile = {
  bestByEvent: {},
  extractedByEvent: {},
  primaryEvents: ['Event 4 Men 1000 Yard Freestyle', 'Event 24 Men 100 Yard Backstroke'],
  relayEvents: [],
} as unknown as AthleteEventProfile;

describe('TeamRosterRow event hint', () => {
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

  it('shows compact event labels, not the raw HyTek profile keys', async () => {
    await act(async () => {
      root.render(
        createElement('table', null, createElement('tbody', null, createElement(TeamRosterRow, {
          row: ROW,
          meetPts: 12,
          isSelected: false,
          profile: PROFILE,
          describeProfile: () => 'tooltip',
          warningMessages: [],
          warningLabel: null,
          editable: false,
          onSelect: () => undefined,
          onSetScorer: () => undefined,
        })))
      );
    });

    expect(container.textContent).toContain('1000 Free (SCY)');
    expect(container.textContent).toContain('100 Back (SCY)');
    expect(container.textContent).not.toContain('Event 4 Men');
    expect(container.textContent).not.toContain('Event 24 Men');
  });
});
