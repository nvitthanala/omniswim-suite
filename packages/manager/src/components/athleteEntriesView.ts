/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Pure view-model helpers for AthleteEntriesSection — the paste-preview
 * selection logic and the entry-plan patch it produces on confirm.
 */

import type { Gender, HistoricalSwim, PlannedSwimEntry, ScoringSettings, Workspace } from '@omniswim/core/types';
import { canonicalSwimmerName } from '@omniswim/core/lib/utils';
import { createPlannedEntry } from '@omniswim/core/lib/whatIfProjection';
import { canAcceptAnotherEntry, countSwimmerEntries } from '@omniswim/core/lib/swimmerEntryLimits';

export type PastePreviewRow = { event: string; time: string; selected: boolean };

function isRelayEventName(event: string): boolean {
  return /\brelay\b/i.test(event);
}

/** Relay events last, so individual events get first claim on a swimmer's
 * remaining individual-entry slots. */
export function sortSwimsRelayLast<T extends { event: string }>(swims: T[]): T[] {
  return [...swims].sort((a, b) => Number(isRelayEventName(a.event)) - Number(isRelayEventName(b.event)));
}

/** From a parsed paste, build the subset of preview rows that are new (not
 * already planned) and still fit within the swimmer's entry limits — tracking
 * a running count as each accepted swim consumes a slot. */
export function selectPastePreviewRows(params: {
  swims: HistoricalSwim[];
  existingEvents: Set<string>;
  counts: ReturnType<typeof countSwimmerEntries>;
  settings: ScoringSettings;
}): PastePreviewRow[] {
  const { swims, existingEvents, counts, settings } = params;
  const have = new Set(existingEvents);
  let running = { individual: counts.individual, relayCount: counts.relayCount };
  const preview: PastePreviewRow[] = [];

  for (const swim of sortSwimsRelayLast(swims)) {
    if (have.has(swim.event)) continue;
    const probe = {
      individual: running.individual,
      relayEvents: new Set<string>(),
      relayCount: running.relayCount,
    };
    if (!canAcceptAnotherEntry(probe, settings, swim.event)) continue;
    preview.push({ event: swim.event, time: swim.time, selected: true });
    have.add(swim.event);
    running = isRelayEventName(swim.event)
      ? { ...running, relayCount: running.relayCount + 1 }
      : { ...running, individual: running.individual + 1 };
  }
  return preview;
}

/** True when a planned entry belongs to this athlete/team/gender scope — used
 * to drop the athlete's old plans before splicing in the newly-pasted ones. */
export function planMatchesAthleteScope(
  plan: PlannedSwimEntry,
  scope: { athleteCanonical: string; athleteTeamTrim: string; gender: Gender }
): boolean {
  return (
    canonicalSwimmerName(plan.name) === scope.athleteCanonical &&
    String(plan.team ?? '').trim() === scope.athleteTeamTrim &&
    plan.gender === scope.gender
  );
}

function buildPlannedEntriesFromSwims(
  swims: HistoricalSwim[],
  athlete: { name: string; team: string; classYear?: string },
  gender: Gender
): PlannedSwimEntry[] {
  return swims.map(swim =>
    createPlannedEntry({
      name: athlete.name,
      team: athlete.team,
      gender,
      classYear: athlete.classYear,
      event: swim.event,
      time: swim.time,
      timeType: swim.timeType ?? 'SCY',
      source: 'swimcloud',
      active: true,
    })
  );
}

/** The full meetEntryPlans / activeEntryIds / athleteHistory patch for
 * confirming a paste preview: replace this athlete's existing plans with the
 * newly-built ones, and append the accepted swims to history. */
export function buildPastePreviewPatch(params: {
  ws: Workspace;
  athletePlans: PlannedSwimEntry[];
  selectedSwims: HistoricalSwim[];
  athlete: { name: string; team: string; classYear?: string };
  gender: Gender;
  athleteCanonical: string;
  athleteTeamTrim: string;
}): Partial<Workspace> {
  const { ws, athletePlans, selectedSwims, athlete, gender, athleteCanonical, athleteTeamTrim } = params;
  const next = [...athletePlans, ...buildPlannedEntriesFromSwims(selectedSwims, athlete, gender)];
  const basePlans = ws.meetEntryPlans ?? [];
  const removedPlanIds = new Set(athletePlans.map(p => p.id));
  const scope = { athleteCanonical, athleteTeamTrim, gender };

  return {
    meetEntryPlans: [...basePlans.filter(p => !planMatchesAthleteScope(p, scope)), ...next],
    activeEntryIds: [
      ...(ws.activeEntryIds ?? []).filter(id => !removedPlanIds.has(id)),
      ...next.filter(p => p.active !== false).map(p => p.id),
    ],
    athleteHistory: [...(ws.athleteHistory ?? []), ...selectedSwims],
  };
}
