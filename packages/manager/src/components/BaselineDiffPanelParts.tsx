/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Sub-components for BaselineDiffPanel.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@omniswim/ui';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { ScenarioDiffView } from './ScenarioDiffView';
import type { DiffViewState } from './baselineDiffView';

export function DiffToggleButton({
  loading,
  expanded,
  disabled,
  onClick,
}: {
  loading: boolean;
  expanded: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled} className="px-2.5 py-1.5">
      {loading ? (
        <>
          <Loader2 size={12} className="animate-spin" />
          Calculating…
        </>
      ) : expanded ? (
        'Hide changes'
      ) : (
        'Show changes from the loaded meet'
      )}
    </Button>
  );
}

/** The panel body below the toggle button — one of the mutually exclusive
 * view states resolved by resolveDiffViewState. */
export function DiffPanelBody({
  state,
  result,
}: {
  state: DiffViewState;
  result: ScenarioDiffResult | null;
}) {
  if (state === 'no-team') {
    return (
      <p className="text-ui-caption text-theme-secondary leading-relaxed mt-2.5">
        Choose a team above to compare it against the loaded meet.
      </p>
    );
  }
  if (state === 'calculating') {
    return (
      <p className="text-ui-caption text-theme-muted flex items-center gap-1.5 mt-2.5">
        <Loader2 size={12} className="animate-spin" />
        Calculating changes…
      </p>
    );
  }
  if (state === 'result' && result) {
    return (
      <ScenarioDiffView
        result={result}
        emptyMessage="No differences — the working copy matches the loaded meet."
      />
    );
  }
  return null;
}
