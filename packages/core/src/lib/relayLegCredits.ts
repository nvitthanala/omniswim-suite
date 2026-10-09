/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay-leg credits: merge, and the one question a credit can answer.
 * Spec: `docs/reference/RELAY_LEG_CREDITS_SPEC.md`.
 *
 * A {@link RelayLegCredit} is a relay leg SwimCloud credits to a swimmer. It is
 * NOT a swim: it has no `event` and no `time`, so no best-time reader can pick
 * it up, and nothing here writes one into `athleteHistory`,
 * `athlete_event_times`, psych rows or a `SwimmerResult` (invariant I1).
 *
 * This module sits next to `relayLegMatching.ts` and `relaySplits.ts` and reads
 * their helpers. It adds no event-name table: the leg's distance and stroke
 * come only from the meet's own event title (`relayEventTitle`, for example
 * `'200 Medley Relay Men'`), never from the abbreviation SwimCloud prints
 * (`'200 MED-R'`). No title, no leg event (invariant I5).
 */

import type { RelayLegCredit, RelayLegStroke } from '../types';
import { relayStrokeForIndex } from './relayLegMatching';
import { relayLegDistanceYardsOfEvent } from './relaySplits';

/* -------------------------------------------------------------------------- */
/* Merge                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The fields that, if they disagree for one `swimCloudSwimId`, make two credits
 * different facts. `split`, `meetId` and `swimCloudSwimmerId` are required, so
 * any difference conflicts. The other fields are optional: they conflict only
 * when both copies state a value and the values differ. A value one copy lacks
 * is not a disagreement (see {@link mergeRelayLegCredits}).
 */
export type RelayLegCreditConflictField =
  | 'split'
  | 'meetId'
  | 'swimCloudSwimmerId'
  | 'eventRef'
  | 'relayEvent'
  | 'legPosition'
  | 'relayEventTitle'
  | 'timeType';

/**
 * Two credits that share a `swimCloudSwimId` and disagree on a field that cannot
 * differ for one swim. The existing credit stays in the collection unchanged
 * (nothing is filled into it); the incoming one is held out and reported here.
 */
export interface RelayLegCreditConflict {
  readonly existing: RelayLegCredit;
  readonly incoming: RelayLegCredit;
  /** Every field of {@link RelayLegCreditConflictField} that differs, in the order of that type. Never empty. */
  readonly fields: readonly RelayLegCreditConflictField[];
}

export interface RelayLegCreditMerge {
  /** `existing` in its order, then each accepted incoming credit in arrival order. */
  readonly credits: RelayLegCredit[];
  readonly conflicts: RelayLegCreditConflict[];
}

/** Compared with `!==` whatever the value: a required field, so absent is not a case. */
const REQUIRED_CONFLICT_FIELDS = ['split', 'meetId', 'swimCloudSwimmerId'] as const;
/** Conflict only when both copies state a value and the values differ. */
const OPTIONAL_CONFLICT_FIELDS = ['eventRef', 'relayEvent', 'legPosition', 'relayEventTitle', 'timeType'] as const;
/** Filled from the incoming copy when the existing credit lacks the field. Nothing else is ever filled singly. */
const FILLABLE_FIELDS = ['relayEventTitle', 'legLabel', 'timeType', 'relayPlace', 'relayLetter', 'meetLabel', 'date'] as const;

function conflictingFields(known: RelayLegCredit, candidate: RelayLegCredit): RelayLegCreditConflictField[] {
  const fields: RelayLegCreditConflictField[] = REQUIRED_CONFLICT_FIELDS.filter((f) => known[f] !== candidate[f]);
  for (const f of OPTIONAL_CONFLICT_FIELDS) {
    if (known[f] !== undefined && candidate[f] !== undefined && known[f] !== candidate[f]) fields.push(f);
  }
  return fields;
}

/**
 * The existing credit with the incoming copy's extra facts added, or the same
 * object when the incoming copy adds nothing. Only {@link FILLABLE_FIELDS} fill,
 * and `legPosition` with `legPositionSource` as a pair: both come from the
 * incoming copy or neither does. `name`, `team`, `gender`, `sourceUrl`,
 * `retrievedAt` and `isLeadoff` never change.
 */
