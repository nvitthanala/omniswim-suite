/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for TeamRosterPanel — none of this touches React.
 */

import { Gender } from '@omniswim/core/types';
import type {
  AthleteEventProfile,
  HistoricalSwim,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '@omniswim/core/types';

const GENDER_MEN = Gender.MEN;
import {
  isPlaceholderAthleteName,
  scorerRosterKey,
  type ScorerRosterRow,
} from '@omniswim/core/lib/scorerRoster';
import { isRelayResult, normalizeSwimmerName } from '@omniswim/core/lib/utils';
import {
  issueBadgeLabel,
  type LineupAthleteIssue,
  type TeamLineupAudit,
} from '@omniswim/core/lib/rosterLineupAudit';
import {
  canonicalMeetEventLabel,
  getAthleteProfile,
  normalizeEventLabel,
} from '@omniswim/core/lib/athleteHistory';
import type { buildAliasResolver } from '@omniswim/core/lib/athleteAliases';
import {
  countSwimmerEntries,
  swimmerExceedsEntryLimits,
} from '@omniswim/core/lib/swimmerEntryLimits';

/**
 * Course suffix read directly off the raw HyTek event label ("Event 4 Men
 * 1000 Yard Freestyle" -> "SCY"). Display-only — it never decides which best
 * a swim counts toward, only whether an unambiguous course tag prints next
 * to the compact event name. "Meters" alone is genuinely ambiguous (SCM or
 * LCM) and is left untagged rather than guessed, per this repo's data
 * provenance rule against inventing a value that was not published.
 */
function courseSuffixFromRawEvent(raw: string): string {
  if (/\byards?\b/i.test(raw)) return 'SCY';
  if (/\blcm\b/i.test(raw) || /\blong course meters?\b/i.test(raw)) return 'LCM';
  if (/\bscm\b/i.test(raw) || /\bshort course meters?\b/i.test(raw)) return 'SCM';
  return '';
}

const STROKE_ABBREVIATIONS: [string, string][] = [
  ['Freestyle', 'Free'],
  ['Backstroke', 'Back'],
  ['Breaststroke', 'Breast'],
  ['Butterfly', 'Fly'],
  ['Individual Medley', 'IM'],
];

/**
 * Compact display label for a meet-event string as recorded on an
 * AthleteEventProfile ("Event 4 Men 1000 Yard Freestyle" -> "1000 Free
 * (SCY)"). Built on core's own canonicalizer (`canonicalMeetEventLabel`) so
 * this never re-derives what counts as the same event — it only shortens the
 * stroke name and appends a course tag when the raw label states one
 * unambiguously. Falls back to `normalizeEventLabel`, then the raw string
 * itself, for relay/dive labels `canonicalMeetEventLabel` declines to touch,
 * so a profile's event list never prints raw "Event N ... Yard ..."
 * scaffolding.
 */
export function formatEventLabelForDisplay(raw: string): string {
  const canonical = canonicalMeetEventLabel(raw) ?? normalizeEventLabel(raw) ?? raw;
  let compact = canonical;
  for (const [long, short] of STROKE_ABBREVIATIONS) {
    if (compact.endsWith(long)) {
      compact = `${compact.slice(0, compact.length - long.length)}${short}`;
      break;
    }
  }
  const course = courseSuffixFromRawEvent(raw);
  return course ? `${compact} (${course})` : compact;
}

/**
 * Distinct-athlete count per team. Relay-only placeholder rows ("—" vacant
 * legs, and a relay row whose name is the team itself) don't count as
 * roster members; a real athlete counts once no matter how many result rows
 * they appear in (dedup keyed by team+gender+name).
 */
export function countTeamMembers(genderResults: SwimmerResult[], gender: Gender): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Map<string, Set<string>>();
  for (const r of genderResults) {
    const t = String(r.team ?? '').trim();
    if (!t) continue;
    if (isRelayResult(r) && r.name === r.team) continue;
    // Vacated / placeholder relay legs ("—") are not athletes — don't count them.
    if (isRelayResult(r) && isPlaceholderAthleteName(r.name)) continue;
    const key = scorerRosterKey(t, gender, r.name);
    if (!seen.has(t)) seen.set(t, new Set());
    const teamSeen = seen.get(t)!;
    if (teamSeen.has(key)) continue;
    teamSeen.add(key);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

type EntryLimitFlags = { individualOver: boolean; relayOver: boolean; totalOver: boolean };

export type RosterRowIssueFlags = {
  showOver: boolean;
  showEmpty: boolean;
  relayGapIssue: LineupAthleteIssue | undefined;
};

const RELAY_GAP_ISSUE_TYPES = new Set(['relay_leg_vacant', 'relay_scorer_off', 'relay_needs_fill']);

/** Which warning states apply to a roster row, derived from its entry-limit and audit issues. */
export function computeRosterRowIssueFlags(
  entryOver: EntryLimitFlags,
  athleteIssues: LineupAthleteIssue[]
): RosterRowIssueFlags {
  const showOver =
    entryOver.individualOver ||
    entryOver.relayOver ||
    entryOver.totalOver ||
    athleteIssues.some(i => i.type === 'over_entry_limit');
  const showEmpty = athleteIssues.some(i => i.type === 'empty_lineup');
  const relayGapIssue = athleteIssues.find(i => RELAY_GAP_ISSUE_TYPES.has(i.type));
  return { showOver, showEmpty, relayGapIssue };
}

export type RosterRowWarnings = { warningMessages: string[]; warningLabel: string | null };

/**
 * Condenses a row's warning pills into a single compact chip — a sprawl of
 * "Over limit" / "Empty lineup" / relay-gap badges per row ate too much
 * horizontal space. The chip's title lists every issue.
 */
export function buildRosterRowWarnings(flags: RosterRowIssueFlags): RosterRowWarnings {
  const { showOver, showEmpty, relayGapIssue } = flags;
  const warningMessages: string[] = [];
  if (showOver) warningMessages.push('Over entry limit');
  if (showEmpty) warningMessages.push('Scorer with no individual entries');
  if (relayGapIssue) warningMessages.push(relayGapIssue.message);

  let warningLabel: string | null = null;
  if (showOver) warningLabel = 'Over limit';
  else if (showEmpty) warningLabel = 'Empty lineup';
  else if (relayGapIssue) warningLabel = issueBadgeLabel(relayGapIssue);

  return { warningMessages, warningLabel };
}

/**
 * Tooltip for the per-athlete event list. The list is ordered by how good each
 * swim is against the published standard for the team's division, so say so and
 * show the number — otherwise the order looks arbitrary, and it used to be
 * (raw elapsed seconds, which just ranks the shortest events first).
 */
export function describeStrongestEvents(profile: AthleteEventProfile): string {
  const ratios = profile.qualityByEvent ?? {};
  const lines = profile.primaryEvents.map(event => {
    const label = formatEventLabelForDisplay(event);
    const r = ratios[event];
    return r ? `${label} — ${(r * 100).toFixed(1)}% of the standard` : `${label} — no published standard`;
  });
  const header = profile.rankingDivision
    ? `Strongest first, vs the published ${profile.rankingDivision} standard (lower is better):`
    : 'Division unknown, so these are not ranked against a standard:';
  const unranked = profile.unrankedEvents?.length
    ? `\n\nNo published standard to judge: ${profile.unrankedEvents.map(formatEventLabelForDisplay).join(', ')}`
    : '';
  return `${header}\n${lines.join('\n')}${unranked}`;
}

export type RosterRowContext = {
  genderResults: SwimmerResult[];
  gender: Gender;
  aliasResolver: ReturnType<typeof buildAliasResolver>;
  settings: ScoringSettings;
  lineupAudit?: TeamLineupAudit;
  workspace?: Workspace;
  /** Same truthiness gate the row previously read directly (`workspace && selectedTeam`). */
  hasSelectedTeam: boolean;
  mergedAthleteHistory: HistoricalSwim[];
  pointTotals: Map<string, number>;
};

export type RosterRowViewModel = {
  meetPts: number;
  athleteIssues: LineupAthleteIssue[];
  profile: AthleteEventProfile | null;
  warningMessages: string[];
  warningLabel: string | null;
};

/**
 * Per-row derived state for the roster table: meet points, the athlete's
 * event profile (for the strongest-events tooltip), and the condensed
 * warning chip. Pulled out of TeamRosterPanel's JSX so the row map isn't
 * where this branching lives.
 */
export function buildRosterRowViewModel(row: ScorerRosterRow, ctx: RosterRowContext): RosterRowViewModel {
  const meetPts = ctx.pointTotals.get(row.key) ?? 0;
  const entryCounts = countSwimmerEntries(
    ctx.genderResults,
    row.team,
    ctx.gender,
    row.name,
    ctx.aliasResolver,
    ctx.settings
  );
  const entryOver = swimmerExceedsEntryLimits(entryCounts, ctx.settings);
  const athleteIssues = ctx.lineupAudit?.athleteIssues.get(normalizeSwimmerName(row.name)) ?? [];
  const profile =
    ctx.workspace && ctx.hasSelectedTeam
      ? getAthleteProfile(
          ctx.workspace,
          row.team,
          ctx.gender,
          row.name,
          ctx.settings,
          ctx.aliasResolver,
          ctx.mergedAthleteHistory
        )
      : null;
  const { warningMessages, warningLabel } = buildRosterRowWarnings(
    computeRosterRowIssueFlags(entryOver, athleteIssues)
  );
  return { meetPts, athleteIssues, profile, warningMessages, warningLabel };
}

/** "Men's" / "Women's" for the roster header — kept as a named lookup rather
 * than an inline ternary in the panel body. */
export function genderLabelFor(gender: Gender): string {
  return gender === GENDER_MEN ? "Men's" : "Women's";
}

/** Extra header column count for the roster table: the scorer toggle column
 * (when editable) and the remove column (when a delete handler is wired). */
export function rosterColSpan(editable: boolean, hasDeleteHandler: boolean): number {
  if (!editable) return 2;
  return hasDeleteHandler ? 4 : 3;
}

export type TeamPickerMode = 'sidebar' | 'dropdown';

/** Resolves the sidebar-vs-dropdown team picker from the panel's `showTeamSidebar`
 * / `teamPickerMode` props into the two booleans the render logic switches on. */
export function resolveTeamPickerMode(
  showTeamSidebar: boolean,
  teamPickerMode: TeamPickerMode | undefined
): { useDropdown: boolean; useSidebar: boolean } {
  const useDropdown = teamPickerMode === 'dropdown' || (!showTeamSidebar && teamPickerMode !== 'sidebar');
  const useSidebar = showTeamSidebar && !useDropdown;
  return { useDropdown, useSidebar };
}
