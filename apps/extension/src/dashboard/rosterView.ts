/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a: what the Rosters tab shows for one team. Pure: stored records in, display rows out. No storage, no network.
 *
 * - Class year comes from `resolveClassYear` (override, then SwimCloud, then absent) for the CURRENT season. It needs the current season's label.
 *   Without the label no row can be resolved, and the view says so instead of showing "?" for everyone.
 * - Membership comes from `enrichRosterMembership`. The preview never feeds scoring or parity (decision P).
 */
import { enrichRosterMembership } from '@omniswim/swimcloud/browser';
import type { AdaptedSimulator, EnrichMode, EnrichResult, RosterEvidence } from '@omniswim/swimcloud/browser';
import type { ClassYearCode, ClassYearOverrideRecord, RosterRecord } from '../storage';
import { classifyRoster, resolveClassYear, toSwimCloudId } from '../storage';

/** How a stored roster reads to the membership rule. `undefined` is "not loaded". */
export function rosterEvidence(record: RosterRecord | undefined): RosterEvidence {
  if (record === undefined) return { state: 'not-loaded' };
  return classifyRoster(record) === 'verified-empty'
    ? { state: 'verified-empty', gender: record.gender }
    : { state: 'members', gender: record.gender, memberIds: record.memberIds };
}

export type ClassYearSource = 'SwimCloud' | 'you' | '?';

export interface RosterRow {
  readonly swimmerId: string;
  readonly membership: 'member' | 'not_member' | 'unknown';
  readonly classYear: ClassYearCode | null;
  readonly source: ClassYearSource;
}

export interface TeamRosterView {
  readonly teamId: string;
  /** The roster the membership rows read: the chosen season's, or the current one in "Simulator (current)" mode. */
  readonly enrichment: EnrichResult;
  readonly rows: readonly RosterRow[];
}

export interface TeamViewInput {
  readonly adapted: Pick<AdaptedSimulator, 'model' | 'lineup'>;
  readonly teamId: string;
  readonly mode: EnrichMode;
  /** The stored roster the membership rule reads. */
  readonly membershipRoster: RosterRecord | undefined;
  /** The stored roster of the current season, for class years. */
  readonly currentRoster: RosterRecord | undefined;
  /** Every override stored for the current season. */
  readonly overrides: readonly ClassYearOverrideRecord[];
  /** The current season's label, or `null` when it is not known. With `null` every class year is unresolved. */
  readonly currentLabel: string | null;
}

export function buildTeamView(input: TeamViewInput): TeamRosterView {
  const { adapted, teamId, currentLabel } = input;
  const swimmers = adapted.model.swimmers.filter((s) => s.teamId === teamId);
  const resolved = new Map<string, ReturnType<typeof resolveClassYear>>();
  if (currentLabel !== null) {
    for (const s of swimmers) {
      // A simulator id that is not a SwimCloud id cannot have a stored override or roster entry; it stays absent.
      let id;
      try { id = toSwimCloudId(s.swimmerId); } catch { continue; }
      const override = input.overrides.find((o) => o.swimmerId === id && o.seasonId === currentLabel);
      resolved.set(s.swimmerId, resolveClassYear({
        swimmerId: id,
        seasonId: currentLabel,
        ...(override ? { override } : {}),
        ...(input.currentRoster && input.currentRoster.seasonId === currentLabel ? { roster: input.currentRoster } : {}),
      }));
    }
  }
  const classYears: Record<string, ClassYearCode | null> = {};
  for (const [id, r] of resolved) classYears[id] = r.state === 'absent' ? null : r.classYear;
  const enrichment = enrichRosterMembership(
    { model: adapted.model, lineup: adapted.lineup },
    { mode: input.mode, rosters: { [teamId]: rosterEvidence(input.membershipRoster) }, classYears },
  );
  const rows = enrichment.model.swimmers.filter((s) => s.teamId === teamId).map((s): RosterRow => {
    const r = resolved.get(s.swimmerId);
    return {
      swimmerId: s.swimmerId,
      membership: s.roster,
      classYear: s.classYear,
      source: r === undefined || r.state === 'absent' ? '?' : r.state === 'user' ? 'you' : 'SwimCloud',
    };
  });
  return { teamId, enrichment, rows };
}
