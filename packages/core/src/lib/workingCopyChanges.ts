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
    if (thisGenderKeys.has(o.relayEntryKey)) relayLegOverrides += 1;
    else if (!otherGenderKeys.has(o.relayEntryKey)) unresolvedRelayLegOverrides += 1;
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
