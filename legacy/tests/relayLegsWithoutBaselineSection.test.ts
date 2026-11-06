// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `RelayOptimizationSection` never says "all relay legs are already scoring-eligible" while the ranking
 * left a leg out because a swap on it cannot be priced (`RelayLegSwapRanking.legsWithoutBaseline`). It names
 * each skipped leg. The ranking comes from the REAL Henderson State 4x100 Free Relay of the 2026 NSISC
 * Championships (tests/fixtures/nsisc-2026-relay-followups-r1.json): Scott Doll's leg split is removed, his
 * 100 Free is flagged a time trial, and he is not a scorer. Written without JSX, like
 * `tests/relayOptimizationSectionInFromHistory.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender } from '@omniswim/core/types';
import type { SwimmerResult, Workspace } from '@omniswim/core/types';
import { NSISC_PRESET_SETTINGS } from '@omniswim/core/lib/scoringDefaults';
import { rankRelayLegSwaps } from '@omniswim/core/lib/crossCourseArbitrage';
import type { RelayLegSwapRanking, RelayLegWithoutBaseline } from '@omniswim/core/lib/crossCourseArbitrage';
import { RelayOptimizationSection } from '../packages/manager/src/components/crossCourseArbitrageRelaySection';
import { workspaceFixture } from '../../tests/helpers/typedFixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEAM = 'Henderson State University';
const EVENT = 'Event 42 Men 4x100 Yard Freestyle Relay';
const OUT = 'Scott Doll';
const DOLL_100 = '0b7ddcce-6648-4295-8c49-98a3c1fc3860';
const ALL_ELIGIBLE = 'all relay legs are already scoring-eligible';

type Row = SwimmerResult & Record<string, unknown>;
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../tests/fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: Row[]; womenResults: Row[] };

const STRICT = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules, includeRelayLegsInFinals: false },
};

function realRanking(): RelayLegSwapRanking {
  const men = fixture.menResults.map(r => {
    if (r.id === DOLL_100) return { ...r, isTimeTrial: true } as Row;
    const isDollLeg =
      r.isRelay === true && r.team === TEAM && r.event === EVENT && r.rank === 1 && r.relayLegIndex === 2;
    if (!isDollLeg) return r;
    const { relayLegSplit: _s, relayLegSplitDetail: _d, relayTeamSplits: _t, ...rest } = r;
    void _s;
    void _d;
    void _t;
    return rest as Row;
  });
  const ws: Workspace = workspaceFixture({
    id: 'w',
    name: 'w',
    createdAt: 0,
    menResults: men,
    womenResults: fixture.womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    conference: 'NSISC',
    scoringSettings: STRICT,
    scorerRosterOverrides: [{ name: OUT, team: TEAM, gender: Gender.MEN, isScorer: false }],
  });
  return rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: STRICT });
}

describe('RelayOptimizationSection with legs the ranking could not price', () => {
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

  async function render(relayRanking: RelayLegSwapRanking) {
    const groups = relayRanking.swaps.map(best => ({ best, otherCandidates: 0 }));
    await act(async () => {
      root.render(
        createElement(RelayOptimizationSection, {
          relayRanking,
          relaySwaps: groups,
          shownRelaySwaps: groups,
          relaySwapsExpanded: false,
          relaySwapsLimit: 10,
          onToggleExpanded: () => undefined,
          relayPromotions: [],
          lastApplied: null,
          onUndo: () => undefined,
          canApplySwaps: true,
          onApplyRelaySwap: () => undefined,
          onApplyRelayPromotion: () => undefined,
        })
      );
    });
  }

  it('the real ranking leaves the Doll leg out and names it', () => {
    const r = realRanking();
    expect(r.legsWithoutBaseline).toStrictEqual([
      expect.objectContaining({ relayEvent: EVENT, relayRank: 1, legIndex: 2, outAthlete: OUT }),
    ]);
  });

  it('names the skipped leg in plain words and never says all legs are eligible', async () => {
    const r = realRanking();
    // Only the unpriced leg is in play, so the section has nothing else to show.
    await render({ ...r, swaps: [] });
    const text = container.textContent ?? '';
    expect(text).not.toContain(ALL_ELIGIBLE);
    expect(text).toContain(
      `${OUT} on ${EVENT} leg 3 has no recorded split or usable swim, so a swap cannot be priced.`
    );
  });

  it('lists the skipped leg under a ranking that does have swaps', async () => {
    const r = realRanking();
    const withSwap = {
      ...r,
      swaps: [
        {
          relayEntryKey: 'k',
          relayEvent: '200 Free Relay',
          relayRank: 1,
          legIndex: 0,
          stroke: 'free' as const,
          legDistanceYards: 50,
          outAthlete: 'Someone',
          inAthlete: 'Else',
          inTime: '22.00',
          clockLegTime: '22.50',
          deltaPoints: 2,
          newTotal: 9,
          baseTotal: 7,
        },
      ],
    };
    await render(withSwap);
    const text = container.textContent ?? '';
    expect(text).not.toContain(ALL_ELIGIBLE);
    expect(text).toContain('has no recorded split or usable swim');
  });

  it('with nothing skipped and nothing to swap, it still says all legs are eligible', async () => {
    await render({ pointsMeaningful: true, swaps: [], candidatesEvaluated: 0 });
    expect(container.textContent).toContain(ALL_ELIGIBLE);
  });

  it('names several skipped legs, one line each', async () => {
    const legs: RelayLegWithoutBaseline[] = [
      { relayEntryKey: 'a', relayEvent: '200 Free Relay', relayRank: 1, legIndex: 0, outAthlete: 'Ann Lee' },
      { relayEntryKey: 'b', relayEvent: '400 Medley Relay', relayRank: 2, legIndex: 3, outAthlete: 'Bea Fox' },
    ];
    await render({ pointsMeaningful: true, swaps: [], candidatesEvaluated: 0, legsWithoutBaseline: legs });
    const items = [...container.querySelectorAll('li')].map(li => li.textContent);
    expect(items).toStrictEqual([
      'Ann Lee on 200 Free Relay leg 1 has no recorded split or usable swim, so a swap cannot be priced.',
      'Bea Fox on 400 Medley Relay leg 4 has no recorded split or usable swim, so a swap cannot be priced.',
    ]);
    expect(container.textContent).toContain('2 relay legs were not ranked');
  });
});
