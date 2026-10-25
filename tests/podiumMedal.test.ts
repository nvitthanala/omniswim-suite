// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * E18: the podium medal is derived from the swimmer's place. Place 1, 2 and 3 get
 * gold, silver and bronze with an accessible label. Any other place, an absent
 * place, and a swim that has no podium (prelim, consolation final, exhibition,
 * time trial) render nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Gender } from '../packages/core/src/types';
import type { SwimmerResult } from '../packages/core/src/types';
import { THEORETICAL_MEET_LABEL } from '../packages/core/src/lib/theoreticalMeetLabel';
import { PodiumMedal, podiumPlaceOf } from '../packages/matrix/src/components/TeamCardParts';
import { TooltipSwimmerRow } from '../packages/matrix/src/components/TeamCardTooltips';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaceState = vi.hoisted(() => ({ active: null as unknown }));

vi.mock('@omniswim/core/store/SuiteWorkspaceProvider', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSuiteWorkspaceOptional: () => (workspaceState.active ? { activeWorkspace: workspaceState.active } : null),
}));

afterEach(() => {
  document.body.innerHTML = '';
  workspaceState.active = null;
});

function mount(node: Parameters<ReturnType<typeof createRoot>['render']>[0]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return container;
}

const row = (over: Partial<SwimmerResult>): SwimmerResult =>
  ({
    id: 'r1',
    rank: 1,
    name: 'Test Swimmer',
    classYear: 'SR',
    team: 'Henderson State University',
    time: '1:45.08',
    points: 20,
    event: '100 Free',
    gender: Gender.MEN,
    ...over,
  }) as SwimmerResult;

describe('PodiumMedal', () => {
  it.each([
    [1, '1st place', '--ui-medal-gold'],
    [2, '2nd place', '--ui-medal-silver'],
    [3, '3rd place', '--ui-medal-bronze'],
  ])('place %i renders a labelled medal in a theme token', (place, label, token) => {
    const c = mount(createElement(PodiumMedal, { place }));
    const medal = c.querySelector('[role="img"]');
    expect(medal?.getAttribute('aria-label')).toBe(label);
    expect((medal as HTMLElement).style.color).toBe(`var(${token})`);
    expect(c.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it.each([[undefined], [null], [0], [4], [9], [-1]])('place %s renders nothing', place => {
    const c = mount(createElement(PodiumMedal, { place }));
    expect(c.innerHTML).toBe('');
  });

  it('still honours the older podium prop when no place is given', () => {
    const c = mount(createElement(PodiumMedal, { podium: 'silver' }));
    expect(c.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('2nd place');
  });
});

describe('podiumPlaceOf', () => {
  it('reads the recorded rank of a final', () => {
    expect(podiumPlaceOf(row({ rank: 1, roundSwam: 'A Final' }))).toBe(1);
    expect(podiumPlaceOf(row({ rank: 3, roundSwam: 'Finals' }))).toBe(3);
    expect(podiumPlaceOf(row({ rank: 2 }))).toBe(2);
    expect(podiumPlaceOf(row({ rank: '3' as unknown as number }))).toBe(3);
  });

  it('gives nothing for a place off the podium or no place', () => {
    expect(podiumPlaceOf(row({ rank: 4 }))).toBeUndefined();
    expect(podiumPlaceOf(row({ rank: 0 }))).toBeUndefined();
    expect(podiumPlaceOf(row({ rank: undefined as unknown as number }))).toBeUndefined();
  });

  it('gives nothing to a swim whose rank does not decide the podium', () => {
    expect(podiumPlaceOf(row({ rank: 1, roundSwam: 'Prelims' }))).toBeUndefined();
    expect(podiumPlaceOf(row({ rank: 1, roundSwam: 'B Final' }))).toBeUndefined();
    expect(podiumPlaceOf(row({ rank: 1, roundSwam: 'C Final' }))).toBeUndefined();
    expect(podiumPlaceOf(row({ rank: 1, roundSwam: 'Time Trial' }))).toBeUndefined();
    expect(podiumPlaceOf(row({ rank: 1, isExhibition: true }))).toBeUndefined();
    expect(podiumPlaceOf(row({ rank: 1, isTimeTrial: true }))).toBeUndefined();
    // A recruit row's rank is a projection, not a finish.
    expect(podiumPlaceOf(row({ rank: 1, isRecruit: true }))).toBeUndefined();
  });
});

describe('TooltipSwimmerRow medal', () => {
  const props = { gender: Gender.MEN, teamName: 'Henderson State University' };

  it('shows a medal on a first-place row of a real meet, with no podium field set on the row', () => {
    workspaceState.active = { loadedMeet: { pdfFilename: 'meet.pdf', uploadedAt: 1, meetLabel: 'NSISC Champs' } };
    const real = mount(createElement(TooltipSwimmerRow, { ...props, s: row({ rank: 1 }) }));
    expect(real.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('1st place');
    workspaceState.active = null;
  });

  it('shows a medal on a first-place row outside a provider', () => {
    const c = mount(createElement(TooltipSwimmerRow, { ...props, s: row({ rank: 1 }) }));
    expect(c.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('1st place');
  });

  it('shows no medal on a recruit row, whose rank is projected', () => {
    const c = mount(createElement(TooltipSwimmerRow, { ...props, s: row({ rank: 1, isRecruit: true }) }));
    expect(c.querySelector('[role="img"]')).toBeNull();
  });

  it('shows no medal in a theoretical meet, which nobody swam', () => {
    workspaceState.active = { loadedMeet: { pdfFilename: 'x', uploadedAt: 1, meetLabel: THEORETICAL_MEET_LABEL } };
    const c = mount(createElement(TooltipSwimmerRow, { ...props, s: row({ rank: 1 }) }));
    expect(c.querySelector('[role="img"]')).toBeNull();
  });

  it('shows no medal on a fifth-place row', () => {
    const c = mount(createElement(TooltipSwimmerRow, { ...props, s: row({ rank: 5 }) }));
    expect(c.querySelector('[role="img"]')).toBeNull();
  });
});
