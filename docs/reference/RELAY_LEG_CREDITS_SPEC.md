# Relay leg credits: spec (architect, 2026-10-09)

Status: spec accepted by the orchestrator. Not built yet. State lives in
`docs/reference/SESSION_2026-10-09_STATE.json` (track `T1b-relay-leg-credits`).

## Decision

Relay legs do **not** go on `HistoricalSwim`. They live in a separate
collection, `Workspace.relayLegCredits`. A flag on `HistoricalSwim` relies
on about 40 existing consumers to skip it. A separate type with no `event`
and no `time` field cannot reach any best-time reader.

Reproduced against current core code (tsx probes):

- A leg flagged on `HistoricalSwim` as `50 Free SCY` became the 50 Free best
  in `categorizeBestEvents`.
- `mergeHistoryIndex([22.50 real], [20.95 leg])` kept only the leg. The real
  swim was lost.
- `isRankableSwim({event:'200 MED-R'})` is `true`. `"200 MED-R"` contains no
  "relay", so `includes('relay')` and `/\brelay\b/` filters miss it.
- `relayLegDistanceYardsOfEvent('200 MED-R')` is `null`, and
  `relayStrokeForIndex` reads a medley relay as four free legs.
- `athlete_event_times` has `UNIQUE(athlete_id, event)`. A leg there would
  replace the real time.

Leadoff credits also go only into the new collection. The times converter
already imports leadoffs as individual swims (user ruling 2026-09-22,
`swimCloudImportBridge.ts:549`).

## Parser

`packages/swimcloud/src/relayLegCredits.ts`: add `relayEventTitle?: string`
to `SwimCloudRelayLegCredit`. Read it from the event menu of the same
capture (`c-events__link-body` `title` on the
`/results/{meetId}/event/{eventRef}/` link; fixture event 2 is
`"200 Medley Relay Men"`). Leave it absent when the menu has no entry.
Never expand `MED-R` in code.

## Core type (`packages/core/src/types.ts`)

```ts
export interface RelayLegCredit {
  swimCloudSwimId: string;        // primary key (/times/{id}/)
  swimCloudSwimmerId: string;
  meetId: string; eventRef: string;
  name: string; team: string; gender: Gender;
  relayEvent: string;             // as printed: '200 MED-R'
  relayEventTitle?: string;       // '200 Medley Relay Men'
  legLabel?: string;
  legPosition?: 1 | 2 | 3 | 4;
  legPositionSource?: 'leg-word' | 'event-page-join';
  isLeadoff: boolean;
  split: string;                  // never named `time`
  timeType?: 'SCY' | 'LCM' | 'SCM'; // only from a printed course or the caller's meetCourse; never defaulted
  relayPlace?: number; relayLetter?: string;
  meetLabel?: string; date?: string;
  sourceUrl: string; retrievedAt?: string;
}
// Workspace: relayLegCredits?: RelayLegCredit[];
```

## Invariants

- **I1.** No code writes a credit into `athleteHistory`,
  `athlete_event_times`, psych rows or `SwimmerResult`.
- **I2.** `isRankableSwim` returns `false` for a relay-shaped label:
  `/\brelay\b/i` or `/^\d+\s+[A-Z]+-R\b/i`.
- **I3.** `mergeRelayLegCredits(existing, incoming): { credits; conflicts }`
  keys on `swimCloudSwimId`. An identical copy is dropped. The same id with a
  different `split`, `meetId` or `swimCloudSwimmerId` keeps the existing
  credit and reports a conflict.
- **I4.** `legPosition` comes only from the leg word (Leadoff=1, Anchor=4) or
  a `matched` result of `joinRelayCreditsToEventEntries`. A credit with no
  position is stored but never used.
- **I5.** Leg distance and stroke come only from `relayEventTitle` through
  the existing helpers. No title means no leg event.

## Changes

- `bestTimeEligibility.isRankableSwim` (I2).
- New `packages/core/src/lib/relayLegCredits.ts`: `mergeRelayLegCredits`,
  `relayLegSlotOf(credit): { distance; stroke; position; start: 'flat' | 'takeover' } | null`.
- Manager converter `swimCloudRelayCreditsToRelayLegCredits`.
- `swimCloudSwimmerTimesToHistoricalSwims`: skip a relay-shaped label with
  reason `'relay-leg-credit'`.
