// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * X3: an error toast is announced with role="alert"; success and info keep
 * role="status". The auto-dismiss timer is cleared on dismiss and on unmount.
 *
 * Why the timer matters: a timer that outlives the provider calls setState on
 * an unmounted tree. After a test environment is torn down React reads the
 * global `window` there and throws "window is not defined", which made
 * `npx vitest run` exit 1 on some runs (tests/optimizerUndoTrackA.test.ts and
 * tests/optimizeStepReviewFixes.test.ts left a 4 to 7 second timer pending).
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastKind } from '@omniswim/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let pushToast: ((kind: ToastKind, message: string) => string) | null = null;

function Pusher() {
  const toast = useToast();
  pushToast = (kind, message) => toast.push(kind, message);
  return null;
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ToastProvider, null, createElement(Pusher)));
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  unmount();
  pushToast = null;
  vi.restoreAllMocks();
});

const toastItem = (text: string) =>
  [...document.body.querySelectorAll('.toast-item')].find(el => el.textContent?.includes(text)) as
    | HTMLElement
    | undefined;

describe('toast roles', () => {
  it('announces an error with role="alert"', () => {
    act(() => {
      pushToast!('error', 'Save failed');
    });
    expect(toastItem('Save failed')?.getAttribute('role')).toBe('alert');
  });

  it('keeps role="status" for success and info', () => {
    act(() => {
      pushToast!('success', 'Saved');
      pushToast!('info', 'Heads up');
    });
    expect(toastItem('Saved')?.getAttribute('role')).toBe('status');
    expect(toastItem('Heads up')?.getAttribute('role')).toBe('status');
  });
});

describe('toast auto-dismiss timer', () => {
  /** The id and delay of the timer `push` set: the one with a 4000 or 7000 ms delay. */
  function pushAndFindTimer(kind: ToastKind, message: string, delay: number) {
    const setSpy = vi.spyOn(window, 'setTimeout');
    act(() => {
      pushToast!(kind, message);
    });
    const index = setSpy.mock.calls.findIndex(call => call[1] === delay);
    expect(index, `a ${delay} ms timer was set`).toBeGreaterThanOrEqual(0);
    return setSpy.mock.results[index]!.value as number;
  }

  it('is cleared when the provider unmounts', () => {
    const timerId = pushAndFindTimer('error', 'Will unmount', 7000);
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(timerId);
  });

  it('is cleared when the toast is dismissed by hand', () => {
    const timerId = pushAndFindTimer('info', 'Dismiss me', 4000);
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    const close = toastItem('Dismiss me')!.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement;
    act(() => {
      close.click();
    });
    expect(clearSpy).toHaveBeenCalledWith(timerId);
  });

  it('still removes the toast when the timer is left to fire', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        pushToast!('success', 'Goes away');
      });
      expect(toastItem('Goes away')).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      // The exit transition keeps the toast mounted for one more beat.
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(toastItem('Goes away')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
