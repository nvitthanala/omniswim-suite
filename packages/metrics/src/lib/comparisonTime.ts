/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The comparison time Metrics offers for a swimmer and race, read from the active workspace.
 */
import type { Workspace } from '@omniswim/core/types';
import { isTheoreticalMeet } from '@omniswim/core/lib/theoreticalMeetLabel';
import { STROKE_LABEL } from '../components/raceSetupShared';
import type { RaceConfig } from '../types';

/** Does `event` name match the race's primary stroke and distance? */
function eventMatchesRace(event: string, strokeSearch: string, distanceStr: string): boolean {
  return event.toLowerCase().includes(strokeSearch) && event.includes(distanceStr);
}

/** Athlete-history times for `target` whose event matches the race. */
function findHistoryComparisonTimes(
  history: Workspace['athleteHistory'],
  target: string,
  strokeSearch: string,
  distanceStr: string,
): string[] {
  const matches: string[] = [];
  for (const h of history ?? []) {
    if (h.name.trim().toLowerCase() === target && eventMatchesRace(h.event, strokeSearch, distanceStr)) {
      matches.push(h.time);
    }
  }
  return matches;
}

/** Meet-result times for `target` whose event matches the race. */
function findResultComparisonTimes(
  results: readonly { name: string; event: string; time?: unknown }[],
  target: string,
  strokeSearch: string,
  distanceStr: string,
): string[] {
  const matches: string[] = [];
  for (const r of results) {
    if (r.name.trim().toLowerCase() === target && eventMatchesRace(r.event, strokeSearch, distanceStr) && typeof r.time === 'string') {
      matches.push(r.time as string);
    }
  }
  return matches;
}

/**
 * Best known time for the current swimmer/race from the active workspace:
 * checks athlete history first, then meet results, and returns the first
 * match found (or null if the workspace or swimmer name is unset).
 */
export function computeComparisonTime(
  activeWorkspace: Workspace | undefined,
  swimmerName: string,
  raceConfig: RaceConfig,
): string | null {
  if (!activeWorkspace || !swimmerName) return null;
  // A theoretical meet holds seed times (all-time bests of crawled teams). Nobody swam that meet,
  // so a seed must not be offered as a comparison time.
  if (isTheoreticalMeet(activeWorkspace)) return null;
  const target = swimmerName.trim().toLowerCase();
  const primaryStroke = raceConfig.strokePerLength[0];
  const strokeSearch = primaryStroke === undefined ? '' : STROKE_LABEL[primaryStroke].toLowerCase().slice(0, 4);
  const distanceStr = String(raceConfig.raceDistance);
  const historyMatches = findHistoryComparisonTimes(activeWorkspace.athleteHistory, target, strokeSearch, distanceStr);
  if (historyMatches.length > 0) return historyMatches[0];
  const resultMatches = findResultComparisonTimes(
    [...(activeWorkspace.menResults ?? []), ...(activeWorkspace.womenResults ?? [])],
    target,
    strokeSearch,
    distanceStr,
  );
  return resultMatches.length > 0 ? resultMatches[0] : null;
}
