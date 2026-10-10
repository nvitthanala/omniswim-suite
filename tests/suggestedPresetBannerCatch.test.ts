// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SuggestedPresetBanner` "Load & save" in `ScoringSettingsFields`: when the
 * preset fetch rejects, nothing is applied or saved, nothing throws, no
 * rejection goes unhandled, and the console gets one warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { ScoringSettingsFields } from '@omniswim/matrix/components/ScoringSettingsFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('SuggestedPresetBanner Load & save', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network disabled in this test');
      })
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('swallows a rejected preset fetch: warns once, applies nothing, leaves the banner', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onApplyAndSave = vi.fn();
    const onChange = vi.fn();
    try {
      await act(async () => {
        root.render(
          createElement(ScoringSettingsFields, {
            settings: mergeScoringSettings({ scoringPoints: [20, 17, 16] }),
            onChange,
            suggestedPresetId: 'no-such-preset-id',
            onApplyAndSaveSuggestedPreset: onApplyAndSave,
          })
        );
      });
      const load = [...container.querySelectorAll('button')].find(b => b.textContent === 'Load & save');
      expect(load).toBeTruthy();
      await act(async () => {
        load!.click();
        await sleep(50);
      });
      // Node reports an unhandled rejection after the microtask queue drains.
      await sleep(50);

      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(onApplyAndSave).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Suggested preset: no-such-preset-id');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
