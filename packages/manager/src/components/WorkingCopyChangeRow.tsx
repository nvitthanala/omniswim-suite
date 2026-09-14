/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One row of WorkingCopyChangesPanel's revertible-edits list. Split out so
 * the per-kind label/warning branching lives in one small component instead
 * of the panel's `.map()` closure.
 */

import React from 'react';
import { Undo2 } from 'lucide-react';
import type { RevertibleChange } from '@omniswim/core/lib/workingCopyChanges';
import { changeRowAriaLabel, changeRowButtonText, canRevertChange } from './workingCopyChangesView';

type Props = {
  change: RevertibleChange;
  disabled?: boolean;
  onRevert: () => void;
};

function UnrestorableWarning({ change }: { change: RevertibleChange }) {
  if (change.kind !== 'removal' || change.fullyRestorable) return null;
  return (
    <p className="text-ui-caption text-amber-500 mt-0.5">
      Original rows are no longer recoverable — reverting will only clear the removal marker, not
      bring back this athlete&apos;s swims.
    </p>
  );
}

export default function WorkingCopyChangeRow({ change, disabled, onRevert }: Props) {
  const canRevert = canRevertChange(change);
  const title =
    change.kind === 'removal' && !change.fullyRestorable
      ? "This athlete's original rows can no longer be rebuilt; only the removal marker will be cleared."
      : undefined;

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-theme-soft surface-muted-bg px-3 py-2">
      <div className="min-w-0">
        <p className="text-ui-body font-medium text-[var(--text-primary)] truncate">{change.label}</p>
        <p className="text-ui-caption text-theme-secondary mt-0.5">{change.detail}</p>
        <UnrestorableWarning change={change} />
      </div>
      <button
        type="button"
        disabled={disabled || !canRevert}
        aria-label={changeRowAriaLabel(change)}
        title={title}
        className="flex items-center gap-1.5 text-ui-caption text-[var(--text-accent)] hover:underline shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline disabled:text-theme-muted"
        onClick={() => {
          if (disabled) return;
          onRevert();
        }}
      >
        <Undo2 size={12} />
        {changeRowButtonText(change)}
      </button>
    </li>
  );
}
