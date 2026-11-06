import type { Lineup } from '../model/lineup';
import { entryKey } from '../model/lineup';
import type { Results, ResultRow } from '../model/results';
import type { SwimmerId, TeamId } from '../model/primitives';

export interface SwimmerPoints {
  readonly swimmerId: SwimmerId;
  readonly teamId: TeamId;
  readonly individual: number;
  readonly relayShare: number;
  readonly total: number;
}

interface PointTotals {
  readonly teamId: TeamId;
  individual: number;
  relayShare: number;
}

/** Attribute each relay's score equally across its four legs. */
export function swimmerPoints(results: Results, lineup: Lineup): readonly SwimmerPoints[] {
  const resultRows = new Map<string, ResultRow>();
  for (const event of results.events) {
    for (const row of event.rows) resultRows.set(row.entryKey, row);
  }

  const totals = new Map<SwimmerId, PointTotals>();
  const add = (swimmerId: SwimmerId, teamId: TeamId, points: number, relay: boolean): void => {
    const current = totals.get(swimmerId) ?? { teamId, individual: 0, relayShare: 0 };
    if (relay) current.relayShare += points;
    else current.individual += points;
    totals.set(swimmerId, current);
  };

  for (const entry of lineup.entries) {
    const row = resultRows.get(entryKey(entry));
    if (row === undefined) continue;
    if (entry.kind === 'individual') {
      add(entry.swimmerId, entry.teamId, row.points, false);
    } else {
      for (const leg of entry.legs) add(leg.swimmerId, entry.teamId, row.points / 4, true);
    }
  }

  return [...totals].map(([swimmerId, points]) => ({
    swimmerId,
    teamId: points.teamId,
    individual: points.individual,
    relayShare: points.relayShare,
    total: points.individual + points.relayShare,
  }));
}
