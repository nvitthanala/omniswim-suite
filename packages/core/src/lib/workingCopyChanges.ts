/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Working-copy change counter — a pure tally of the edits that make the
 * projected scoring bundle diverge from the loaded meet (see
 * `buildScoringSnapshot` in scoringEngine.ts: baseline is the SAME workspace
 * scored with what-if off, not a separate object). This module never scores
 * anything; it only counts the collections that feed the what-if projection.
 */

import { Gender, Workspace } from '../types';
import { relayEntryKey } from './relaySplits';
import { canonicalSwimmerName, isRelayResult } from './utils';
import { getSourceResults } from './meetSource';

/** Per-category breakdown of working-copy edits for one gender, plus the total. */
export interface WorkingCopyChangeCounts {
  /** Injected/recruited athletes and swims (`workspace.recruits`). Gender-scoped. */
  recruits: number;
  /** Soft-removed swimmers (`workspace.deletedSwimmers`). Gender-scoped. */
  removals: number;
  /** Manual scorer flags (`workspace.scorerRosterOverrides`). Gender-scoped. */
  rosterOverrides: number;
  /**
   * Manual relay leg fills (`workspace.relayLegOverrides`) belonging to this
   * gender. `RelayLegOverride` carries no `gender` field, so each override is
   * attributed by resolving its `relayEntryKey` against this gender's own
   * result rows. Overrides that match no row are NOT counted here — see
   * `unresolvedRelayLegOverrides`.
   */
  relayLegOverrides: number;
  /**
   * Relay leg overrides whose `relayEntryKey` matches no result row in EITHER
   * gender — typically a stale override left behind when the underlying relay
   * entry changed. Deliberately kept out of `total`: attributing them to the
   * displayed gender would inflate the count with edits that may belong to the
   * other gender, or to nothing at all. Absent is not the same as zero, so they
   * are reported rather than silently dropped.
   */
  unresolvedRelayLegOverrides: number;
  /** Planned/what-if swim entries (`workspace.meetEntryPlans`). Gender-scoped. */
  plannedEntries: number;
  /** Sum of the gender-scoped categories above. Excludes unresolved overrides. */
  total: number;
}

/**
 * Count the working-copy edits for `gender` that make the projected scoring
 * bundle differ from the loaded (baseline) meet. Pure: no scoring, no engine
 * calls, no side effects. A missing/undefined collection counts as zero.
 */
export function countWorkingCopyChanges(workspace: Workspace, gender: Gender): WorkingCopyChangeCounts {
  const recruits = (workspace.recruits ?? []).filter(r => r.gender === gender).length;
  const removals = (workspace.deletedSwimmers ?? []).filter(d => d.gender === gender).length;
  const rosterOverrides = (workspace.scorerRosterOverrides ?? []).filter(o => o.gender === gender).length;
  const plannedEntries = (workspace.meetEntryPlans ?? []).filter(p => p.gender === gender).length;

  // RelayLegOverride has no `gender`, so attribute each one by matching its
  // `relayEntryKey` against the result rows of each gender. Counting them
  // wholesale would report every relay edit on BOTH genders, so a workspace
  // with 40 women's leg overrides would claim "40 changes" while the user is
  // looking at the men's roster — a plausible, wrong number.
  const keysFor = (rows: Workspace['menResults']) => {
    const keys = new Set<string>();
    for (const r of rows ?? []) keys.add(relayEntryKey(r));
    return keys;
  };
  const thisGenderKeys = keysFor(gender === Gender.MEN ? workspace.menResults : workspace.womenResults);
  const otherGenderKeys = keysFor(gender === Gender.MEN ? workspace.womenResults : workspace.menResults);

  let relayLegOverrides = 0;
  let unresolvedRelayLegOverrides = 0;
  for (const o of workspace.relayLegOverrides ?? []) {
    const here = thisGenderKeys.has(o.relayEntryKey);
    const there = otherGenderKeys.has(o.relayEntryKey);
    // A key matching BOTH genders cannot be attributed to either. In practice
    // relay event names carry the gender ("Event 11 Men 4x50 ..."), so this is
    // unreachable on real meet data — but attributing an ambiguous key would
    // count the same edit in both gender views, so it is reported instead of
    // guessed, exactly like a key matching neither.
    if (here && !there) relayLegOverrides += 1;
    else if (!here && !there) unresolvedRelayLegOverrides += 1;
    else if (here && there) unresolvedRelayLegOverrides += 1;
  }

  return {
    recruits,
    removals,
    rosterOverrides,
    relayLegOverrides,
    unresolvedRelayLegOverrides,
    plannedEntries,
    total: recruits + removals + rosterOverrides + relayLegOverrides + plannedEntries,
  };
}

/**
 * One individually-revertible working-copy edit, ready for display. Only the
 * two categories with an unambiguous revert unit are listed here — recruits
 * (remove by id) and soft removals (restore via `restoreSwimmerToWorkspace`).
 * Relay leg overrides and planned entries are NOT listed: they have their own
 * editors and no single obvious "undo" action.
 */
export type RevertibleChange =
  | { kind: 'recruit'; id: string; label: string; detail: string }
  | {
      kind: 'removal';
      name: string;
      mode: 'hidden' | 'removed';
      label: string;
      detail: string;
      /**
       * False when a `'removed'` swimmer's individual rows can no longer be
       * rebuilt from the frozen source copy — either the workspace has no
       * source copy at all (so `getSourceResults` would fall back to the
       * already-stripped working rows), or the source copy exists but holds
       * no matching non-relay rows for this athlete. In that case
       * `restoreSwimmerToWorkspace` still clears the tombstone but brings
       * back zero rows — a silent partial restore the UI must not offer
       * without warning. Always true for `'hidden'` removals: their source
       * rows were never touched.
       */
      fullyRestorable: boolean;
    };

/**
 * List the individually-revertible edits for `gender`, in the same gender
 * scoping as `countWorkingCopyChanges`. Pure: no scoring, no side effects.
 */
export function listRevertibleChanges(workspace: Workspace, gender: Gender): RevertibleChange[] {
  const changes: RevertibleChange[] = [];

  for (const r of workspace.recruits ?? []) {
    if (r.gender !== gender) continue;
    changes.push({
      kind: 'recruit',
      id: r.id,
      label: r.name,
      detail: `${r.event} · ${r.time} · ${r.team}`,
    });
  }

  const hasSourceCopy =
    gender === Gender.MEN ? workspace.sourceMenResults != null : workspace.sourceWomenResults != null;

  for (const d of workspace.deletedSwimmers ?? []) {
    if (d.gender !== gender) continue;
    const mode = d.mode ?? 'hidden';
    let fullyRestorable = true;
    if (mode === 'removed') {
      const key = canonicalSwimmerName(d.name);
      const sourceRows = getSourceResults(workspace, gender);
      const hasMatchingSourceRows = sourceRows.some(
        row => !isRelayResult(row) && canonicalSwimmerName(row.name) === key
      );
      fullyRestorable = hasSourceCopy && hasMatchingSourceRows;
    }
    changes.push({
      kind: 'removal',
      name: d.name,
      mode,
      label: d.name,
      detail: mode === 'removed' ? 'removed from the roster' : 'removed from the projection',
      fullyRestorable,
    });
  }

  return changes;
}
