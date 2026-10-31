/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workspace sidebar collapse state.
 *
 * The user's choice (the toggle button) is stored in localStorage under
 * `omni-sidebar-collapsed`. Below the lg breakpoint (1024px) the sidebar also
 * collapses on its own so the page keeps its width. That automatic collapse is
 * never written to storage: widen the window again and the saved choice is back.
 * Opening the sidebar on a narrow screen is a temporary override for that visit
 * to the narrow layout.
 */

import { useCallback, useEffect, useState } from 'react';

export const SIDEBAR_STORAGE_KEY = 'omni-sidebar-collapsed';
/** Tailwind's `lg`. Below this width the sidebar collapses by itself. */
export const SIDEBAR_AUTO_COLLAPSE_BELOW_PX = 1024;
const NARROW_QUERY = `(max-width: ${SIDEBAR_AUTO_COLLAPSE_BELOW_PX - 0.02}px)`;

/** The stored choice. Anything but the string "true" means expanded. */
export function readSidebarPreference(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Whether the sidebar shows collapsed, given the saved choice and the window width. */
export function resolveSidebarCollapsed(state: {
  preference: boolean;
  narrow: boolean;
  /** The user opened the sidebar while the window was narrow. */
  narrowOpen: boolean;
}): boolean {
  return state.narrow ? !state.narrowOpen : state.preference;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

export function useSidebarCollapse(): {
  collapsed: boolean;
  /** True while the automatic collapse is in effect (window below lg). */
  narrow: boolean;
  toggle: () => void;
} {
  const [preference, setPreference] = useState(() => readSidebarPreference(browserStorage()));
  const [narrow, setNarrow] = useState(isNarrow);
  const [narrowOpen, setNarrowOpen] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NARROW_QUERY);
    const sync = () => {
      setNarrow(query.matches);
      // A temporary open does not outlive the narrow layout.
      if (!query.matches) setNarrowOpen(false);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const toggle = useCallback(() => {
    if (narrow) {
      // Do not touch the stored choice: this is not the user's preference.
      setNarrowOpen(value => !value);
      return;
    }
    const next = !preference;
    setPreference(next);
    try {
      browserStorage()?.setItem(SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      // Storage can be blocked; the toggle still works for this visit.
    }
  }, [narrow, preference]);

  return { collapsed: resolveSidebarCollapsed({ preference, narrow, narrowOpen }), narrow, toggle };
}
