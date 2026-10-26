/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The draft-meet guard (R54, plans/2026-10-25/D3-STORAGE-AND-BUILD.md section 14).
 *
 * A meet with no teams is saved as a draft (`MeetRecord.status: 'draft'`). Scoring and the optimizer
 * must not run on one. They are not built in the extension yet (phase P3), so storage supplies the
 * one check they must call. It returns a typed result and never throws: a refusal is a value the
 * caller has to look at, not an empty meet that scores to nothing.
 *
 * `ScorableMeet` is a branded type. Only this file makes one, so a P3 function that takes a
 * `ScorableMeet` cannot be called with a raw `MeetRecord` that skipped the guard.
 */
import type { MeetRecord } from './schema';

declare const scorableBrand: unique symbol;
/** A meet that passed `requireScorableMeet`: not a draft, and it has teams. */
export type ScorableMeet = MeetRecord & { readonly [scorableBrand]: true };

/** Why scoring or the optimizer must not run on this meet. */
export type MeetRefusalReason =
  /** `status: 'draft'`: the meet has no teams yet (R54). */
  | 'draft'
  /** No teams and no draft mark. Validation never lets this reach storage, so the record is corrupt. */
  | 'no-teams';

export interface MeetRefusal {
  readonly ok: false;
  readonly reason: MeetRefusalReason;
  readonly meetKey: string;
  readonly message: string;
}

export type ScorableMeetResult = { readonly ok: true; readonly meet: ScorableMeet } | MeetRefusal;

/** True for a meet saved as a draft. */
export function isDraftMeet(meet: Pick<MeetRecord, 'status'>): boolean {
  return meet.status === 'draft';
}

/**
 * The check scoring and the optimizer call before they run. Returns `{ok:true, meet}` for a meet
 * with teams that is not a draft, else a `MeetRefusal`. A draft is refused even if it somehow has
 * teams: the mark means the user has not finished the meet.
 */
export function requireScorableMeet(meet: MeetRecord): ScorableMeetResult {
  if (isDraftMeet(meet)) {
    return { ok: false, reason: 'draft', meetKey: meet.meetKey, message: `Meet ${meet.meetKey} is a draft. Add teams before scoring or optimizing.` };
  }
  if (meet.teamIds.length === 0) {
    return { ok: false, reason: 'no-teams', meetKey: meet.meetKey, message: `Meet ${meet.meetKey} has no teams and is not marked as a draft. The record is not valid.` };
  }
  return { ok: true, meet: meet as ScorableMeet };
}
