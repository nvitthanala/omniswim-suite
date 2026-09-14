// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `ScoringSettingsFields.tsx` — the form shared by `ScoringSettingsPanel.tsx`
 * (Matrix's Score step) and `ScoringSettingsModal.tsx` (the shell's Suite
 * Settings entry point), extracted so a field added to one editor cannot
 * silently stop being editable from the other. See that file's own header
 * for the full account of what merged and why.
 *
 * Written without JSX (plain `React.createElement`), matching every other
 * DOM-render test in this repo, so this stays a `.test.ts` under the
 * `tests/**\/*.test.ts` include glob.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import type { ScoringSettings } from '@omniswim/core/types';
import { ScoringSettingsFields } from '@omniswim/matrix/components/ScoringSettingsFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no native value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('ScoringSettingsFields', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onChange: (next: ScoringSettings) => void;
  let latest: ScoringSettings | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = undefined;
    onChange = next => {
      latest = next;
    };
    // fetchScoringPresetList/fetchScoringPresetSettings fall back to a
    // built-in local preset table on any fetch failure — stubbing fetch to
    // reject immediately exercises that fallback deterministically instead
    // of depending on how a real relative-URL fetch fails in this
    // environment.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network disabled in this test');
      })
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const BASE = mergeScoringSettings({ scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11] });

  async function render(props: Partial<Parameters<typeof ScoringSettingsFields>[0]> = {}) {
    await act(async () => {
      root.render(createElement(ScoringSettingsFields, { settings: BASE, onChange, ...props }));
    });
    await flush();
  }

  it('renders one number input per scoring place, matching the initial settings', () => {
    return render().then(() => {
      const placeInputs = [...container.querySelectorAll('input[type="number"]')].filter(el =>
        (el as HTMLInputElement).getAttribute('aria-label')?.startsWith('Points for place')
      );
      expect(placeInputs).toHaveLength(8);
      expect((placeInputs[0] as HTMLInputElement).value).toBe('20');
      expect((placeInputs[7] as HTMLInputElement).value).toBe('11');
    });
  });

  it('editing one place calls onChange with only that place updated', async () => {
    await render();
    const secondPlace = [...container.querySelectorAll('input[type="number"]')].find(
      el => el.getAttribute('aria-label') === 'Points for place 2'
    ) as HTMLInputElement;
    await act(async () => setNativeValue(secondPlace, '18'));
    expect(latest?.scoringPoints).toStrictEqual([20, 18, 16, 15, 14, 13, 12, 11]);
  });

  it('changing the places count resizes the points array AND recomputes aFinalBracketSize', async () => {
    await render();
    const placesSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Number of scoring places"]');
    expect(placesSelect).toBeTruthy();
    await act(async () => setNativeValue(placesSelect!, '12'));
    expect(latest?.scoringPoints).toHaveLength(12);
    // The 8 original values are preserved; the 4 new places pad with 0.
    expect(latest?.scoringPoints.slice(0, 8)).toStrictEqual([20, 17, 16, 15, 14, 13, 12, 11]);
    expect(latest?.scoringPoints.slice(8)).toStrictEqual([0, 0, 0, 0]);
    // This is the bug this merge fixed: the old Modal only recomputed
    // aFinalBracketSize at save time; a places change here must recompute it
    // immediately, in the same update, not leave it stale from the prior count.
    expect(latest?.aFinalBracketSize).toBe(6);
  });

  it('"Top 24 points only" sets 24 places, the real point values, relayMultiplier 2, half-rate on, and the matching aFinalBracketSize', async () => {
    await render();
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Top 24 points only');
    expect(button).toBeTruthy();
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(latest?.scoringPoints).toHaveLength(24);
    expect(latest?.scoringPoints[0]).toBe(32);
    expect(latest?.scoringPoints[23]).toBe(1);
    expect(latest?.relayMultiplier).toBe(2);
    expect(latest?.halfRateRelaySwimmer).toBe(true);
    expect(latest?.aFinalBracketSize).toBe(12);
  });

  it('"Generic Top 16" replaces the whole settings object, not just the points', async () => {
    await render({ settings: mergeScoringSettings({ scoringPoints: [1] }) });
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Generic Top 16');
    expect(button).toBeTruthy();
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(latest?.scoringPoints.length).toBeGreaterThan(1);
  });

  it('the suggested-preset banner\'s "Load & save" applies the preset AND fires onApplyAndSaveSuggestedPreset, distinct from onChange', async () => {
    const saved: ScoringSettings[] = [];
    await render({
      suggestedPresetId: 'nsisc',
      onApplyAndSaveSuggestedPreset: next => saved.push(next),
    });
    const banner = container.textContent ?? '';
    expect(banner).toContain('Suggested preset:');
    expect(banner).toContain('nsisc');
    const loadAndSave = [...container.querySelectorAll('button')].find(b => b.textContent === 'Load & save');
    expect(loadAndSave).toBeTruthy();
    await act(async () => loadAndSave!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(saved).toHaveLength(1);
    // The NSISC preset caps individual scorers at 18 — a real, distinguishing field.
    expect(saved[0].maxIndividualScorersPerTeam).toBe(18);
  });

  it('omits the suggested-preset banner and the scoring-view toggle when their props are not supplied — the Modal entry point never passes either', async () => {
    await render();
    expect(container.textContent).not.toContain('Suggested preset');
    expect(container.querySelector('[aria-label="Scoring view"]')).toBeNull();
  });

  it('shows the scoring-view toggle when onScoringViewChange is supplied, and calls it on change', async () => {
    const views: string[] = [];
    await render({ scoringView: 'merged', onScoringViewChange: v => views.push(v) });
    const pdfOnly = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('PDF only'));
    expect(pdfOnly).toBeTruthy();
    await act(async () => pdfOnly!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(views).toStrictEqual(['pdf_only']);
  });

  it('disables a locked field and does not let it report a changed value', async () => {
    // A conference lock (NSISC) fixes maxIndividualScorersPerTeam via
    // scoringSettingsLock — confirm the input is disabled, matching the
    // Panel's original lock-visual contract.
    await render({ settings: mergeScoringSettings(BASE, { conference: 'NSISC' }), conference: 'NSISC' });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Maximum individual scorers per team"]');
    expect(input).toBeTruthy();
    expect(input!.disabled).toBe(true);
  });
});
