// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "Let time trials fill relay legs" control (`relayLegsAllowTimeTrials`,
 * user decision D9) in the two scoring panels that carry the entry-cap policy
 * checkboxes: `ScoringCapsFields` (Matrix, shell scoring dialog) and
 * `EntryCapPolicyFields` (manager). Each panel must render it unchecked when the
 * setting is absent, reflect an explicit true, and report a change as a patch.
 *
 * Written without JSX, like every other DOM-render test in this repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import type { ScoringSettings } from '@omniswim/core/types';
import { ScoringCapsFields } from '@omniswim/matrix/components/ScoringCapsFields';
import { EntryCapPolicyFields } from '../packages/manager/src/components/RosterScoringSetupParts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABEL = 'Let time trials fill relay legs';
const HELPER =
  "Off by default. A time trial is outside the meet's program. A leg filled from one is marked Time trial.";

const BASE = mergeScoringSettings({ scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11] });

describe.each([
  [
    'ScoringCapsFields',
    (settings: ScoringSettings, onPatch: (p: Partial<ScoringSettings>) => void) =>
      createElement(ScoringCapsFields, {
        local: settings,
        update: onPatch,
        lock: { message: null, isLocked: () => false, lockProps: () => ({}) },
      }),
  ],
  [
    'EntryCapPolicyFields',
    (settings: ScoringSettings, onPatch: (p: Partial<ScoringSettings>) => void) =>
      createElement(EntryCapPolicyFields, { settings, onChange: onPatch }),
  ],
] as const)('%s relay-leg time-trial control', (_name, make) => {
  let container: HTMLDivElement;
  let root: Root;
  let patches: Array<Partial<ScoringSettings>>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    patches = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function render(settings: ScoringSettings) {
    await act(async () => {
      root.render(make(settings, p => patches.push(p)));
    });
  }

  /** The checkbox whose label text is the control's name. */
  function control(): HTMLInputElement {
    const label = [...container.querySelectorAll('label')].find(l => l.textContent?.trim() === LABEL);
    const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error(`no checkbox labelled "${LABEL}"`);
    return input;
  }

  it('renders the labelled checkbox, unchecked when the setting is absent', async () => {
    await render(BASE);
    expect(BASE.relayLegsAllowTimeTrials).toBeUndefined();
    expect(control().checked).toBe(false);
  });

  it('shows an explicit true as checked and an explicit false as unchecked', async () => {
    await render({ ...BASE, relayLegsAllowTimeTrials: true });
    expect(control().checked).toBe(true);
    await render({ ...BASE, relayLegsAllowTimeTrials: false });
    expect(control().checked).toBe(false);
  });

  it('describes itself with the helper text', async () => {
    await render(BASE);
    const helperId = control().getAttribute('aria-describedby');
    expect(helperId).toBeTruthy();
    expect(container.querySelector(`[id="${helperId}"]`)?.textContent).toBe(HELPER);
  });

  it('fires onChange with only relayLegsAllowTimeTrials, true then false', async () => {
    await render(BASE);
    await act(async () => {
      control().click();
    });
    expect(patches).toStrictEqual([{ relayLegsAllowTimeTrials: true }]);

    patches.length = 0;
    await render({ ...BASE, relayLegsAllowTimeTrials: true });
    await act(async () => {
      control().click();
    });
    expect(patches).toStrictEqual([{ relayLegsAllowTimeTrials: false }]);
  });

  it('is keyboard reachable: a native checkbox, not disabled, no negative tabindex', async () => {
    await render(BASE);
    const input = control();
    expect(input.disabled).toBe(false);
    expect(input.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it('leaves the entry-cap checkboxes in place and independent', async () => {
    await render(BASE);
    const names = [...container.querySelectorAll('label')].map(l => l.textContent?.trim());
    expect(names).toContain('Time trials count toward the entry cap');
    expect(names).toContain('Exhibition swims count toward the entry cap');
    expect(names).toContain(LABEL);
  });
});
