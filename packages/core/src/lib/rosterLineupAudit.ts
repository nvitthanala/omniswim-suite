/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Team lineup compliance audit for Manager roster workflow.
 */

import {
  Gender,
  RelayLegOverride,
  ScorerRosterOverride,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '../types';
import { buildScorerRosterLookup, scorerRosterKey, usesScorerRoster } from './scorerRoster';
import {
  countSwimmerEntries,
  swimmerExceedsEntryLimits,
} from './swimmerEntryLimits';
import { mergeScoringSettings } from './scoringDefaults';
import {
  relayMissingStrokeLabel,
  relayTemplateFromLeg,
  stableRelayEntryKey,
  suggestBestRelayLegFill,
  upsertRelayLegOverride,
} from './relayLegMatching';
import { relayEntryKey } from './relaySplits';
import { buildAliasResolver, detectDuplicateAthletes } from './athleteAliases';
import type { DuplicateAthletePair } from './athleteAliases';
import { isRelayResult, normalizeSwimmerName } from './utils';

export type { DuplicateAthletePair } from './athleteAliases';
export {
  detectDuplicateAthletes,
  linkDuplicateAthletePair,
  dismissDuplicateAthletePair,
} from './athleteAliases';

export type LineupIssueType =
  | 'over_entry_limit'
  | 'empty_lineup'
  | 'relay_leg_vacant'
  | 'relay_scorer_off'
  | 'relay_needs_fill'
  /** Two name spellings on this team that are probably one athlete. */
  | 'duplicate_athlete';

export type LineupAthleteIssue = {
  type: LineupIssueType;
  message: string;
  relayEvent?: string;
  legIndex?: number;
  relayEntryKey?: string;
  /** Present only on `duplicate_athlete` issues — the other spelling + evidence. */
  duplicate?: DuplicateAthletePair;
};

export type LineupChecklistItem = {
  id: string;
  type: LineupIssueType;
  group: 'entries' | 'lineups' | 'relays' | 'roster';
  message: string;
  athleteName?: string;
  /** ScorerRosterRow.key for the named athlete — lets a Jump match by key, not raw name. */
  athleteKey?: string;
  relayEvent?: string;
  legIndex?: number;
  relayEntryKey?: string;
  /**
   * Present only on `duplicate_athlete` items. Carries BOTH spellings plus the
   * evidence, so the UI can offer Link / Not-the-same-person without re-running
   * the detector. Feed it straight to `linkDuplicateAthletePair` /
   * `dismissDuplicateAthletePair`.
   */
  duplicate?: DuplicateAthletePair;
};

export type TeamLineupAudit = {
  athleteIssues: Map<string, LineupAthleteIssue[]>;
  checklistItems: LineupChecklistItem[];
  vacantRelayLegCount: number;
};

export type LineupAuditInput = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  settings: ScoringSettings;
  /** Projected pool (what-if results before scoring). */
  allResults: SwimmerResult[];
  /** Scored projection rows (relay vacant flags). */
  allScored: SwimmerResult[];
  removeSeniors: boolean;
  /**
   * Scan the team for athletes split across two name spellings (default true).
   * Set false only to skip the O(n^2) name scan on a hot path — the split is
   * still there, it just stops being reported.
   */
  detectDuplicates?: boolean;
};

/** Swimmers on relay legs who are not scorers — legs vacated in projection (non-scorers cannot swim relays). */
export function computeVacateRelayLegNames(
  results: SwimmerResult[],
  gender: Gender,
  settings: ScoringSettings,
  overrides: ScorerRosterOverride[] = []
): Set<string> {
  const merged = mergeScoringSettings(settings);
  if (!usesScorerRoster(merged)) return new Set();

  const genderResults = results.filter(r => r.gender == null || r.gender === gender);
  const lookup = buildScorerRosterLookup(genderResults, merged, overrides, gender);
  const vacate = new Set<string>();

  const relayTemplates = new Map<string, SwimmerResult>();
  for (const r of genderResults) {
    if (!isRelayResult(r) || r.name === r.team) continue;
    const template = relayTemplateFromLeg(genderResults, r);
    const key = relayEntryKey(template);
    if (!relayTemplates.has(key)) relayTemplates.set(key, template);
  }

  for (const template of relayTemplates.values()) {
    const legs =
      template.relayNames && template.relayNames.length > 0
        ? template.relayNames
        : genderResults
            .filter(
              x =>
                x.isRelay &&
                x.team === template.team &&
                x.event === template.event &&
                x.rank === template.rank &&
                (x.roundSwam || '').trim() === (template.roundSwam || '').trim()
            )
            .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0))
            .map(x => ({ name: x.name, year: String(x.classYear) }));

    for (const leg of legs) {
      const nm = leg.name?.trim();
      if (!nm || nm === '—' || nm === 'Unknown') continue;
      if (!lookup.isScorer(nm, template.team, gender)) {
        vacate.add(normalizeSwimmerName(nm));
      }
    }
  }

  return vacate;
}

