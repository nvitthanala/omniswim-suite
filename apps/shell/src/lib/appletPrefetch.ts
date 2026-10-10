import { lazy } from 'react';

const prefetchers: Record<string, () => Promise<unknown>> = {
  manager: () => import('@omniswim/manager'),
  matrix: () => import('@omniswim/matrix'),
  metrics: () => import('@omniswim/metrics'),
};

const prefetched = new Set<string>();

export function prefetchApplet(id: keyof typeof prefetchers) {
  if (prefetched.has(id)) return;
  prefetched.add(id);
  void prefetchers[id]();
}

export function useAppletPrefetch() {
  return prefetchApplet;
}

/** Warm the most recently used applet after idle. */
export function prefetchLastApplet() {
  const last = localStorage.getItem('omni-last-applet');
  if (last === '/manager') prefetchApplet('manager');
  if (last === '/matrix') prefetchApplet('matrix');
  if (last === '/metrics') prefetchApplet('metrics');
}

export const ManagerAppLazy = lazy(() => import('@omniswim/manager'));
export const MatrixAppLazy = lazy(() => import('@omniswim/matrix'));
export const MetricsAppLazy = lazy(() => import('@omniswim/metrics'));

/** The "Build theoretical meet" dialog and the notice shown on a theoretical meet. Both come from the manager package. */
export const TheoreticalMeetDialogLazy = lazy(() => import('@omniswim/manager').then(m => ({ default: m.TheoreticalMeetDialog })));
export const TheoreticalMeetBannerLazy = lazy(() => import('@omniswim/manager').then(m => ({ default: m.TheoreticalMeetBanner })));
