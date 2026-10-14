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
import { convertTimeToSeconds, formatSecondsToTime, relaySplitQualificationCutEvent } from '@omniswim/core/lib/utils';
import { relayLegEstimateOf } from '@omniswim/core/lib/relaySplits';
import { normalizeEventForCutline } from '@omniswim/core/lib/cutlineUtils';
import {
  buildCutlineTagForTeam,
  buildRelaySwimTagsForTeam,
  convertedSwimOfRecord,
  type CutlineTagResult,
} from '@omniswim/core/lib/cutlineTags';

/** One point of TeamCard's points-by-event line chart (and its tooltip). */
export interface TeamCardEventDatum {
  /** Axis label (shortened). */
  name: string;
  rawEvent: string;
  points: number;
  /** `null` when the event has no momentum entry: "no value", never 0. */
  overUnder: number | null;
  cumulativeOu: number | null;
  noActual: boolean;
  swimmers: SwimmerResult[];
}

/** One bar of TeamCard's points-by-class bar chart (and its tooltip). */
export interface TeamCardClassDatum {
  /** Class year label (FR, SO, JR, SR). */
  name: string;
  points: number;
  color: string;
  swimmers: SwimmerResult[];
}

/** What a chart tooltip renders: an event point or a class bar. */
export type TeamCardTooltipDatum = TeamCardEventDatum | TeamCardClassDatum;

/** The event datum, when the tooltip datum is one (the class datum has no `rawEvent`). */
export function isTeamCardEventDatum(data: TeamCardTooltipDatum): data is TeamCardEventDatum {
  return 'rawEvent' in data;
}

/** A matrix list card grouped by swimmer. */
export interface TeamCardSwimmerGroup {
  name: string;
  points: number;
  swimmers: SwimmerResult[];
  classYear: SwimmerResult['classYear'];
}

/** A matrix list card grouped by event. */
export interface TeamCardEventGroup {
  event: string;
  points: number;
  swimmers: SwimmerResult[];
}

export type TeamCardGroup = TeamCardSwimmerGroup | TeamCardEventGroup;

export function isTeamCardSwimmerGroup(group: TeamCardGroup): group is TeamCardSwimmerGroup {
  return 'name' in group;
}

/** Hover/pinned chart tooltip anchor: position, container width, and the datum under it. */
export interface TeamCardTooltipAnchor<T extends TeamCardTooltipDatum> {
  x: number;
  y: number;
  containerWidth: number;
  payload: T;
}

/**
 * A relay row's two verdicts. `relay` is `null` for an estimated relay (a theoretical meet's relay, whose
 * team time is a sum of individual bests): it is not judged against a relay standard. That is a state of its
 * own, shown as "Estimate, not judged". It is not absent and it is not `no_cut`.
 */
export type RelayRowTags = { relay: CutlineTagResult | null; legQualification: CutlineTagResult | null };

export type TeamRowCutlineTags =
  | { kind: 'relay'; tags: RelayRowTags; relayEstimate: boolean }
  | { kind: 'single'; result: CutlineTagResult };

export const RELAY_ESTIMATE_NOT_JUDGED_LABEL = 'Estimate, not judged';
export const RELAY_ESTIMATE_NOT_JUDGED_TITLE =
  "This relay time is the sum of four swimmers' individual best times. Nobody swam it, so it is not judged against a relay cut.";

/** Leg 1's recorded flat-start best of an estimated relay, as a time string; absent when the row has none. */
function legOneRecordedBest(res: SwimmerResult): string | undefined {
  const estimate = relayLegEstimateOf(res);
  return estimate === undefined ? undefined : formatSecondsToTime(estimate.time);
}

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
 *
 * `estimatedRelay` (from `isEstimatedRelayRow(workspace, res)`): the relay's team time is an estimate. The
 * relay verdict is then withheld (`tags.relay` is `null`, `relayEstimate` is `true`). Leg 1's own verdict may
 * stay, because leg 1 is a recorded flat-start individual best. Legs 2 to 4 keep no verdict.
 */
export function buildTeamRowCutlineTags(
  res: SwimmerResult,
  gender: Gender | string,
  teamName: string,
  individualTime: string,
  estimatedRelay = false
): TeamRowCutlineTags {
  // normalizeEventForCutline strips course words, the HyTek "Event N <Gender>"
  // prefix and Time Trial suffixes itself.
  const cleanEventBase = res.event.replace(' (Avg Split)', '').trim();

  if (res.isRelay) {
    const tags = buildRelaySwimTagsForTeam({
      gender,
      team: teamName,
      relayEvent: cleanEventBase,
      relayTeamTime: res.relayTeamTime || res.finalsTime || res.time,
      legQualificationEvent: relaySplitQualificationCutEvent(res),
      // A theoretical meet's leg row holds no split. Leg 1 is the swimmer's recorded flat-start best (a real
      // individual swim), which is the one leg that may keep its own verdict (see below). Legs 2 to 4 keep none.
      legSplit:
        res.relayLegSplit ??
        (estimatedRelay && res.relayLegIndex === 0 ? legOneRecordedBest(res) : undefined),
    });
    if (!estimatedRelay) return { kind: 'relay', tags, relayEstimate: false };
    return {
      kind: 'relay',
      tags: { relay: null, legQualification: res.relayLegIndex === 0 ? tags.legQualification : null },
      relayEstimate: true,
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
    // A missing, zero or NaN running total restarts at 0, as before.
    const prior = swimmerPts[s.name];
    const running = prior ? prior : 0;
    swimmerPts[s.name] = running + (typeof s.points === 'number' ? s.points : 0);
  });
  return Object.entries(swimmerPts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

/** Swimmers for an event chart's tooltip, highest points first. */
export function sortSwimmersByPoints(swimmers: SwimmerResult[]): SwimmerResult[] {
  return [...swimmers].sort((a, b) => {
    const pa = typeof a.points === 'number' ? a.points : 0;
    const pb = typeof b.points === 'number' ? b.points : 0;
    return pb - pa;
  });
}

/** x/y/width for a chart tooltip anchored to a mouse event, relative to the nearest recharts wrapper. */
export function classChartTooltipPosition(e: { target: EventTarget | null; clientX: number; clientY: number }): { x: number; y: number; containerWidth: number } {
  const rect = (e.target as Element).closest('.recharts-wrapper')?.getBoundingClientRect();
  return {
    x: e.clientX - (rect?.left || 0),
    y: e.clientY - (rect?.top || 0),
    containerWidth: rect?.width || 500,
  };
}
