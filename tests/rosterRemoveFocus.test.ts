// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * After a confirmed Remove the athlete drawer closes because its athlete left the roster. The
 * drawer's Remove button unmounts, and Modal's focus return had already pointed at it, so focus
 * fell to <body>. TeamRosterPanel hands focus to the roster list (the one stable stop) when that
 * happens and focus is on <body>. It leaves focus alone when the coach put it somewhere real.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type SwimmerResult, type Workspace } from '@omniswim/core/types';
import TeamRosterPanel from '../packages/manager/src/components/TeamRosterPanel';
import { HOME_TEAM, buildMeetWorkspace, resolvedScoringSettings, scoringBundleFor } from './optimizerStepFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('focus after the drawer closes because its athlete was removed', () => {
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

  const ws = buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });
  const bundle = scoringBundleFor(ws, false);

  async function render(results: SwimmerResult[], scored: SwimmerResult[]) {
    await act(async () =>
      root.render(
        createElement(ToastProvider, null,
          createElement(TeamRosterPanel, {
            results, scoredResults: scored,
            settings: resolvedScoringSettings(ws), gender: Gender.MEN,
            overrides: [], onChangeOverrides: () => {}, editable: true,
            projectedByTeam: new Map(), baselineByTeam: new Map(),
            showTeamSidebar: false, teamPickerMode: 'dropdown', hideTeamSelect: true,
            selectedTeam: HOME_TEAM, workspace: ws as Workspace,
            onWorkspaceUpdate: () => {}, onRequestDeleteSwimmer: () => {},
          }))));
  }

  const removeButton = () =>
    Array.from(document.querySelectorAll('button')).find(b => /^Remove .* from roster$/.test(b.getAttribute('aria-label') ?? ''));

  async function openDrawer() {
    await render(bundle.allResults, bundle.allScored);
    const row = document.querySelector('[role="option"]') as HTMLElement;
    expect(row, 'a roster row').toBeTruthy();
    await act(async () => row.click());
    expect(removeButton(), 'drawer Remove button').toBeTruthy();
    const name = /^Remove (.*) from roster$/.exec(removeButton()!.getAttribute('aria-label')!)![1];
    return name;
  }

  const without = (rows: SwimmerResult[], name: string) => rows.filter(r => r.name !== name);

  it('moves focus from <body> to the roster list once the removed athlete is gone', async () => {
    const name = await openDrawer();
    // Modal's focus return put focus back on the drawer's Remove button.
    removeButton()!.focus();
    expect(document.activeElement).toBe(removeButton());

    await render(without(bundle.allResults, name), without(bundle.allScored, name));
    expect(removeButton()).toBeUndefined(); // the drawer closed with its athlete
    const list = document.querySelector('[role="listbox"]');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(list);
  });

  it('leaves focus alone when the coach has put it somewhere real', async () => {
    const name = await openDrawer();
    const other = document.createElement('button');
    other.textContent = 'elsewhere';
    document.body.appendChild(other);
    other.focus();
    await render(without(bundle.allResults, name), without(bundle.allScored, name));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('does not touch focus when the coach closes the drawer (the athlete is still listed)', async () => {
    await openDrawer();
    const other = document.createElement('button');
    other.textContent = 'elsewhere';
    document.body.appendChild(other);
    other.focus();
    const close = Array.from(document.querySelectorAll('button')).find(b => /close/i.test(b.getAttribute('aria-label') ?? ''));
    expect(close, 'drawer close button').toBeTruthy();
    // Focus the close control, then close: the drawer's own close handling is not this fix's job.
    other.focus();
    await act(async () => close!.click());
    expect(removeButton()).toBeUndefined();
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});
