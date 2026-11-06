/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a (plans/2026-10-25/D7-DATA-SOURCING.md section 4, "Requests"): which roster pages one click asks for. Pure.
 *
 * - "Simulator (current)": one page per team, the server's current season. It supplies class years and a cross-check; it changes no membership.
 * - A season label equal to the current season: the same single page per team, now applied as the membership source.
 * - A past season S: the page for S (its `season_id` copied from the page's own season list, never computed) plus the current-season page,
 *   because the class year always belongs to the current season. Two requests per team.
 * A chosen season whose id the season list does not give is not planned. A page that selects another season refuses at parse time
 * (`readRosterFetch` compares the selected option with the target), so a season list that disagrees with a team's own page cannot file a roster
 * under the wrong season.
 */
import { roundTripPath, runEstimateMs } from '../shared/fetchProtocol';
import type { RosterTarget, SimGender } from '../shared/fetchProtocol';
import type { ParsedSeasonChoices } from '../shared/bridgeSchema';

export type RosterSeasonChoice = { readonly kind: 'simulator-current' } | { readonly kind: 'season'; readonly label: string };

export interface PlannedRosterRequest {
  readonly target: RosterTarget;
  /** `chosen-season`: the roster the membership rows read. `current-season`: the roster the class years read. One request can be both. */
  readonly role: 'chosen-season' | 'current-season' | 'both';
  /** For a `server-current` target: the current label the season list gave, if it has arrived. A page that selects another season refuses. */
  readonly expectedSeasonLabel?: string;
}

export type RosterPlan =
  | { readonly ok: true; readonly requests: readonly PlannedRosterRequest[]; readonly estimateMs: number }
  | { readonly ok: false; readonly reason: string };

export function planRosterRequests(input: {
  readonly teamIds: readonly string[];
  readonly gender: SimGender;
  readonly choice: RosterSeasonChoice;
  readonly seasons: Extract<ParsedSeasonChoices, { ok: true }> | null;
}): RosterPlan {
  const { teamIds, gender, choice, seasons } = input;
  if (teamIds.length === 0) return { ok: false, reason: 'The simulator lists no team.' };
  if (new Set(teamIds).size !== teamIds.length) return { ok: false, reason: 'The simulator lists a team twice.' };
  const currentLabel = seasons?.current.label;
  let chosen: { readonly value: string; readonly label: string } | null = null;
  if (choice.kind === 'season') {
    if (!seasons) return { ok: false, reason: 'The season list has not arrived from the SwimCloud page yet.' };
    if (choice.label !== currentLabel) {
      const row = seasons.seasons.find((s) => s.label === choice.label);
      if (!row) return { ok: false, reason: `SwimCloud's season list has no ${choice.label}.` };
      chosen = { value: String(row.seasonId), label: row.label };
    }
  }
  const requests: PlannedRosterRequest[] = [];
  for (const teamId of teamIds) {
    const current: PlannedRosterRequest = {
      target: { kind: 'team-roster', teamId, gender, season: { kind: 'server-current' } },
      role: choice.kind === 'season' && chosen === null ? 'both' : 'current-season',
      ...(currentLabel === undefined ? {} : { expectedSeasonLabel: currentLabel }),
    };
    if (chosen) requests.push({ target: { kind: 'team-roster', teamId, gender, season: { kind: 'option', value: chosen.value, label: chosen.label } }, role: 'chosen-season' });
    requests.push(current);
  }
  for (const r of requests) {
    if (roundTripPath(r.target) === null) return { ok: false, reason: `Team ${r.target.teamId} cannot be requested: its id or season is not a plain token.` };
  }
  return { ok: true, requests, estimateMs: runEstimateMs(requests.length) };
}

/** "6 requests, about 15 s" (the button's text). */
export function describeRequests(count: number, estimateMs: number): string {
  const seconds = Math.round(estimateMs / 1000);
  return `${count} request${count === 1 ? '' : 's'}, about ${seconds} s`;
}
