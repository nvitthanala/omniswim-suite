// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ScenarioDiffView (the one-snapshot "Then → Now" panel) shows a side that has
 * no entry as a dash, never "0.0". `computeScenarioDiff` reports an absent side
 * as 0 points and sets `inThen` / `inNow`; the view reads those flags through
 * the helpers in scenarioCompareView.
 *
 * Break it: print `pointsThen.toFixed(1)` in the view and these cases fail.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender } from '@omniswim/core/types';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { ScenarioDiffView } from '../packages/manager/src/components/ScenarioDiffView';
import { ABSENT_LABEL } from '../packages/manager/src/components/scenarioCompareView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(result: ScenarioDiffResult): string {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ScenarioDiffView, { result, emptyMessage: 'Nothing changed.' }));
  });
  return container.textContent ?? '';
}

const swimmer = (
  name: string,
  over: Partial<ScenarioDiffResult['swimmers'][number]>
): ScenarioDiffResult['swimmers'][number] => ({
  name,
  isRelay: false,
  eventsAdded: [],
  eventsRemoved: [],
  eventsChanged: [],
  pointsThen: 0,
  pointsNow: 0,
  deltaPoints: 0,
  inThen: true,
  inNow: true,
  ...over,
});

describe('ScenarioDiffView with an absent side', () => {
  it('shows a dash for a total the side does not have', () => {
    const text = render({
      team: 'Henderson State',
      gender: Gender.MEN,
      totals: { then: 0, now: 15, delta: 15, inThen: false, inNow: true },
      swimmers: [],
      events: [],
    });
    expect(text).toContain(`Then ${ABSENT_LABEL} → Now 15.0`);
    expect(text).not.toContain('0.0');
  });

  it('shows a dash for both totals when neither side has the team, with no change figure', () => {
    const text = render({
      team: 'Henderson State',
      gender: Gender.MEN,
      totals: { then: 0, now: 0, delta: 0, inThen: false, inNow: false },
      swimmers: [],
      events: [],
    });
    expect(text).toContain(`Then ${ABSENT_LABEL} → Now ${ABSENT_LABEL}`);
    expect(text).not.toContain('0.0');
    expect(text).not.toContain('+0.0');
  });

  it('shows a dash and a status word for an added or removed swimmer and event', () => {
    const text = render({
      team: 'Henderson State',
      gender: Gender.MEN,
      totals: { then: 5, now: 8, delta: 3, inThen: true, inNow: true },
      swimmers: [
        swimmer('New Nat', { pointsNow: 5, deltaPoints: 5, inThen: false, inNow: true }),
        swimmer('Gone Gus', { pointsThen: 2, deltaPoints: -2, inThen: true, inNow: false }),
        swimmer('Zero Zed', { pointsThen: 3, pointsNow: 0, deltaPoints: -3 }),
      ],
      events: [
        { event: '100 Back', pointsThen: 4, pointsNow: 0, delta: -4, swimmersChanged: 1, inThen: true, inNow: false },
        { event: '50 Free', pointsThen: 0, pointsNow: 6, delta: 6, swimmersChanged: 1, inThen: false, inNow: true },
      ],
    });
    expect(text).toContain(`New Nat (Added)${ABSENT_LABEL}→5.0`);
    expect(text).toContain(`Gone Gus (Removed)2.0→${ABSENT_LABEL}`);
    // A swimmer both sides hold keeps a real 0.0.
    expect(text).toContain('Zero Zed3.0→0.0');
    expect(text).not.toMatch(/Zero Zed \(/);
    expect(text).toContain(`100 Back (Removed)4.0→${ABSENT_LABEL}`);
    expect(text).toContain(`50 Free (Added)${ABSENT_LABEL}→6.0`);
  });
});
