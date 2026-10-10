// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Click-to-edit time cells and the pinned-tooltip close control must be
 * real buttons with aria-labels, not clickable divs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SwimmerResult } from '@omniswim/core/types';
import { TeamMatrixTimeCell } from '../packages/matrix/src/components/TeamCardMatrixRow';
import { TeamCardChartTooltip } from '../packages/matrix/src/components/TeamCardTooltips';
import type { TeamRowCutlineTags } from '../packages/matrix/src/components/teamCardView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW_TAGS: TeamRowCutlineTags = {
  kind: 'single',
  result: { status: 'no_cut' },
} as TeamRowCutlineTags;

describe('TeamCard clickable controls are buttons', () => {
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

  it('renders the plain time as a button with an aria-label', async () => {
    const res = {
      id: 'r1',
      name: 'Alex',
      time: '48.12',
      event: '100 Free',
      gender: 'M',
    } as SwimmerResult;
    const onStartEdit = vi.fn();

    await act(async () => {
      root.render(
        createElement(TeamMatrixTimeCell, {
          res,
          rowTags: ROW_TAGS,
          timeColorClass: 'text-[var(--text-primary)]',
          relaySplitPrimary: null,
          onStartEdit,
          editingResultId: null,
          editValue: '',
          onEditValueChange: vi.fn(),
          onCancelEdit: vi.fn(),
        })
      );
    });

    const btn = container.querySelector('button[aria-label="Edit time"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.type).toBe('button');
    expect(btn.textContent).toContain('48.12');

    await act(async () => {
      btn.click();
    });
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it('renders the finals time as a button with an aria-label', async () => {
    const res = {
      id: 'r2',
      name: 'Alex',
      time: '48.12',
      finalsTime: '47.90',
      event: '100 Free',
      gender: 'M',
    } as SwimmerResult;

    await act(async () => {
      root.render(
        createElement(TeamMatrixTimeCell, {
          res,
          rowTags: ROW_TAGS,
          timeColorClass: 'text-[var(--text-primary)]',
          relaySplitPrimary: null,
          onStartEdit: vi.fn(),
          editingResultId: null,
          editValue: '',
          onEditValueChange: vi.fn(),
          onCancelEdit: vi.fn(),
        })
      );
    });

    const btn = container.querySelector('button[aria-label="Edit final time"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.type).toBe('button');
    expect(btn.textContent).toContain('Final: 47.90');
  });

  it('renders the pinned tooltip close control as a button', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        createElement(TeamCardChartTooltip, {
          data: { name: 'Freshman', points: 12, swimmers: [] },
          isPinned: true,
          isClass: true,
          gender: 'M',
          teamName: 'Test',
          onClose,
        })
      );
    });

    const btn = container.querySelector('button[aria-label="Close tooltip"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.type).toBe('button');

    await act(async () => {
      btn.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
