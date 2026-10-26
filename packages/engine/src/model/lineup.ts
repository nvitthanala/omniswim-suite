/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lineup (plans/2026-10-25/D2-ENGINE-API.md, 3.7).
 *
 * A lineup holds ids, events and roles. Every SwimCloud-derived name or time lives under
 * `display`, which the engine never reads and `stripSwimCloudData` removes.
 */
import type { EventKey, Gender, SwimmerId, TeamId, TimeValue } from './primitives';

export type IndividualEntry = {
  readonly kind: 'individual';
  readonly teamId: TeamId;
  readonly swimmerId: SwimmerId;
  readonly eventKey: EventKey;
  readonly gender: Gender;
  /** `null`: the engine picks the best rankable swim. */
  readonly seedSwimId: string | null;
};

export type LegBasis =
  | { readonly kind: 'split'; readonly splitId: string }
  /** Leg 1 only. */
  | { readonly kind: 'flat-start-swim'; readonly swimId: string }
  /** Legs 2 to 4 only. The flyover is read at scoring time. */
  | { readonly kind: 'flyover-estimate'; readonly swimId: string }
  | { readonly kind: 'no-time' };

export type RelayLeg = { readonly swimmerId: SwimmerId; readonly basis: LegBasis };

export type RelayEntry = {
  readonly kind: 'relay';
  readonly teamId: TeamId;
  readonly eventKey: EventKey;
  readonly gender: Gender;
  readonly letter: string;
  readonly legs: readonly [RelayLeg, RelayLeg, RelayLeg, RelayLeg];
};

export type LineupEntry = IndividualEntry | RelayEntry;

export type ScorerRole = 'scorer' | 'non-scorer' | 'exhibition';
export type ScorerTag = { readonly teamId: TeamId; readonly swimmerId: SwimmerId; readonly role: ScorerRole };

export interface LineupDisplay {
  readonly swimmers: Readonly<Record<SwimmerId, { readonly name: string }>>;
  readonly teams: Readonly<Record<TeamId, { readonly name: string }>>;
  /** Key: `entryKey(entry)`. */
  readonly entryTimes: Readonly<Record<string, TimeValue>>;
}

export interface Lineup {
  readonly payloadVersion: 1;
  readonly meetKey: string;
  readonly entries: readonly LineupEntry[];
  /** All SwimCloud data in a lineup lives here. */
  readonly display?: LineupDisplay;
}

const KEY_SEPARATOR = '|';

function keyPart(part: string, what: string): string {
  // A separator inside an id would let two different entries share one key.
  if (part.includes(KEY_SEPARATOR)) {
    throw new RangeError(`entryKey: ${what} "${part}" contains "${KEY_SEPARATOR}"`);
  }
  return part;
}

/**
 * The stable key of an entry: `i|team|swimmer|event|gender` for an individual,
 * `r|team|event|gender|letter` for a relay. Throws if a part contains `|`.
 */
export function entryKey(e: LineupEntry): string {
  if (e.kind === 'individual') {
    return ['i', keyPart(e.teamId, 'team id'), keyPart(e.swimmerId, 'swimmer id'), keyPart(e.eventKey, 'event key'), e.gender].join(KEY_SEPARATOR);
  }
  return ['r', keyPart(e.teamId, 'team id'), keyPart(e.eventKey, 'event key'), e.gender, keyPart(e.letter, 'relay letter')].join(KEY_SEPARATOR);
}

/**
 * The lineup without its `display`. The key is removed, never set to `undefined`, so the result
 * survives `JSON.parse(JSON.stringify(...))` unchanged. The input is not modified.
 */
export function stripSwimCloudData(l: Lineup): Lineup {
  const { display: _display, ...rest } = l;
  return rest;
}
