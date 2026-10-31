/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The status line for an optimizer run in flight: plain-word progress and a
 * Cancel. Shared by the Optimize step and the Lineup step's one-click
 * "Optimize all teams", so both read the same.
 */

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@omniswim/ui';
import { describeOptimizeRun, type OptimizeRunState } from './optimizeRunView';

type OptimizeRunStatusProps = {
  run: OptimizeRunState;
  onCancel: () => void;
};

/**
 * What the coach sees while an optimizer run is in flight: plain-word progress and a Cancel. The
 * region is polite-live so a screen reader hears "Optimizing 3 of 12 teams" as it advances.
 */
export function OptimizeRunStatus({ run, onCancel }: OptimizeRunStatusProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2 flex flex-wrap items-center gap-3"
    >
      <RefreshCw size={14} className="animate-spin text-[var(--text-accent)] shrink-0" aria-hidden="true" />
      <span className="text-ui-body text-theme-secondary min-w-0 flex-1 break-words">
        {describeOptimizeRun(run)}
      </span>
      <Button variant="outline" size="sm" onClick={onCancel}>
        Cancel run
      </Button>
    </div>
  );
}
