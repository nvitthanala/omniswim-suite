/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Planner types (plans/2026-10-25/D2-ENGINE-API.md, 3.11). Types only in P1.
 * `parseSessionPreset` and `sessionLoad` arrive in P5.
 */
import type { EventKey, Gender } from '../model/primitives';
import type { Provenance, Setting } from '../model/provenance';

export type SessionSlot = 'morning' | 'afternoon' | 'evening';

/** `day` is an integer of 1 or more. */
export interface SessionRef {
  readonly day: number;
  readonly slot: SessionSlot;
}

export type EventFormat =
  | { readonly kind: 'timed-final'; readonly session: SessionRef }
  | { readonly kind: 'prelims-finals'; readonly prelims: SessionRef; readonly finals: SessionRef }
  | {
      readonly kind: 'timed-final-split';
      readonly slowHeats: SessionRef;
      readonly fastHeat: SessionRef;
      /** R35: NSISC 8, editable per meet. */
      readonly fastHeatSize: Setting<number>;
      /** R35: where the one heat swims when entries are at most `fastHeatSize`. Per meet, no default. */
      readonly smallFieldSession: Setting<SessionRef>;
    };

export interface ScheduledEvent {
  readonly eventKey: EventKey;
  readonly gender: Gender | 'both';
  readonly format: EventFormat;
}

export interface SessionPreset {
  readonly payloadVersion: 1;
  readonly provenance: Provenance;
  /** Array order is the order within a session (R16). */
  readonly events: readonly ScheduledEvent[];
}

export type LoadPreference =
  | {
      readonly mode: 'respect';
      readonly maxRacesPerSession: Setting<number>;
      readonly diving: Setting<'counts' | 'excluded'>;
    }
  | {
      readonly mode: 'prefer';
      readonly maxRacesPerSession: Setting<number>;
      readonly diving: Setting<'counts' | 'excluded'>;
      /** No default. */
      readonly penaltyPointsPerExtraRace: Setting<number>;
    }
  | { readonly mode: 'off' };
