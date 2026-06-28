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
