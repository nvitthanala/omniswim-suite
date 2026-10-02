// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ScoringSettingsModal must use the shared Modal so it gets role="dialog",
 * aria-modal, aria-label, and Escape-to-close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import ScoringSettingsModal from '../packages/matrix/src/components/ScoringSettingsModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ScoringSettingsModal accessibility', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: () => void;
  let onSave: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn();
    onSave = vi.fn();
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

  it('renders as a dialog with aria-modal and Escape closes it', async () => {
    const settings = mergeScoringSettings({ scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11] });

    await act(async () => {
      root.render(
        createElement(ScoringSettingsModal, {
          settings,
          onSave,
          onClose,
        })
      );
    });
    await flush();

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Scoring Matrix Configuration');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