- DB: `relay_leg_credits` child table in `CHILD_TABLES`, `schema.ts`,
  `pgSchema.ts`, `assembleWorkspace` and both insert paths (follow
  `race_analyses`). Add `relayLegCredits` to `DATA_LOSS_COLLECTIONS`.

Out of scope: `categorizeBestEvents`, `mergeHistoryIndex`, `cutlineTags`,
`rosterOptimizer`, `relayLegHistoryCandidates`, `theoreticalMeetSeeds`.

## Theoretical meet relays (data shape only)

```ts
type RelayLegBasis = 'flat-start-best' | 'real-leadoff-credit' | 'real-takeover-credit' | 'estimated-from-flat-start';
interface ProjectedRelayLeg { position: 1|2|3|4; name; team; legEvent: string; time: string; timeSec: number;
  basis: RelayLegBasis; estimated?: true; swimCloudSwimId?: string; flatStartTime?: string; startAdjustmentSec?: number; }
interface ProjectedRelay { event; team; legs: ProjectedRelayLeg[]; totalTime?: string; anyEstimated: boolean; incomplete?: true }
```

- Leg 1: fastest of the rankable individual best and any leadoff credit.
  Both are real flat-start swims. Neither is labelled estimated. A credit
  counts as a leadoff only when `relayLegSlotOf(credit)?.position === 1`,
  never through `isLeadoff` alone (a join-conflicted credit keeps
  `isLeadoff: true` with no position). Review ruling 3b, 2026-10-09.
- Merge (review ruling 3a): `mergeRelayLegCredits` fills absent optional
  fields from an incoming copy (`legPosition` with `legPositionSource` as a
  pair). A differing present `legPosition`, `relayEventTitle`, `timeType`,
  `eventRef` or `relayEvent` is a conflict; the existing credit is kept.
- Legs 2-4: fastest real takeover credit with the same distance, stroke and
  course, with a known position 2-4. With none, estimate as flat-start best
  minus `relayTakeoverAdjustmentSec[distance]`.
- The adjustment is a setting, `Partial<Record<50|100|200, number>>`. No
  setting for a distance means no estimate: the leg is absent, `incomplete`
  is set, `totalTime` is absent.
- A real leg beats an estimate, even a faster estimate.
- Only credits whose `timeType` equals the meet course count. No course
  conversion.
- Estimates are display-only. They are never stored.

## Acceptance tests

| Test | Assertion | Mutation that must fail it |
|---|---|---|
| `relayLegCredit_notAssignableToHistoricalSwim` | `@ts-expect-error` on assigning a credit to `HistoricalSwim` | Rename `split` to `time` and add `event` |
| `anchorFixture_neverReachesBests` | Converting the 399227 anchor fixture leaves `athleteHistory` and `bestByEvent` unchanged | Write credits into history |
| `isRankableSwim_refusesRelayLabels` | `false` for `'200 MED-R'`, `'200 MED-R SCY'`, `'400 Medley Relay'`; `true` for `'50 Free SCY'` | Drop the `-R` alternative |
| `timesConverter_skipsRelayCredit` | `'200 MED-R (Anchor)'` skipped with reason `'relay-leg-credit'` | Remove the skip |
| `mergeRelayLegCredits_keysOnSwimId` | Same split, different ids: both kept. Same id, different split: existing kept plus one conflict | Key on name+event; incoming wins |
| `relayEventTitle_fromFixtureNav` | Fixture credit has `relayEventTitle === '200 Medley Relay Men'` | Expand `MED-R` instead |
| `relayLegSlot_absentWithoutPositionOrTitle` | No position gives `null`; no title gives `null`; medley anchor gives `{distance:50, stroke:'free', start:'takeover'}` | Treat `isLeadoff:false` as takeover |
| `relayLegCredits_roundTripSqliteAndPg` | Save and load keep every field; absent stays absent | Omit the table from `CHILD_TABLES` |
| `projectedRelay_estimateAbsentWithoutSetting` | No adjustment gives `incomplete: true`, no `totalTime` | Default the adjustment to 0 |
| `projectedRelay_realLegBeatsEstimate` | Real 21.40 beats estimate 21.10; `basis` is `'real-takeover-credit'` | Pick the minimum across bases |

## Open

- The swimmer-in-meet capture does not print the meet course. Credits stay
  unusable for projection until a course comes from a printed page or the
  caller's `meetCourse` option.
- `FR-R` has not appeared in a real capture. The menu-title rule avoids an
  abbreviation table.
