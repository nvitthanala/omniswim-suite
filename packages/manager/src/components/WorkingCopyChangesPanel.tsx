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

import React from 'react';
import { Undo2 } from 'lucide-react';
import type { Gender, Workspace } from '@omniswim/core/types';
import {
  countWorkingCopyChanges,
  listRevertibleChanges,
} from '@omniswim/core/lib/workingCopyChanges';
import { restoreSwimmerToWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';

type Props = {
  workspace: Workspace;
  gender: Gender;
  onUpdate: (patch: Partial<Workspace>) => void;
  disabled?: boolean;
};

export default function WorkingCopyChangesPanel({ workspace, gender, onUpdate, disabled }: Props) {
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
      <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Working copy edits</h4>

      {changes.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {changes.map(change => {
            const key = change.kind === 'recruit' ? `recruit:${change.id}` : `removal:${change.name}`;
            const canRevert = change.kind === 'recruit' || change.fullyRestorable;
            // An athlete can have several recruit rows (one per event), so the
            // name alone repeats — include the detail so each button is
            // distinguishable to a screen reader, not just visually by position.
            const label =
              change.kind === 'recruit'
                ? `Revert recruit ${change.label} — ${change.detail}`
                : `Revert removal of ${change.label}`;
            const buttonText =
              change.kind === 'removal' && !change.fullyRestorable ? 'Restore (rows unavailable)' : 'Revert';

            return (
              <li
                key={key}
                className="flex items-start justify-between gap-3 rounded-lg border border-theme-soft surface-muted-bg px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-ui-body font-medium text-[var(--text-primary)] truncate">{change.label}</p>
                  <p className="text-ui-caption text-theme-secondary mt-0.5">{change.detail}</p>
                  {change.kind === 'removal' && !change.fullyRestorable ? (
                    <p className="text-ui-caption text-amber-500 mt-0.5">
                      Original rows are no longer recoverable — reverting will only clear the removal
                      marker, not bring back this athlete&apos;s swims.
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={disabled || !canRevert}
                  aria-label={label}
                  title={
                    change.kind === 'removal' && !change.fullyRestorable
                      ? "This athlete's original rows can no longer be rebuilt; only the removal marker will be cleared."
                      : undefined
                  }
                  className="flex items-center gap-1.5 text-ui-caption text-[var(--text-accent)] hover:underline shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline disabled:text-theme-muted"
                  onClick={() => {
                    if (disabled) return;
                    if (change.kind === 'recruit') {
                      onUpdate({ recruits: (workspace.recruits ?? []).filter(r => r.id !== change.id) });
                    } else {
                      onUpdate(restoreSwimmerToWorkspace(workspace, { name: change.name, gender }));
                    }
                  }}
                >
                  <Undo2 size={12} />
                  {buttonText}
                </button>
              </li>
            );
          })}
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
