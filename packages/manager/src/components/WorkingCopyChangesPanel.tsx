/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-edit revert panel for the Source step's working copy. Lists recruits
 * and soft removals individually (the only two categories with an
 * unambiguous revert unit) and shows the rest as counts pointing at their
 * own editors. See `listRevertibleChanges` / `countWorkingCopyChanges` in
 * @omniswim/core for the underlying data.
 */

import React, { useState } from 'react';
import type { Gender, Workspace } from '@omniswim/core/types';
import {
  countWorkingCopyChanges,
  listRevertibleChanges,
} from '@omniswim/core/lib/workingCopyChanges';
import WorkingCopyChangeRow from './WorkingCopyChangeRow';
import { changeRowKey, revertChangePatch } from './workingCopyChangesView';

type Props = {
  workspace: Workspace;
  gender: Gender;
  onUpdate: (patch: Partial<Workspace>) => void;
  disabled?: boolean;
};

export default function WorkingCopyChangesPanel({ workspace, gender, onUpdate, disabled }: Props) {
  // Collapsed by default. A real workspace can hold dozens of recruits, and one
  // Revert button each would dominate the step — the Source screen went from 31
  // to 70 visible controls when this list rendered expanded, which is precisely
  // the density problem the stepped-wizard work exists to reduce.
  const [expanded, setExpanded] = useState(false);
  const changes = listRevertibleChanges(workspace, gender);
  const counts = countWorkingCopyChanges(workspace, gender);

  const nonRevertible: { label: string; count: number }[] = [
    { label: 'manual roster flags', count: counts.rosterOverrides },
    { label: 'relay leg overrides', count: counts.relayLegOverrides },
    { label: 'planned entries', count: counts.plannedEntries },
  ].filter(c => c.count > 0);

  if (changes.length === 0 && nonRevertible.length === 0) return null;

  return (
    <section className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Working copy edits</h4>
        {changes.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(value => !value)}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? 'Hide the list of revertible working copy edits'
                : `Show ${changes.length} revertible working copy ${changes.length === 1 ? 'edit' : 'edits'}`
            }
            className="btn-accent-outline rounded-md px-2.5 py-1.5 text-ui-caption font-semibold shrink-0"
          >
            {expanded
              ? 'Hide edits'
              : `Show ${changes.length} ${changes.length === 1 ? 'edit' : 'edits'}`}
          </button>
        ) : null}
      </div>

      {changes.length > 0 && expanded ? (
        <ul className="mt-3 flex flex-col gap-2">
          {changes.map(change => (
            <WorkingCopyChangeRow
              key={changeRowKey(change)}
              change={change}
              disabled={disabled}
              onRevert={() => onUpdate(revertChangePatch(workspace, gender, change))}
            />
          ))}
        </ul>
      ) : null}

      {nonRevertible.length > 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed mt-3">
          {nonRevertible.map(c => `${c.count} ${c.label}`).join(' · ')} &mdash; edit these in the Relays
          and Lineup steps.
        </p>
      ) : null}
    </section>
  );
}
