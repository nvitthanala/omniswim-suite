// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * X2: FloatingWindow keyboard support. Focus moves in on open and returns on
 * close, Escape closes, arrow keys move the window, Shift plus arrows resize it,
 * and an accessible hint names the keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { elementWithChildren } from './helpers/elementWithChildren';
import { createRoot, type Root } from 'react-dom/client';
import { FloatingWindow, type FloatingWindowState } from '../packages/ui/src/components/FloatingWindow';
import { Modal } from '../packages/ui/src/components/Modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const START: FloatingWindowState = { x: 100, y: 100, w: 400, h: 300 };

describe('FloatingWindow keyboard support', () => {
  let container: HTMLDivElement;
  let root: Root;
  let opener: HTMLButtonElement;
  let onClose: () => void;
  let latest: FloatingWindowState;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    opener = document.createElement('button');
    opener.textContent = 'Open window';
    document.body.appendChild(opener);
    opener.focus();
    onClose = vi.fn();
    latest = START;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    opener.remove();
  });

  /** Holds `state` so a key press re-renders with the window's new geometry. */
  function Harness({ open, children }: { open: boolean; children?: unknown }) {
    const [state, setState] = useState(START);
    return elementWithChildren(
      FloatingWindow,
      {
        title: 'SwimCloud',
        open,
        onClose,
        state,
        onStateChange: (next: FloatingWindowState) => {
          latest = next;
          setState(next);
        },
      },
      createElement('input', { 'aria-label': 'Search' }),
      children as never
    );
  }

  async function render(open: boolean) {
    await act(async () => {
      root.render(createElement(Harness, { open }));
    });
  }

  const dialog = () => container.querySelector('[role="dialog"]') as HTMLElement;
  const header = () => container.querySelector('.floating-window-header') as HTMLElement;

  async function press(target: HTMLElement, key: string, shiftKey = false) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    });
  }

  it('moves focus to the title bar on open', async () => {
    await render(true);
    expect(document.activeElement).toBe(header());
    expect(dialog().getAttribute('aria-modal')).toBeNull();
  });

  it('names the keys in an accessible hint on the title bar', async () => {
    await render(true);
    const hintId = header().getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    const hint = document.getElementById(hintId!)?.textContent ?? '';
    expect(hint).toContain('arrow keys');
    expect(hint).toContain('Shift');
    expect(hint).toContain('Escape');
  });

  it('closes on Escape and gives focus back to the opener', async () => {
    await render(true);
    await press(header(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await render(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does not also close an open Modal that sits next to the window', async () => {
    const onModalClose = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          elementWithChildren(Modal, { onClose: onModalClose, ariaLabel: 'Settings' }, createElement('p', null, 'Body')),
          createElement(Harness, { open: true })
        )
      );
    });
    await press(header(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onModalClose).not.toHaveBeenCalled();
  });

  it('ignores Escape from outside the window', async () => {
    await render(true);
    await press(opener, 'Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves with the arrow keys and stays inside the viewport', async () => {
    await render(true);
    await press(header(), 'ArrowRight');
    expect(latest).toEqual({ ...START, x: 116 });
    await press(header(), 'ArrowDown');
    expect(latest).toEqual({ ...START, x: 116, y: 116 });
    await press(header(), 'ArrowLeft');
    await press(header(), 'ArrowUp');
    expect(latest).toEqual(START);
    for (let i = 0; i < 10; i += 1) await press(header(), 'ArrowLeft');
    expect(latest.x).toBe(0);
  });

  it('adds up key presses that arrive before the next render', async () => {
    await render(true);
    await act(async () => {
      for (let i = 0; i < 3; i += 1) {
        header().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      }
    });
    expect(latest.x).toBe(START.x + 48);
  });

  it('resizes with Shift plus the arrow keys and respects the minimum size', async () => {
    await render(true);
    await press(header(), 'ArrowRight', true);
    await press(header(), 'ArrowDown', true);
    expect(latest).toEqual({ ...START, w: 416, h: 316 });
    for (let i = 0; i < 40; i += 1) await press(header(), 'ArrowLeft', true);
    expect(latest.w).toBe(280);
    expect(latest.x).toBe(START.x);
  });

  it('leaves arrow keys alone inside the window body', async () => {
    await render(true);
    const input = container.querySelector('input') as HTMLInputElement;
    await press(input, 'ArrowRight');
    expect(latest).toEqual(START);
  });
});
