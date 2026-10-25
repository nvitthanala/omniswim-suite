/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-edit revert panel for the Athletes step's working copy. Lists recruits
 * and soft removals individually (the only two categories with an
 * unambiguous revert unit) and shows the rest as counts pointing at their
 * own editors. See `listRevertibleChanges` / `countWorkingCopyChanges` in
 * @omniswim/core for the underlying data. It renders only the body: the
 * parent's Disclosure supplies the title and the open/closed state.
 */

import React from 'react';
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
  // The list sits in a collapsed Disclosure. A real workspace can hold dozens of
  // recruits, and one Revert button each would dominate the step.
  const changes = listRevertibleChanges(workspace, gender);
  const counts = countWorkingCopyChanges(workspace, gender);

  const nonRevertible: { label: string; count: number }[] = [
    { label: 'manual roster flags', count: counts.rosterOverrides },
    { label: 'relay leg overrides', count: counts.relayLegOverrides },
    { label: 'planned entries', count: counts.plannedEntries },
  ].filter(c => c.count > 0);

  if (changes.length === 0 && nonRevertible.length === 0) {
    return (
      <p className="text-ui-caption text-theme-muted">
        No edits yet. Recruits you add and swimmers you remove appear here, each with a Revert button.
      </p>
    );
  }

  return (
    <div>
      {changes.length > 0 ? (
        <ul className="flex flex-col gap-2">
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
    </div>
  );
}
