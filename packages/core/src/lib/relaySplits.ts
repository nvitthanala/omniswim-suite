/**

 * @license

 * SPDX-License-Identifier: Apache-2.0

 */



import {

  RelayLegSplitDetail,

  RelayLegStroke,

  RelaySplitSegment,

  RelayTeamSplitSummary,

  SwimmerResult,

} from '../types';

import { convertTimeToSeconds, formatSecondsToTime } from './utils';



export type RelayKind = 'medley' | 'freestyle';



/** Total relay distance in yards from event name (e.g. 800 for 4×200). */

export function parseRelayDistanceYards(event: string): number {

  const ev = event.toLowerCase();

  const fourX = ev.match(/4\s*[x×]\s*(\d+)/);

  if (fourX) return parseInt(fourX[1], 10) * 4;

  const m = ev.match(/\b(\d{3,4})\b/);

  if (m) return parseInt(m[1], 10);

  if (/\b200\b/.test(ev)) return 200;

  if (/\b400\b/.test(ev)) return 400;

  return 200;

}



export function relayLegDistanceYards(relayDistanceYards: number): number {

  return relayDistanceYards / 4;

}



export function relayKind(event: string): RelayKind {

  return /medley/i.test(event) ? 'medley' : 'freestyle';

}



function asOptionalString(v: unknown): string | undefined {

  if (v == null || v === '') return undefined;

  return String(v);

}



/** Accept parser / persisted snake_case or frontend camelCase. */

export function normalizeRelaySplitSegment(raw: unknown): RelaySplitSegment | null {

  if (!raw || typeof raw !== 'object') return null;

  const o = raw as Record<string, unknown>;

  const segmentTime = asOptionalString(o.segmentTime ?? o.segment_time);

  if (!segmentTime) return null;

  const yards = typeof o.yards === 'number' ? o.yards : 0;

  const cumulativeLeg = asOptionalString(o.cumulativeLeg ?? o.cumulative_leg);

  return { yards, segmentTime, cumulativeLeg };

}



export function normalizeRelayLegSplitDetail(raw: unknown): RelayLegSplitDetail | undefined {

  if (!raw || typeof raw !== 'object') return undefined;

  const o = raw as Record<string, unknown>;

  const legIndexRaw = o.legIndex ?? o.leg_index;

  const legIndex = typeof legIndexRaw === 'number' ? legIndexRaw : 0;

  const stroke = (o.stroke as RelayLegStroke) || 'free';

  const legDistanceRaw = o.legDistanceYards ?? o.leg_distance_yards;

  const legDistanceYards =

    typeof legDistanceRaw === 'number' ? legDistanceRaw : relayLegDistanceYards(200);

  const segments = Array.isArray(o.segments)

    ? o.segments.map(normalizeRelaySplitSegment).filter((s): s is RelaySplitSegment => s != null)

    : [];

  const legTotal = asOptionalString(o.legTotal ?? o.leg_total);

  return { legIndex, stroke, legDistanceYards, segments, legTotal };

}



export function normalizeRelayTeamSplits(raw: unknown): RelayTeamSplitSummary | undefined {

  if (!raw || typeof raw !== 'object') return undefined;

  const o = raw as Record<string, unknown>;

  const legTotalsRaw = o.legTotals ?? o.leg_totals;

  const legTotals = Array.isArray(legTotalsRaw)

    ? legTotalsRaw.map(t => (t == null || t === '' ? null : String(t)))

    : [];

  const teamTotal = asOptionalString(o.teamTotal ?? o.team_total) ?? '';

  const firstHalf = asOptionalString(o.firstHalf ?? o.first_half);

  const secondHalf = asOptionalString(o.second_half ?? o.secondHalf);

  return { legTotals, firstHalf, secondHalf, teamTotal };

}



/** Plausible per-leg total for athlete display (not team cumulative clock). */

export function isPlausibleLegTotal(timeStr: string, legDistanceYards: number): boolean {

  const sec = convertTimeToSeconds(timeStr);

  if (!Number.isFinite(sec) || sec <= 0) return false;

  const bounds: Record<number, [number, number]> = {

    50: [12, 50],

    100: [28, 95],

    200: [55, 155],

  };

  const [minS, maxS] = bounds[legDistanceYards] ?? [

    Math.max(8, legDistanceYards * 0.15),

    legDistanceYards * 0.85,

  ];

  return sec >= minS && sec <= maxS;

}



