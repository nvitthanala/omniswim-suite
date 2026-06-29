/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Detects a stale browser module cache: pre–ChartShell bundles render
 * ResponsiveContainer at 100%×100% (blank charts). Prompts a hard reload.
 */
import { useEffect, useState } from 'react';

const CHART_BUILD_EPOCH = 2;

export default function ChartStaleBundleGuard() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const hasTimeline = Boolean(
        document.body.textContent?.includes('Chronological Team Score Timeline')
      );
      if (!hasTimeline) return;

      const shells = document.querySelectorAll('.chart-shell').length;
      const responsiveContainers = document.querySelectorAll('.recharts-responsive-container').length;
      const legacyH64 = document.querySelector('.h-64.w-full .recharts-responsive-container');

      if ((responsiveContainers > 0 && shells === 0) || legacyH64) {
        setStale(true);
      }
    }, 3500);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch('/api/dev/build-info')
      .then(r => (r.ok ? r.json() : null))
      .then(info => {
        if (info?.chartBuildEpoch != null && info.chartBuildEpoch !== CHART_BUILD_EPOCH) {
          setStale(true);
        }
      })
      .catch(() => undefined);
  }, []);

  if (!stale) return null;

  return (
    <div
      className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-ui-caption text-[var(--text-primary)]"
      role="status"
    >
      <p className="font-medium uppercase tracking-wide text-amber-300">
        Charts are using a stale cached bundle
      </p>
      <p className="mt-1 text-theme-secondary normal-case tracking-normal">
        The chart area loaded old JavaScript (blank border, no lines). Restart the dev server if you
        just pulled changes, then hard-refresh this page.
      </p>
      <button
        type="button"
        className="mt-3 px-3 py-1.5 rounded btn-accent-outline text-[10px] uppercase font-medium"
        onClick={() => {
          try {
            sessionStorage.setItem('omni-chart-reload', String(Date.now()));
          } catch {
            /* ignore */
          }
          window.location.reload();
        }}
      >
        Reload page
      </button>
    </div>
  );
}
