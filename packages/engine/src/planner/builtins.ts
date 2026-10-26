/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Built-in session presets (plans/2026-10-25/D2-ENGINE-API.md, 3.12 and 4).
 *
 * `nsisc-table-c` v1 is the NSISC event order. Every row is copied from Table C in
 * `plans/2026-10-25/00-USER-PLAN.md` (lines 55 to 76), not from the spec's restated table.
 * The event keys follow `normalizeEventForCutline`; `tests/engineBuiltinVersions.test.ts` checks that.
 * The plan prints dives as "One Meter Dive (Men)" and "Three Meter Dive (Women)". The key here is
 * `1-Meter Diving` or `3-Meter Diving`, and the gender sits on the schedule row.
 *
 * The 1000 and the 1650 Freestyle are `timed-final-split` (R35). The fast-heat size is 8. The
 * session for a field of 8 or fewer is a per-meet choice with no default, so it stays pending.
 */
import type { Builtin } from '../rules/builtinSupport';
import { pending, readmeRow, setting, userPlan } from '../rules/builtinSupport';
import type { EventKey, Gender } from '../model/primitives';
import type { ScheduledEvent, SessionPreset, SessionRef } from './types';

const MORNING = (day: number): SessionRef => ({ day, slot: 'morning' });
const AFTERNOON = (day: number): SessionRef => ({ day, slot: 'afternoon' });
const EVENING = (day: number): SessionRef => ({ day, slot: 'evening' });

/** A swim that has prelims in the morning and finals in the evening. */
function prelimsFinals(day: number, eventKey: EventKey): ScheduledEvent {
  return { eventKey, gender: 'both', format: { kind: 'prelims-finals', prelims: MORNING(day), finals: EVENING(day) } };
}

/** A relay: one evening timed final. */
function relay(day: number, eventKey: EventKey): ScheduledEvent {
  return { eventKey, gender: 'both', format: { kind: 'timed-final', session: EVENING(day) } };
}

/** A distance freestyle: slower heats in the morning, the fast heat in the evening. */
function split(day: number, eventKey: EventKey): ScheduledEvent {
  return {
    eventKey,
    gender: 'both',
    format: {
      kind: 'timed-final-split',
      slowHeats: MORNING(day),
      fastHeat: EVENING(day),
      fastHeatSize: setting(8, readmeRow('52', 'usually, its 8')),
      smallFieldSession: pending(
        'Where the one heat swims when entries are at most the fast-heat size. The meet decides (R35).',
        ['sessionLoad']
      ),
    },
  };
}

/** A dive: prelims in the afternoon, finals in the evening. */
function dive(day: number, eventKey: EventKey, gender: Gender): ScheduledEvent {
  return { eventKey, gender, format: { kind: 'prelims-finals', prelims: AFTERNOON(day), finals: EVENING(day) } };
}

const NSISC_TABLE_C: SessionPreset = {
  payloadVersion: 1,
  provenance: userPlan('55-76', 'Table C: NSISC Event Order'),
  events: [
    // Day 1
    relay(1, '800 Freestyle Relay'),
    // Day 2
    prelimsFinals(2, '200 Individual Medley'),
    prelimsFinals(2, '50 Freestyle'),
    split(2, '1000 Freestyle'),
    relay(2, '200 Medley Relay'),
    dive(2, '1-Meter Diving', 'Men'),
    // Day 3
    prelimsFinals(3, '100 Butterfly'),
    prelimsFinals(3, '400 Individual Medley'),
    prelimsFinals(3, '200 Freestyle'),
    relay(3, '400 Medley Relay'),
    dive(3, '3-Meter Diving', 'Women'),
    // Day 4
    prelimsFinals(4, '500 Freestyle'),
    prelimsFinals(4, '100 Backstroke'),
    prelimsFinals(4, '100 Breaststroke'),
    prelimsFinals(4, '200 Butterfly'),
    relay(4, '200 Freestyle Relay'),
    dive(4, '3-Meter Diving', 'Men'),
    // Day 5
    prelimsFinals(5, '100 Freestyle'),
    prelimsFinals(5, '200 Backstroke'),
    prelimsFinals(5, '200 Breaststroke'),
    split(5, '1650 Freestyle'),
    relay(5, '400 Freestyle Relay'),
    dive(5, '1-Meter Diving', 'Women'),
  ],
};

/** `'nsisc-table-c'` v1. */
export const BUILTIN_SESSION_PRESETS: readonly Builtin<SessionPreset>[] = [
  { id: 'nsisc-table-c', version: 1, label: 'NSISC event order (Table C)', preset: NSISC_TABLE_C },
];