function relayTeamClock(row: SwimmerResult): string {

  return String(row.relayTeamTime ?? row.finalsTime ?? row.time ?? '').trim();

}



function pickPlausibleLegTime(

  candidate: string | null | undefined,

  legDistanceYards: number,

  teamClock: string

): string | undefined {

  if (!candidate || candidate === 'NT' || candidate === teamClock) return undefined;

  return isPlausibleLegTotal(candidate, legDistanceYards) ? candidate : undefined;

}



/** Leg split for UI / crediting — never the relay team clock. */

export function displayTimeForRelayLeg(row: SwimmerResult): string {

  const detail = normalizeRelayLegSplitDetail(row.relayLegSplitDetail);

  const legDist =

    detail?.legDistanceYards ?? relayLegDistanceYards(parseRelayDistanceYards(row.event || ''));

  const teamClock = relayTeamClock(row);

  const legIdx = row.relayLegIndex ?? detail?.legIndex;



  const fromDetail = pickPlausibleLegTime(detail?.legTotal, legDist, teamClock);

  if (fromDetail) return fromDetail;



  const fromTop = pickPlausibleLegTime(row.relayLegSplit, legDist, teamClock);

  if (fromTop) return fromTop;



  const teamSplits = normalizeRelayTeamSplits(row.relayTeamSplits);

  if (teamSplits && legIdx != null && legIdx >= 0) {

    const fromSummary = pickPlausibleLegTime(teamSplits.legTotals[legIdx] ?? undefined, legDist, teamClock);

    if (fromSummary) return fromSummary;

  }



  if (detail?.segments?.length) {

    for (let i = detail.segments.length - 1; i >= 0; i--) {

      const seg = detail.segments[i];

      if (seg.yards >= legDist) {

        const cum = pickPlausibleLegTime(seg.cumulativeLeg, legDist, teamClock);

        if (cum) return cum;

        const fullSeg = pickPlausibleLegTime(seg.segmentTime, legDist, teamClock);

        if (fullSeg) return fullSeg;

      }

    }

    for (let i = detail.segments.length - 1; i >= 0; i--) {

      const segT = pickPlausibleLegTime(detail.segments[i].segmentTime, legDist, teamClock);

      if (segT) return segT;

    }

  }



  return '—';

}



/** Normalize relay split fields on a swimmer row (snake_case → camelCase). */

export function normalizeSwimmerResultRelayFields(r: SwimmerResult): SwimmerResult {

  const isRelay = Boolean(r.isRelay) || /\brelay\b/i.test(String(r.event || ''));

  if (!isRelay) return r;



  const detail = normalizeRelayLegSplitDetail(r.relayLegSplitDetail);

  const teamSplits = normalizeRelayTeamSplits(r.relayTeamSplits);

  const displaySplit = displayTimeForRelayLeg({

    ...r,

    isRelay: true,

    relayLegSplitDetail: detail,

    relayTeamSplits: teamSplits,

  });



  let relayLegSplit = r.relayLegSplit;

  const teamClock = relayTeamClock(r);

  if (relayLegSplit === teamClock) relayLegSplit = undefined;

  if (displaySplit !== '—' && displaySplit !== relayLegSplit) {

    relayLegSplit = displaySplit;

  }



  const normalizedDetail =

    detail && displaySplit !== '—'

      ? { ...detail, legTotal: detail.legTotal ?? displaySplit }

      : detail;



  return {

    ...r,

    isRelay: true,

    relayLegSplitDetail: normalizedDetail,

    relayTeamSplits: teamSplits,

    relayLegSplit: relayLegSplit ?? (displaySplit !== '—' ? displaySplit : r.relayLegSplit),

  };

}



function segmentLabel(yards: number): string {

  if (yards >= 200) return '200';

  if (yards >= 100) return '100';

  if (yards >= 50) return '50';

  if (yards >= 25) return '25';

  return `${yards}y`;

}