/**
 * When a swimmer is toggled off as a scorer, prune any relay overrides naming them.
 * Projection vacates their legs via computeVacateRelayLegNames (non-scorers cannot swim relays).
 */
export function applyScorerOffRelayPatch(
  workspace: Workspace,
  opts: { name: string; team: string; gender: Gender; isScorer: boolean; overrides: ScorerRosterOverride[] }
): Partial<Workspace> {
  const patch: Partial<Workspace> = {
    scorerRosterOverrides: opts.overrides,
  };
  if (!opts.isScorer) {
    patch.relayLegOverrides = pruneRelayOverridesForSwimmer(
      workspace.relayLegOverrides ?? [],
      opts.name
    );
  }
  return patch;
}

function teamFrom(t: string | undefined): string {
  return String(t ?? '').trim();
}

export function buildTeamLineupAudit(input: LineupAuditInput): TeamLineupAudit {
  const {
    workspace,
    gender,
    team,
    settings,
    allResults,
    allScored,
    removeSeniors,
    detectDuplicates = true,
  } = input;
  const merged = mergeScoringSettings(settings);
  const athleteIssues = new Map<string, LineupAthleteIssue[]>();
  const checklistItems: LineupChecklistItem[] = [];
  let vacantRelayLegCount = 0;

  // Built ONCE for the whole audit (never per athlete): a confirmed alias link is
  // the user telling us two spellings are one human. Without it the roster shows
  // the athlete twice and each half sits independently under the entry cap, so a
  // swimmer at 10 entries reads as 5 + 5 and the checklist stays clean. Empty
  // `athleteAliases` yields the identity resolver, so an un-aliased workspace
  // behaves exactly as before.
  const resolver = buildAliasResolver(workspace);
  /** Merged identity key for a raw name, in this team+gender scope. */
  const identityKeyOf = (name: string): string =>
    normalizeSwimmerName(resolver.resolveAthleteName(name, team, gender));

  const pushIssue = (name: string, issue: LineupAthleteIssue) => {
    const key = normalizeSwimmerName(name);
    const list = athleteIssues.get(key) ?? [];
    list.push(issue);
    athleteIssues.set(key, list);
  };

  const pushChecklist = (item: Omit<LineupChecklistItem, 'id'>) => {
    checklistItems.push({
      ...item,
      athleteKey:
        item.athleteKey ??
        (item.athleteName ? scorerRosterKey(team, gender, item.athleteName) : undefined),
      id: `${item.type}|${item.athleteName ?? ''}|${item.relayEntryKey ?? ''}|${item.legIndex ?? ''}|${item.message}`,
    });
  };

  const teamResults = allResults.filter(
    r => (r.gender == null || r.gender === gender) && teamFrom(r.team) === team
  );
  const teamScored = allScored.filter(
    r => r.gender === gender && teamFrom(r.team) === team
  );

  const lookup = buildScorerRosterLookup(
    teamResults,
    merged,
    workspace.scorerRosterOverrides ?? [],
    gender,
    resolver
  );

  // Keyed by RESOLVED identity, so the two spellings of a linked athlete produce
  // one audited athlete rather than two rows carrying the same merged counts.
  const athleteNames = new Set<string>();
  for (const r of teamResults) {
    if (isRelayResult(r) && r.name === r.team) continue;
    if (!isRelayResult(r) || r.name !== r.team) {
      athleteNames.add(identityKeyOf(r.name));
    }
  }
  for (const row of lookup.rows) {
    if (row.team === team) athleteNames.add(identityKeyOf(row.name));
  }

  for (const nameKey of athleteNames) {
    const displayName =
      lookup.rows.find(r => r.team === team && identityKeyOf(r.name) === nameKey)?.name ??
      teamResults.find(r => identityKeyOf(r.name) === nameKey)?.name ??
      nameKey;

    const counts = countSwimmerEntries(allResults, team, gender, displayName, resolver);
    const over = swimmerExceedsEntryLimits(counts, merged);
    if (over.individualOver) {
      const issue: LineupAthleteIssue = {
        type: 'over_entry_limit',
        message: 'Over individual entry limit',
      };
      pushIssue(displayName, issue);
      pushChecklist({
        type: 'over_entry_limit',
        group: 'entries',
        message: `${displayName}: over individual entry limit`,
        athleteName: displayName,
      });
    }
    if (over.relayOver) {
      const issue: LineupAthleteIssue = {
        type: 'over_entry_limit',
        message: 'Over relay entry limit',
      };
      pushIssue(displayName, issue);
      pushChecklist({
        type: 'over_entry_limit',
        group: 'entries',
        message: `${displayName}: over relay entry limit`,
        athleteName: displayName,
      });
    }
    if (over.totalOver) {
      const issue: LineupAthleteIssue = {
        type: 'over_entry_limit',
        message: 'Over total entry limit (individual + relay)',
      };
      pushIssue(displayName, issue);
      pushChecklist({
        type: 'over_entry_limit',
        group: 'entries',
        message: `${displayName}: over total entry limit (individual + relay)`,
        athleteName: displayName,
      });
    }

    const row = lookup.rows.find(
      r => r.team === team && identityKeyOf(r.name) === nameKey
    );
    if (row?.isScorer && counts.individual === 0) {
      const issue: LineupAthleteIssue = {
        type: 'empty_lineup',
        message: 'Marked scorer but no individual entries planned',
      };
      pushIssue(displayName, issue);
      pushChecklist({
        type: 'empty_lineup',
        group: 'lineups',
        message: `${displayName}: scorer with no individual entries`,
        athleteName: displayName,
      });
    }
  }

  // Athletes split across two name spellings. A split divides one human's
  // history into two identities: each sits under the entry cap independently,
  // each gets ranked and entered, and each counts against the distinct-scorer
  // cap. Names are gathered by `buildAliasEvidenceIndex` (meet results + the
  // frozen source copy + athleteHistory + recruits + meetEntryPlans), scoped to
  // this team and gender; already-linked and user-rejected pairs are excluded.
  if (detectDuplicates) {
    for (const pair of detectDuplicateAthletes(workspace, { team, gender })) {
      pushIssue(pair.canonicalName, {
        type: 'duplicate_athlete',
        message: `Also appears as "${pair.aliasName}" — likely the same athlete`,
        duplicate: pair,
      });
      pushIssue(pair.aliasName, {
        type: 'duplicate_athlete',
        message: `Also appears as "${pair.canonicalName}" — likely the same athlete`,
        duplicate: pair,
      });
      pushChecklist({
        type: 'duplicate_athlete',
        group: 'roster',
        message: `${pair.canonicalName}: also entered as "${pair.aliasName}" — likely the same athlete`,
        athleteName: pair.canonicalName,
        duplicate: pair,
      });
    }
  }

  // Vacate set must come from PDF/source legs + overrides (projected legs already show '—').
  const pdfResults =
    gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const vacateNames = computeVacateRelayLegNames(
    pdfResults,
    gender,
    merged,
    workspace.scorerRosterOverrides ?? []
  );

  const checklistVacantKeys = new Set<string>();
  for (const leg of teamScored) {
    if (!isRelayResult(leg) || leg.name === leg.team) continue;
    const entryKey = stableRelayEntryKey(pdfResults, leg);
    const isVacant = Boolean(leg.relayLegVacant || leg.relayMissingLeg);
    if (!isVacant) continue;

    vacantRelayLegCount += 1;
    const stroke = leg.relayMissingLeg?.stroke;
    const legIdx = leg.relayLegIndex ?? leg.relayMissingLeg?.legIndex ?? 0;
    const vacantKey = `${entryKey}|${legIdx}`;
    if (!checklistVacantKeys.has(vacantKey)) {
      checklistVacantKeys.add(vacantKey);
      const strokeLabel = relayMissingStrokeLabel(stroke);
      const msg = strokeLabel
        ? `Relay ${leg.event}: leg ${legIdx + 1} (${strokeLabel}) needs filling`
        : `Relay ${leg.event}: leg ${legIdx + 1} needs filling`;
      pushChecklist({
        type: 'relay_needs_fill',
        group: 'relays',
        message: msg,
        relayEvent: leg.event,
        legIndex: legIdx,
        relayEntryKey: entryKey,
      });
    }

    const departed = findDepartedNameForVacantLeg(pdfResults, leg);
    if (!departed) continue;
    const departedKey = normalizeSwimmerName(departed);
    if (vacateNames.has(departedKey)) {
      pushIssue(departed, {
        type: 'relay_scorer_off',
        message: 'Removed from relay — non-scorers cannot swim relays; fill this leg',
        relayEvent: leg.event,
        legIndex: legIdx,
        relayEntryKey: entryKey,
      });
    } else {
      pushIssue(departed, {
        type: 'relay_leg_vacant',
        message: removeSeniors
          ? 'Senior removed — relay leg needs filling'
          : 'Relay leg vacant — needs filling',
        relayEvent: leg.event,
        legIndex: legIdx,
        relayEntryKey: entryKey,
      });
    }
  }

  // Athletes marked non-scorer who still appear on PDF relay legs (projection vacated them).
  for (const nameKey of vacateNames) {
    if (athleteIssues.get(nameKey)?.some(i => i.type === 'relay_scorer_off')) continue;
    const displayName =
      lookup.rows.find(r => r.team === team && normalizeSwimmerName(r.name) === nameKey)?.name ??
      pdfResults.find(r => normalizeSwimmerName(r.name) === nameKey)?.name ??
      nameKey;
    // Only flag if they were on a team relay for this team
    const onTeamRelay = pdfResults.some(r => {
      if (!isRelayResult(r) || teamFrom(r.team) !== team) return false;
      if (r.name !== r.team && normalizeSwimmerName(r.name) === nameKey) return true;
      if (r.relayNames?.some(n => normalizeSwimmerName(n.name) === nameKey)) return true;
      return false;
    });
    if (!onTeamRelay) continue;
    pushIssue(displayName, {
      type: 'relay_scorer_off',
      message: 'Not a scorer — removed from relay projection until leg is filled',
    });
    pushChecklist({
      type: 'relay_scorer_off',
      group: 'relays',
      message: `${displayName}: not a scorer — relay leg needs replacement`,
      athleteName: displayName,
    });
  }

  return { athleteIssues, checklistItems, vacantRelayLegCount };
}

