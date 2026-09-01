/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Sub-components for BaselineDiffPanel.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="btn-accent-outline rounded-md px-2.5 py-1.5 text-ui-caption font-semibold disabled:opacity-50"
    >
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
    </button>
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
