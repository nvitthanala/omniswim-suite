/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for AthleteLineupEditorPanel — none of this touches
 * React. Split out because the relay-involvement scan carries real matching
 * logic (an athlete can be found on a leg directly, or only as the swimmer
 * who vacated it) that is worth naming and testing on its own.
 */

import type { SwimmerResult } from '@omniswim/core/types';
import { isRelayResult, normalizeSwimmerName } from '@omniswim/core/lib/utils';
import { relayMissingStrokeLabel, stableRelayEntryKey } from '@omniswim/core/lib/relayLegMatching';
import type { LineupAthleteIssue } from '@omniswim/core/lib/rosterLineupAudit';

export type RelayInvolvement = {
  event: string;
  legIndex: number;
  status: 'ok' | 'vacant' | 'removed';
  statusLabel: string;
  relayEntryKey: string;
};

type RelayLegContext = {
  pdf: SwimmerResult[];
  leg: SwimmerResult;
  legIdx: number;
  team: string;
  nameKey: string;
};

/** `r` is the relay row that has this athlete swimming this exact leg. */
function matchesLegDirect(r: SwimmerResult, ctx: RelayLegContext): boolean {
  const { leg, team, legIdx, nameKey } = ctx;
  if (!isRelayResult(r) || r.team !== team) return false;
  if (r.event !== leg.event || r.rank !== leg.rank) return false;
  if ((r.relayLegIndex ?? -1) !== legIdx) return false;
  return normalizeSwimmerName(r.name) === nameKey;
}

/** `r` is the relay row whose `relayNames` roster names this athlete on this leg. */
function matchesLegByRelayName(r: SwimmerResult, ctx: RelayLegContext): boolean {
  const { leg, team, legIdx, nameKey } = ctx;
  return (
    isRelayResult(r) &&
    r.team === team &&
    r.event === leg.event &&
    Boolean(r.relayNames?.[legIdx]) &&
    normalizeSwimmerName(r.relayNames![legIdx].name) === nameKey
  );
}

/** `r` is the relay row recording this athlete as the swimmer who vacated this leg. */
function matchesDepartedDirect(r: SwimmerResult, ctx: RelayLegContext): boolean {
  const { leg, team, legIdx, nameKey } = ctx;
  return (
    isRelayResult(r) &&
    r.team === team &&
    r.event === leg.event &&
    (r.relayLegIndex ?? -1) === legIdx &&
    normalizeSwimmerName(r.name) === nameKey
  );
}

/**
 * True when this athlete swam `leg` directly, or — for a vacant leg — is the
 * name recorded either on the matching direct row or in `relayNames`.
 */
function isAthleteOnLeg(ctx: RelayLegContext, isVacant: boolean): boolean {
  if (normalizeSwimmerName(ctx.leg.name) === ctx.nameKey) return true;
  if (!isVacant) return false;
  return (
    ctx.pdf.some(r => matchesLegDirect(r, ctx)) || ctx.pdf.some(r => matchesLegByRelayName(r, ctx))
  );
}

/** The row recording this athlete as the swimmer who vacated `leg`, if any. */
function findDepartedRow(ctx: RelayLegContext): SwimmerResult | undefined {
  return ctx.pdf.find(r => matchesDepartedDirect(r, ctx)) || ctx.pdf.find(r => matchesLegByRelayName(r, ctx));
}

function relayLegStatus(
  isVacant: boolean,
  leg: SwimmerResult,
  issues: LineupAthleteIssue[]
): { status: RelayInvolvement['status']; statusLabel: string } {
  if (!isVacant) return { status: 'ok', statusLabel: 'OK' };
  const scorerOff = issues.some(i => i.type === 'relay_scorer_off');
  if (scorerOff) return { status: 'removed', statusLabel: 'Removed — not a scorer; fill this leg' };
  const stroke = relayMissingStrokeLabel(leg.relayMissingLeg?.stroke);
  return { status: 'vacant', statusLabel: stroke ? `Vacant — needs ${stroke}` : 'Vacant — needs filling' };
}

/** Skip a leg this athlete has no bearing on: not on it, and not the one who vacated it. */
function shouldSkipLeg(ctx: RelayLegContext, onThisLeg: boolean, isVacant: boolean): boolean {
  if (onThisLeg) return false;
  if (!isVacant) return true;
  return !findDepartedRow(ctx);
}

/**
 * One row per relay leg this athlete is involved in — either currently
 * swimming it, or having vacated it (surfaced so a non-scorer's or removed
 * athlete's relay gaps stay visible on their drawer).
 */
export function buildRelayInvolvement(
  scoredResults: SwimmerResult[],
  pdf: SwimmerResult[],
  team: string,
  nameKey: string,
  issues: LineupAthleteIssue[]
): RelayInvolvement[] {
  const out: RelayInvolvement[] = [];
  const seen = new Set<string>();

  for (const leg of scoredResults) {
    if (!isRelayResult(leg) || String(leg.team ?? '').trim() !== team) continue;
    if (leg.name === leg.team) continue;

    const entryKey = stableRelayEntryKey(pdf, leg);
    const legIdx = leg.relayLegIndex ?? 0;
    const rowKey = `${entryKey}|${legIdx}`;
    if (seen.has(rowKey)) continue;

    const ctx: RelayLegContext = { pdf, leg, legIdx, team, nameKey };
    const isVacant = Boolean(leg.relayLegVacant || leg.relayMissingLeg);
    const onThisLeg = isAthleteOnLeg(ctx, isVacant);
    if (shouldSkipLeg(ctx, onThisLeg, isVacant)) continue;

    seen.add(rowKey);
    const { status, statusLabel } = relayLegStatus(isVacant, leg, issues);
    out.push({ event: leg.event, legIndex: legIdx, status, statusLabel, relayEntryKey: entryKey });
  }

  return out;
}
