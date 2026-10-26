/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The parity report: the engine's `Results` against what SwimCloud itself recorded (plan section 3.3,
 * "Parity check, built in"). It is the data behind the overlay's "matches SwimCloud" line. The UI is a
 * later task; this file fixes the shape.
 *
 * Two levels, both exact (`===`, no tolerance):
 * - Team totals: `Results.teams[].points` against the page's `totalScores`.
 * - Entries: each engine row against the `points` the page recorded on that entry's splash. A splash
 *   with no `points` is `not_stated`: the page leaves it unset past the point table. It is never read
 *   as 0. It is not a mismatch when the engine also scores the entry 0. When the engine awards points
 *   to an entry the page left unset, that is a `mismatch` (`observed` stays `null`): the page awarded
 *   nothing, and a report that says "matches" would be wrong.
 *
 * `matches` is true only when every team total is equal and no entry differs. A tie between teams
 * does not matter here: the report compares points, not ranks.
 */
import type { EventKey, Gender, NotScoredReason, Results, ResultRow, SwimmerId, TeamId } from '@omniswim/engine';
import type { AdaptedSimulator } from './adapt';

export type EntryParityStatus = 'match' | 'mismatch' | 'not_stated';

export interface EntryParity {
  readonly entryKey: string;
  readonly teamId: TeamId;
  /** `null` for a relay entry. */
  readonly swimmerId: SwimmerId | null;
  /** SwimCloud's points for the entry. `null`: SwimCloud states none. */
  readonly observed: number | null;
  /** The engine's points. */
  readonly engine: number;
  readonly status: EntryParityStatus;
  /** The engine's reason, when it scored the entry 0 and derived one. */
  readonly engineReason?: NotScoredReason;
}

export interface EventParity {
  readonly eventKey: EventKey;
  readonly gender: Gender;
  readonly rows: readonly EntryParity[];
  /** No row of the event has status `mismatch`. */
  readonly matches: boolean;
}

export interface TeamParity {
  readonly teamId: TeamId;
  readonly observed: number;
  readonly engine: number;
  /** `engine - observed`. */
  readonly difference: number;
  readonly match: boolean;
}

export type ParityReport =
  /** The snapshot carried no SwimCloud totals (`totalScores` was null). Nothing to compare. */
  | { readonly kind: 'not_observed' }
  | {
      readonly kind: 'compared';
      readonly matches: boolean;
      readonly teams: readonly TeamParity[];
      /** Every event with an entry, in `Results.events` order. */
      readonly events: readonly EventParity[];
      /** The events with at least one `mismatch`: the per-event difference the overlay shows. */
      readonly differingEvents: readonly EventParity[];
    };

export function parityReport(adapted: AdaptedSimulator, results: Results): ParityReport {
  const observed = adapted.model.observedScores;
  if (observed === null) return { kind: 'not_observed' };

  const engineTeams = new Map(results.teams.map((t) => [t.teamId, t.points]));
  const teams: TeamParity[] = observed.map((o) => {
    const engine = engineTeams.get(o.teamId);
    if (engine === undefined) throw new RangeError(`parityReport: team ${o.teamId} has observed points but is not in Results`);
    return { teamId: o.teamId, observed: o.points, engine, difference: engine - o.points, match: engine === o.points };
  });

  const observedByKey = new Map(adapted.observedEntries.map((e) => [e.entryKey, e.points]));
  const events: EventParity[] = results.events.map((event) => {
    const rows = event.rows.map((row: ResultRow): EntryParity => {
      if (!observedByKey.has(row.entryKey)) {
        throw new RangeError(`parityReport: engine row ${row.entryKey} has no observed splash`);
      }
      const seen = observedByKey.get(row.entryKey) ?? null;
      const status: EntryParityStatus = seen === null ? (row.points === 0 ? 'not_stated' : 'mismatch') : seen === row.points ? 'match' : 'mismatch';
      return {
        entryKey: row.entryKey,
        teamId: row.teamId,
        swimmerId: row.swimmerId,
        observed: seen,
        engine: row.points,
        status,
        ...(row.notScoredReason === undefined ? {} : { engineReason: row.notScoredReason }),
      };
    });
    return { eventKey: event.eventKey, gender: event.gender, rows, matches: rows.every((r) => r.status !== 'mismatch') };
  });
  const differingEvents = events.filter((e) => !e.matches);
  return {
    kind: 'compared',
    matches: teams.every((t) => t.match) && differingEvents.length === 0,
    teams,
    events,
    differingEvents,
  };
}
