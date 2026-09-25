/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for TeamCard — none of this touches React.
 *
 * These live in one shared file rather than next to a single consumer because
 * both of TeamCard's render trees draw on them: the chart tooltip
 * (`TeamCardTooltips.tsx`) and the team matrix row (`TeamCardMatrixRow.tsx`)
 * each resolve cutline verdicts and relay-leg labels. Homing them in either
 * sibling would make the other import across a boundary it has nothing to do
 * with. Pure extraction from `TeamCard.tsx` — no behavior change.
 */

import type { Gender, RelayLegStroke, SwimmerResult } from '@omniswim/core/types';
import { convertTimeToSeconds, relaySplitQualificationCutEvent } from '@omniswim/core/lib/utils';
import { normalizeEventForCutline } from '@omniswim/core/lib/cutlineUtils';
import {
  buildCutlineTagForTeam,
  buildRelaySwimTagsForTeam,
  convertedSwimOfRecord,
  type CutlineTagResult,
  type RelaySwimTagResults,
} from '@omniswim/core/lib/cutlineTags';

export type TeamRowCutlineTags =
  | { kind: 'relay'; tags: RelaySwimTagResults }
  | { kind: 'single'; result: CutlineTagResult };

/**
 * One cutline verdict per row, except a relay leg carries TWO independent
 * ones: the relay team's own result, and — only for an eligible leg, e.g. a
 * medley relay's backstroke leadoff — the leg split judged as an individual
 * swim. Building both here, once, keeps the two `TeamCard` render sites
 * (event-view tooltip, swimmer-view list) from resolving eligibility
 * differently.
 *
 * `individualTime` is supplied by the caller rather than resolved here so
 * each call site keeps its own pre-existing time fallback for a *non-relay*
 * row (they differ today; this only unifies the relay side, per the actual
 * bug report).
 */
export function buildTeamRowCutlineTags(
  res: SwimmerResult,
  gender: Gender | string,
  teamName: string,
  individualTime: string
): TeamRowCutlineTags {
  // normalizeEventForCutline strips course words, the HyTek "Event N <Gender>"
  // prefix and Time Trial suffixes itself.
  const cleanEventBase = res.event.replace(' (Avg Split)', '').trim();

  if (res.isRelay) {
    return {
      kind: 'relay',
      tags: buildRelaySwimTagsForTeam({
        gender,
        team: teamName,
        relayEvent: cleanEventBase,
        relayTeamTime: res.relayTeamTime || res.finalsTime || res.time,
        legQualificationEvent: relaySplitQualificationCutEvent(res),
        legSplit: res.relayLegSplit,
      }),
    };
  }

  // A recruit row or plan holding a converted SCY estimate is judged as the
  // metric swim it came from: against the yards table it can reach
  // "indicative" but never a cut badge, while an NAIA team's SCM swim is
  // judged against the NAIA SCM column and can earn one. Every other row
  // keeps its caller's time exactly as before.
  const converted = convertedSwimOfRecord(res);
  if (converted) {
    return {
      kind: 'single',
      result: buildCutlineTagForTeam({ gender, team: teamName, ...converted }),
    };
  }

  return {
    kind: 'single',
    result: buildCutlineTagForTeam({
      timeSec: convertTimeToSeconds(individualTime),
      gender,
      event: normalizeEventForCutline(cleanEventBase),
      team: teamName,
    }),
  };
}

export function relayMissingStrokeLabel(stroke: RelayLegStroke | undefined): string {
  if (!stroke) return '';
  const m: Record<RelayLegStroke, string> = { back: 'Back', breast: 'Breast', fly: 'Fly', free: 'Free' };
  return m[stroke] ?? stroke;
}

/** Per-class-year point totals for the class chart's tooltip, top 8 by points. */
export function computeClassTopPerformers(swimmers: SwimmerResult[]): [string, number][] {
  const swimmerPts: Record<string, number> = {};
  swimmers.forEach((s) => {
    if (!swimmerPts[s.name]) swimmerPts[s.name] = 0;
    swimmerPts[s.name] += typeof s.points === 'number' ? s.points : 0;
  });
  return Object.entries(swimmerPts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

/** Swimmers for an event chart's tooltip, highest points first. */
export function sortSwimmersByPoints(swimmers: SwimmerResult[]): SwimmerResult[] {
  return [...swimmers].sort((a: any, b: any) => {
    const pa = typeof a.points === 'number' ? a.points : 0;
    const pb = typeof b.points === 'number' ? b.points : 0;
    return pb - pa;
  });
}

/** x/y/width for a chart tooltip anchored to a mouse event, relative to the nearest recharts wrapper. */
export function classChartTooltipPosition(e: any): { x: number; y: number; containerWidth: number } {
  const rect = (e.target as Element).closest('.recharts-wrapper')?.getBoundingClientRect();
  return {
    x: (e as any).clientX - (rect?.left || 0),
    y: (e as any).clientY - (rect?.top || 0),
    containerWidth: rect?.width || 500,
  };
}
