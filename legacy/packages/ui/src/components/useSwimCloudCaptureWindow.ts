/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s floating-window state: the remembered position
 * and size, and the Escape-to-close key handler. Pure extraction from
 * `SwimCloudCaptureBrowser.tsx` — no behaviour change.
 */

import { useEffect, useState } from 'react';
import type { FloatingWindowState } from './FloatingWindow';

export const MIN_WINDOW_WIDTH = 380;
export const MIN_WINDOW_HEIGHT = 320;

function defaultWindowState(): FloatingWindowState {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const w = Math.max(MIN_WINDOW_WIDTH, Math.min(680, vw - 64));
  const h = Math.max(MIN_WINDOW_HEIGHT, Math.min(640, vh - 96));
  return {
    x: Math.max(0, Math.round((vw - w) / 2)),
    y: Math.max(0, Math.round((vh - h) / 3)),
    w,
    h,
  };
}

/** Reads a remembered position, falling back to a centred default on anything unexpected. */
function loadWindowState(key: string): FloatingWindowState {
  const fallback = defaultWindowState();
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<FloatingWindowState>;
    return {
      x: typeof parsed.x === 'number' ? parsed.x : fallback.x,
      y: typeof parsed.y === 'number' ? parsed.y : fallback.y,
      w: typeof parsed.w === 'number' ? parsed.w : fallback.w,
      h: typeof parsed.h === 'number' ? parsed.h : fallback.h,
    };
  } catch {
    return fallback;
  }
}

/** Window geometry (persisted under `storageKey`) plus the Escape-closes handler. */
export function useSwimCloudCaptureWindow(storageKey: string, onClose: () => void) {
  const [windowState, setWindowState] = useState<FloatingWindowState>(() => loadWindowState(storageKey));

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(windowState));
    } catch {
      // A browser with site data blocked still gets a working window; it just
      // forgets where it was put.
    }
  }, [storageKey, windowState]);

  // Escape closes, the same way every dialog in this suite should. The window
  // is deliberately non-modal (it is draggable, and the page behind it stays
  // usable), so no focus trap is claimed and `aria-modal` is not set.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return { windowState, setWindowState };
}