function findDepartedNameForVacantLeg(
  originalResults: SwimmerResult[],
  vacantLeg: SwimmerResult
): string | null {
  const template = relayTemplateFromLeg(originalResults, vacantLeg);
  const idx = vacantLeg.relayLegIndex ?? vacantLeg.relayMissingLeg?.legIndex;
  if (idx == null) return null;
  if (template.relayNames && template.relayNames[idx]) {
    return template.relayNames[idx].name ?? null;
  }
  const legRow = originalResults.find(
    r =>
      r.isRelay &&
      r.team === template.team &&
      r.event === template.event &&
      r.rank === template.rank &&
      (r.relayLegIndex ?? -1) === idx
  );
  return legRow?.name ?? null;
}

/** Remove relay leg overrides where assignee matches a swimmer (e.g. scorer toggled off). */
export function pruneRelayOverridesForSwimmer(
  overrides: RelayLegOverride[],
  swimmerName: string
): RelayLegOverride[] {
  const key = normalizeSwimmerName(swimmerName);
  return overrides.filter(o => {
    if (!o.assigneeName) return true;
    return normalizeSwimmerName(o.assigneeName) !== key;
  });
}

export type QuickFillSuggestion = {
  overrides: RelayLegOverride[];
  message: string;
};

/** Suggest one relay leg override to fill a vacant leg on a team. */
export function suggestQuickFillForVacantLeg(
  workspace: Workspace,
  gender: Gender,
  team: string,
  relayEntryKeyStr: string,
  legIndex: number,
  activeSwimmers: SwimmerResult[]
): QuickFillSuggestion | null {
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  let template: SwimmerResult | null = null;
  for (const r of results) {
    if (!isRelayResult(r)) continue;
    if (relayEntryKey(relayTemplateFromLeg(results, r)) !== relayEntryKeyStr) continue;
    if (teamFrom(r.team) !== team) continue;
    template = relayTemplateFromLeg(results, r);
    break;
  }
  if (!template) return null;

  const assignedInEvent = new Set<string>();
  for (const s of activeSwimmers) {
    if (s.team !== team || s.isRelay) continue;
    assignedInEvent.add(normalizeSwimmerName(s.name));
  }

  const hit = suggestBestRelayLegFill(
    activeSwimmers.filter(s => s.team === team && !s.isRelay),
    template,
    legIndex,
    assignedInEvent,
    new Set()
  );
  if (!hit) return null;

  const overrides = upsertRelayLegOverride(workspace.relayLegOverrides ?? [], hit.override);
  return {
    overrides,
    message: `Assign ${hit.swimmer.name} to leg ${legIndex + 1}`,
  };
}

export function athleteHasIssueType(
  audit: TeamLineupAudit,
  athleteName: string,
  type: LineupIssueType
): boolean {
  const list = audit.athleteIssues.get(normalizeSwimmerName(athleteName));
  return list?.some(i => i.type === type) ?? false;
}

export function issueBadgeLabel(issue: LineupAthleteIssue): string {
  switch (issue.type) {
    case 'over_entry_limit':
      return 'Over limit';
    case 'empty_lineup':
      return 'Empty lineup';
    case 'relay_leg_vacant':
      return 'Relay gap';
    case 'relay_scorer_off':
      return 'Relay removed';
    case 'relay_needs_fill':
      return 'Fill relay';
    case 'duplicate_athlete':
      return 'Duplicate?';
    default:
      return 'Issue';
  }
}
