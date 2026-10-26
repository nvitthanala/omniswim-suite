/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Meet model types (plans/2026-10-25/D2-ENGINE-API.md, 3.6). `validateMeetModel` is in `validate.ts`.
 * The adapter that builds a `MeetModel` from SwimCloud simulator data is in
 * `packages/swimcloud/src/browser` (P2).
 */
import type { NcaaDivision } from '../types';
import type { NcaaScmConversionTableId } from '../constants';
import type { ScmConversionTableReason } from '../lib/scyConversion';
import type { Course, EventKey, Gender, Hundredths, IsoDate, IsoTime, SwimmerId, TeamId, TimeValue } from './primitives';
import type { Provenance } from './provenance';
import type { LcmToScyBasis } from '../sourcing/lcmToScy';

export type DivisionRef =
  | { readonly state: 'known'; readonly division: NcaaDivision; readonly season: string }
  | {
      readonly state: 'unknown';
      readonly reason: 'unmapped_team' | 'program_discontinued' | 'gender_not_sponsored' | 'sponsorship_unaudited';
    };

export interface MeetTeam {
  readonly teamId: TeamId;
  readonly division: DivisionRef;
}

export type RosterMembership = 'member' | 'not_member' | 'unknown';

export interface MeetSwimmer {
  readonly swimmerId: SwimmerId;
  readonly teamId: TeamId;
  readonly gender: Gender;
  readonly classYear: 'FR' | 'SO' | 'JR' | 'SR' | 'GR' | null;
  readonly roster: RosterMembership;
}

export interface MeetEvent {
  readonly eventKey: EventKey;
  readonly gender: Gender;
  readonly kind: 'individual' | 'relay' | 'diving';
  /** `null` for diving. Relays read the distance from the event token. */
  readonly distanceYards: number | null;
  readonly relayKind: 'medley' | 'freestyle' | null;
}

/** `HistoricalSwim` flags. Absent means not stated. */
export type SwimFlags = {
  readonly extractedSplit?: true;
  readonly userInputted?: true;
  readonly altitudeAdjustedBySource?: true;
  readonly exhibition?: true;
  readonly timeTrial?: true;
  readonly programUnconfirmed?: true;
};

export type ConversionBasis =
  | { readonly method: 'swimcloud'; readonly displayedText: string }
  | {
      readonly method: 'ncaa_scm_table';
      readonly tableId: NcaaScmConversionTableId;
      readonly factor: number;
      readonly division: NcaaDivision | null;
      readonly reason: ScmConversionTableReason;
      /** `'relay-split'`: the individual event's factor applied to a split (R60, R62). */
      readonly appliedTo?: 'relay-split';
    }
  /** LCM to SCY, fitted to tool outputs (R58). Its provenance is `tool-derived`, never `published`. */
  | LcmToScyBasis
  /** Retired (R58): no code produces it. The member stays so saved data still parses. */
  | {
      readonly method: 'table_d';
      readonly multiplierPermille: number;
      readonly turnAdjustmentHundredths: number;
      readonly provenance: Provenance;
    };

export type ScyStatement =
  | { readonly kind: 'recorded-scy' }
  | {
      readonly kind: 'converted';
      readonly hundredths: Hundredths;
      readonly basis: ConversionBasis;
      /** Always `true`: a converted time is an estimate (shows the "est." badge), whatever its source (R58, R60). */
      readonly estimated: true;
    }
  | {
      readonly kind: 'not-convertible';
      readonly reason: 'event_not_swum_in_course' | 'no_conversion_available' | 'conversions_excluded';
    };

export type SwimOrigin =
  | { readonly kind: 'simulator'; readonly snapshotId: string }
  | { readonly kind: 'history-fetch'; readonly fetchedAt: IsoTime; readonly url: string };

export interface MeetSwim {
  readonly swimId: string;
  readonly swimmerId: SwimmerId;
  readonly eventKey: EventKey;
  readonly recordedCourse: Course;
  /**
   * `null` is NT. On a diving event (`MeetEvent.kind` `'diving'`) this holds the dive SCORE in
   * hundredths of a point (451.28 is 45128, text `'451.28'`), and higher is better. The type is
   * reused, not widened (D2 8.11). Nothing may format or parse a dive score as a time.
   */
  readonly recordedTime: TimeValue | null;
  readonly date: IsoDate | null;
  readonly seasonId: string | null;
  readonly flags: SwimFlags;
  readonly scy: ScyStatement;
  readonly origin: SwimOrigin;
}

export interface RelaySplit {
  readonly splitId: string;
  readonly swimmerId: SwimmerId;
  /**
   * The relay the split came from. `null`: the source does not say. A SwimCloud simulator split row
   * names only the leg's stroke and distance, so a 50 Freestyle split could come from a 200 Freestyle
   * Relay or a 200 Medley Relay. P2 loosened this from `EventKey` rather than guess one (D2 8.11).
   */
  readonly relayEventKey: EventKey | null;
  /** `null`: not stated. Stored, never used. */
  readonly legPosition: 1 | 2 | 3 | 4 | null;
  readonly start: 'flat' | 'flying' | 'unknown';
  readonly legEventKey: EventKey | null;
  readonly split: TimeValue;
  readonly course: Course | null;
  readonly date: IsoDate | null;
  readonly origin: SwimOrigin;
}

export type DateWindow =
  | { readonly kind: 'seasons'; readonly seasonIds: readonly string[] }
  | { readonly kind: 'dates'; readonly from: IsoDate; readonly to: IsoDate };

export interface MeetDisplay {
  readonly swimmers: Readonly<Record<SwimmerId, { readonly name: string }>>;
  readonly teams: Readonly<Record<TeamId, { readonly name: string }>>;
}

export interface MeetModel {
  readonly payloadVersion: 1;
  readonly meetKey: string;
  readonly teams: readonly MeetTeam[];
  readonly swimmers: readonly MeetSwimmer[];
  readonly events: readonly MeetEvent[];
  readonly swims: readonly MeetSwim[];
  readonly relaySplits: readonly RelaySplit[];
  readonly recordRange: DateWindow;
  readonly extendedWindow: boolean;
  /** `null`: not read. */
  readonly observedScores: readonly { readonly teamId: TeamId; readonly points: number }[] | null;
  readonly display?: MeetDisplay;
}