export function formatLegSplitSummary(detail: RelayLegSplitDetail | unknown): string {

  const normalized = normalizeRelayLegSplitDetail(detail);

  if (!normalized) return '—';

  const { segments, legTotal, legDistanceYards } = normalized;

  if (!segments.length) return legTotal || '—';

  const incrementalFifties = segments.length > 1 && segments.every(s => s.yards === 50);

  if (incrementalFifties) {

    let cumSec = 0;

    const parts: string[] = [];

    for (let i = 0; i < segments.length; i++) {

      const mark = 50 * (i + 1);

      const lapSec = convertTimeToSeconds(segments[i].segmentTime);

      cumSec += lapSec;

      const timeStr =

        i === segments.length - 1 && legTotal ? legTotal : formatSecondsToTime(cumSec);

      const lapStr = segments[i].segmentTime;

      if (i === 0) {

        parts.push(`${mark} ${timeStr}`);

      } else {

        parts.push(`${mark} ${timeStr} (${lapStr})`);

      }

    }

    return parts.join(' · ');

  }

  const parts: string[] = [];

  for (const seg of segments) {

    parts.push(`${segmentLabel(seg.yards)} ${seg.segmentTime}`);

  }

  if (legTotal && legDistanceYards <= 50 && !parts.some(p => p.endsWith(legTotal))) {

    parts.push(legTotal);

  } else if (legTotal && legDistanceYards > 50 && !parts.some(p => p.endsWith(legTotal))) {

    parts.push(`total ${legTotal}`);

  }

  return parts.length > 0 ? parts.join(' · ') : legTotal || '—';

}



export function formatTeamSplitSummary(summary: RelayTeamSplitSummary | unknown): string {

  const normalized = normalizeRelayTeamSplits(summary);

  if (!normalized) return '—';

  const legs = normalized.legTotals

    .map((t, i) => (t ? `L${i + 1} ${t}` : null))

    .filter(Boolean)

    .join(' · ');

  const halves = [

    normalized.firstHalf ? `1st half ${normalized.firstHalf}` : null,

    normalized.secondHalf ? `2nd half ${normalized.secondHalf}` : null,

    normalized.teamTotal ? `team ${normalized.teamTotal}` : null,

  ]

    .filter(Boolean)

    .join(' · ');

  return [legs, halves].filter(Boolean).join(' | ') || normalized.teamTotal || '—';

}



/** Sum leg totals when all four are parseable. */

export function computeRelayHalves(legTotals: (string | null)[]): {

  firstHalf?: string;

  secondHalf?: string;

} {

  const secs = legTotals.map(t => (t && t !== 'NT' ? convertTimeToSeconds(t) : NaN));

  if (secs.length < 4 || secs.some(s => !Number.isFinite(s))) return {};

  return {

    firstHalf: formatSecondsToTime(secs[0] + secs[1]),

    secondHalf: formatSecondsToTime(secs[2] + secs[3]),

  };

}



export function buildSyntheticLegSplitDetail(

  legIndex: number,

  stroke: RelayLegStroke,

  legDistanceYards: number,

  legTotal: string,

  priorSegments?: RelaySplitSegment[]

): RelayLegSplitDetail {

  const totalSec = convertTimeToSeconds(legTotal);

  if (

    priorSegments &&

    priorSegments.length > 0 &&

    priorSegments.every(s => s.segmentTime && convertTimeToSeconds(s.segmentTime) > 0)

  ) {

    const oldTotal = priorSegments.reduce(

      (max, s) => Math.max(max, convertTimeToSeconds(s.cumulativeLeg || s.segmentTime)),

      0

    );

    const scale = oldTotal > 0 ? totalSec / oldTotal : 1;

    const segments = priorSegments.map(s => {

      const segSec = convertTimeToSeconds(s.segmentTime) * scale;

      return {

        yards: s.yards,

        segmentTime: formatSecondsToTime(segSec),

        cumulativeLeg: s.cumulativeLeg

          ? formatSecondsToTime(convertTimeToSeconds(s.cumulativeLeg) * scale)

          : undefined,

      };

    });

    return { legIndex, stroke, legDistanceYards, segments, legTotal };

  }

  return {

    legIndex,

    stroke,

    legDistanceYards,

    segments: [{ yards: legDistanceYards, segmentTime: legTotal, cumulativeLeg: legTotal }],

    legTotal,

  };

}



export function rebuildTeamSplitSummary(

  legTotals: (string | null)[],

  teamTotal: string

): RelayTeamSplitSummary {

  const halves = computeRelayHalves(legTotals);

  return {

    legTotals,

    firstHalf: halves.firstHalf,

    secondHalf: halves.secondHalf,

    teamTotal,

  };

}



export function relayEntryKey(r: SwimmerResult): string {

  const clock = r.relayTeamTime || r.finalsTime || r.time;

  return `${r.team}|${r.event}|${(r.roundSwam || '').trim()}|${r.rank}|${clock}`;

}