function fillMissing(known: RelayLegCredit, candidate: RelayLegCredit): RelayLegCredit {
  let filled: RelayLegCredit = known;
  const patch = (extra: Partial<RelayLegCredit>): void => {
    filled = { ...filled, ...extra };
  };
  for (const field of FILLABLE_FIELDS) {
    if (known[field] === undefined && candidate[field] !== undefined) patch({ [field]: candidate[field] });
  }
  if (known.legPosition === undefined && candidate.legPosition !== undefined && candidate.legPositionSource !== undefined) {
    patch({ legPosition: candidate.legPosition, legPositionSource: candidate.legPositionSource });
  }
  return filled;
}

/**
 * Add incoming relay-leg credits to an existing collection (invariant I3).
 *
 * The key is `swimCloudSwimId` and nothing else: not name, not event, not
 * split. Two different swims can share a name and a split (a swimmer who splits
 * 21.83 twice), and they stay two credits.
 *
 * - New id: appended.
 * - Known id, and {@link conflictingFields} is empty: the same swim. The
 *   incoming copy is dropped. Facts it has and the existing credit lacks are
 *   filled in (`relayEventTitle`, `legLabel`, `timeType`, `relayPlace`,
 *   `relayLetter`, `meetLabel`, `date`, and `legPosition` with
 *   `legPositionSource` together). A fact the existing credit has is never
 *   replaced. With nothing to fill, the existing object is returned as it was.
 * - Known id, any conflicting field: the existing credit stays unchanged with
 *   nothing filled, the incoming one is held out, and one conflict is
 *   reported. Incoming never wins.
 *
 * An id repeated inside `incoming` is handled the same way, against the credit
 * accepted first. Neither input is mutated.
 */
export function mergeRelayLegCredits(
  existing: readonly RelayLegCredit[],
  incoming: readonly RelayLegCredit[],
): RelayLegCreditMerge {
  const credits: RelayLegCredit[] = [...existing];
  const conflicts: RelayLegCreditConflict[] = [];
  const indexById = new Map<string, number>();
  credits.forEach((credit, index) => {
    if (!indexById.has(credit.swimCloudSwimId)) indexById.set(credit.swimCloudSwimId, index);
  });
  for (const candidate of incoming) {
    const index = indexById.get(candidate.swimCloudSwimId);
    if (index === undefined) {
      indexById.set(candidate.swimCloudSwimId, credits.length);
      credits.push(candidate);
      continue;
    }
    const known = credits[index];
    const fields = conflictingFields(known, candidate);
    if (fields.length > 0) {
      conflicts.push({ existing: known, incoming: candidate, fields });
      continue;
    }
    credits[index] = fillMissing(known, candidate);
  }
  return { credits, conflicts };
}

/* -------------------------------------------------------------------------- */
/* Slot                                                                        */
/* -------------------------------------------------------------------------- */

/** The individual event a credit's leg was swum as, and how it began. */
export interface RelayLegSlot {
  /** Leg distance in yards, from the event title (`'200 Medley Relay Men'` gives 50). */
  readonly distance: number;
  readonly stroke: RelayLegStroke;
  /** 1-4, copied from the credit. */
  readonly position: 1 | 2 | 3 | 4;
  /** `flat` for leg 1 (from the blocks); `takeover` for legs 2-4 (flying start). */
  readonly start: 'flat' | 'takeover';
}

/**
 * The leg slot of a credit, or `null` when the credit does not prove one.
 *
 * `null` (never a guess) when:
 * - `legPosition` is absent (invariant I4: a credit with no position is stored,
 *   never used);
 * - `relayEventTitle` is absent, or names no readable relay distance (I5);
 * - the credit contradicts itself: `isLeadoff` is true and `legPosition` is
 *   not 1.
 *
 * `start` follows the position only: leg 1 is `flat`, legs 2-4 are `takeover`.
 * `isLeadoff: false` means "the page did not say leadoff", so it never makes a
 * leg a takeover by itself. A leg 1 proved by an event-page join carries
 * `isLeadoff: false` and is still a flat start.
 */
export function relayLegSlotOf(credit: RelayLegCredit): RelayLegSlot | null {
  const position = credit.legPosition;
  if (position === undefined) return null;
  if (credit.isLeadoff && position !== 1) return null;
  const title = credit.relayEventTitle;
  if (title === undefined || title.trim().length === 0) return null;
  const distance = relayLegDistanceYardsOfEvent(title);
  if (distance === null) return null;
  return {
    distance,
    stroke: relayStrokeForIndex(title.toLowerCase(), position - 1),
    position,
    start: position === 1 ? 'flat' : 'takeover',
  };
}
