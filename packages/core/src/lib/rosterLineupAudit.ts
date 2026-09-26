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
import type { ScorerRosterRow } from './scorerRoster';
import {
  countSwimmerEntries,
  swimmerExceedsEntryLimits,
} from './swimmerEntryLimits';
import type { SwimmerEntryCounts } from './swimmerEntryLimits';
import { mergeScoringSettings } from './scoringDefaults';
import {
  relayMissingStrokeLabel,
  relayTemplateFromLeg,
  stableRelayEntryKey,
  suggestBestRelayLegFill,
  upsertRelayLegOverride,
} from './relayLegMatching';
import { parseRelayDistanceYardsOrNull, relayEntryKey } from './relaySplits';
import { relayLegHistoryCandidates } from './relayLegHistoryCandidates';
import { buildAliasResolver, detectDuplicateAthletes } from './athleteAliases';
import { IDENTITY_ALIAS_RESOLVER } from './athleteAliases';
import type { AthleteAliasResolver, DuplicateAthletePair } from './athleteAliases';
import { isRelayResult, normalizeSwimmerName } from './utils';
import { programSponsorsGender, resolveTeamDivision } from '../data/teamDivisions';
import { buildCutlineTagForTeam, cutlineSwimOfRecord } from './cutlineTags';
import { swimEventNotSwumInCourse } from './courseEvents';

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
  | 'duplicate_athlete'
  /** This athlete's team has no known division — cut tags and lineup rules judged against a division may be wrong. */
  | 'program_division_unknown'
  /** This athlete's team is not on record as sponsoring their gender's program. */
  | 'program_gender_unsponsored'
  /** This swim's cut standing rests on a converted-time estimate, not an earned cut. */
  | 'conversion_estimate'
  /**
   * A recruit row or plan names an event its recorded course does not swim
   * (a 1000 Freestyle recorded SCM). It is not scored; see `courseEvents.ts`.
   */
  | 'event_not_swum_in_course'
  /**
   * A relay's event label names no distance (`parseRelayDistanceYardsOrNull`
   * is null). No swim matches its legs, so a departing leg holder cannot be
   * replaced and no split can be checked. Nothing guesses a distance.
   */
  | 'relay_distance_unreadable';

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
  group: 'entries' | 'lineups' | 'relays' | 'roster' | 'program' | 'provenance';
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

/** One named leg of a relay entry, as `SwimmerResult.relayNames` records it. */
type RelayLegName = { name: string; year: string };

/** Whether a result row is a leg of the same relay entry as `template`. */
function isLegOfRelayEntry(row: SwimmerResult, template: SwimmerResult): boolean {
  return (
    Boolean(row.isRelay) &&
    row.team === template.team &&
    row.event === template.event &&
    row.rank === template.rank &&
    (row.roundSwam || '').trim() === (template.roundSwam || '').trim()
  );
}

/** One template per relay ENTRY, keyed so a re-ranked entry still collapses to one. */
function relayTemplatesByEntry(genderResults: SwimmerResult[]): Map<string, SwimmerResult> {
  const templates = new Map<string, SwimmerResult>();
  for (const r of genderResults) {
    if (!isRelayResult(r) || r.name === r.team) continue;
    const template = relayTemplateFromLeg(genderResults, r);
    const key = relayEntryKey(template);
    if (!templates.has(key)) templates.set(key, template);
  }
  return templates;
}

/** The entry's own leg list when it carries one, else the leg rows in leg order. */
function relayLegNamesOf(
  genderResults: SwimmerResult[],
  template: SwimmerResult
): RelayLegName[] {
  if (template.relayNames && template.relayNames.length > 0) return template.relayNames;
  return genderResults
    .filter(x => isLegOfRelayEntry(x, template))
    .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0))
    .map(x => ({ name: x.name, year: String(x.classYear) }));
}

/**
 * The athlete on a leg, or null for a placeholder.
 *
 * '—' and 'Unknown' are what the projection writes into an already-vacated leg;
 * neither is a person, and treating one as a non-scorer would vacate a leg twice.
 */
function athleteOnRelayLeg(leg: RelayLegName): string | null {
  const nm = leg.name?.trim();
  if (!nm || nm === '—' || nm === 'Unknown') return null;
  return nm;
}

/** Swimmers on relay legs who are not scorers — legs vacated in projection (non-scorers cannot swim relays). */
export function computeVacateRelayLegNames(
  results: SwimmerResult[],
  gender: Gender,
  settings: ScoringSettings,
  overrides: ScorerRosterOverride[] = [],
  /**
   * Pass the workspace's resolver. Without one this falls back to identity, and
   * a swimmer marked a non-scorer under their canonical spelling is not
   * recognised on a relay leg printed under an alias — so the leg is not
   * vacated and the projection keeps a relay a non-scorer cannot legally swim.
   *
   * `whatIfProjection` calls this on raw workspace rows, before anything
   * collapses alias spellings, which is exactly where that bites. See
   * `docs/INVARIANTS.md` item 6: the resolver is opt-in, and a call site that
   * omits it treats two spellings of one athlete as two people.
   */
  resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER
): Set<string> {
  const merged = mergeScoringSettings(settings);
  if (!usesScorerRoster(merged)) return new Set();

  const genderResults = results.filter(r => r.gender == null || r.gender === gender);
  const lookup = buildScorerRosterLookup(genderResults, merged, overrides, gender, resolver);
  const vacate = new Set<string>();

  for (const template of relayTemplatesByEntry(genderResults).values()) {
    for (const leg of relayLegNamesOf(genderResults, template)) {
      const nm = athleteOnRelayLeg(leg);
      if (!nm) continue;
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

/**
 * The two output accumulators, plus the keying rules that feed them.
 *
 * `pushIssue` keys by the raw normalized name, NOT the resolved identity —
 * callers look an athlete up by whatever spelling they are rendering. Only
 * `pushChecklist` derives a `ScorerRosterRow.key`, so a Jump can match by key
 * rather than by name.
 */
type LineupAuditCollector = {
  athleteIssues: Map<string, LineupAthleteIssue[]>;
  checklistItems: LineupChecklistItem[];
  pushIssue: (name: string, issue: LineupAthleteIssue) => void;
  pushChecklist: (item: Omit<LineupChecklistItem, 'id'>) => void;
};

function createLineupAuditCollector(team: string, gender: Gender): LineupAuditCollector {
  const athleteIssues = new Map<string, LineupAthleteIssue[]>();
  const checklistItems: LineupChecklistItem[] = [];
  return {
    athleteIssues,
    checklistItems,
    pushIssue: (name, issue) => {
      const key = normalizeSwimmerName(name);
      const list = athleteIssues.get(key) ?? [];
      list.push(issue);
      athleteIssues.set(key, list);
    },
    pushChecklist: item => {
      checklistItems.push({
        ...item,
        athleteKey:
          item.athleteKey ??
          (item.athleteName ? scorerRosterKey(team, gender, item.athleteName) : undefined),
        id: `${item.type}|${item.athleteName ?? ''}|${item.relayEntryKey ?? ''}|${item.legIndex ?? ''}|${item.message}`,
      });
    },
  };
}

/**
 * The three entry-cap checks, in the order a coach reads them.
 *
 * These are a genuine flat dispatch: each flag is computed independently by
 * `swimmerExceedsEntryLimits`, none gates another, and every one produces the
 * same shape of issue + checklist item. The wording is load-bearing — it is
 * what the coach sees — so it lives here rather than being derived.
 *
 * Under the NSISC preset the per-type caps are 999 and only `totalOver` can
 * fire; the other two are reachable on any non-NSISC settings shape.
 */
const ENTRY_LIMIT_CHECKS: ReadonlyArray<{
  flag: 'individualOver' | 'relayOver' | 'totalOver';
  /** Badge-side wording, shown against the athlete. */
  issueMessage: string;
  /** Checklist-side wording, appended after "<name>: ". */
  checklistDetail: string;
}> = [
  {
    flag: 'individualOver',
    issueMessage: 'Over individual entry limit',
    checklistDetail: 'over individual entry limit',
  },
  {
    flag: 'relayOver',
    issueMessage: 'Over relay entry limit',
    checklistDetail: 'over relay entry limit',
  },
  {
    flag: 'totalOver',
    issueMessage: 'Over total entry limit (individual + relay)',
    checklistDetail: 'over total entry limit (individual + relay)',
  },
];

/** Flag every entry cap this athlete is over, in table order. */
function auditEntryLimits(
  collector: LineupAuditCollector,
  displayName: string,
  counts: SwimmerEntryCounts,
  settings: ScoringSettings
): void {
  const over = swimmerExceedsEntryLimits(counts, settings);
  for (const check of ENTRY_LIMIT_CHECKS) {
    if (!over[check.flag]) continue;
    collector.pushIssue(displayName, {
      type: 'over_entry_limit',
      message: check.issueMessage,
    });
    collector.pushChecklist({
      type: 'over_entry_limit',
      group: 'entries',
      message: `${displayName}: ${check.checklistDetail}`,
      athleteName: displayName,
    });
  }
}

/** Flag a swimmer the roster counts as a scorer who has no individual swim planned. */
function auditEmptyLineup(
  collector: LineupAuditCollector,
  row: ScorerRosterRow | undefined,
  displayName: string,
  counts: SwimmerEntryCounts
): void {
  if (!row?.isScorer || counts.individual !== 0) return;
  collector.pushIssue(displayName, {
    type: 'empty_lineup',
    message: 'Marked scorer but no individual entries planned',
  });
  collector.pushChecklist({
    type: 'empty_lineup',
    group: 'lineups',
    message: `${displayName}: scorer with no individual entries`,
    athleteName: displayName,
  });
}

/**
 * Every athlete this audit covers, keyed by RESOLVED identity so the two
 * spellings of a linked athlete produce one audited athlete rather than two
 * rows carrying the same merged counts.
 */
function collectAuditedAthleteKeys(
  teamResults: SwimmerResult[],
  rosterRows: ScorerRosterRow[],
  team: string,
  identityKeyOf: (name: string) => string
): Set<string> {
  const keys = new Set<string>();
  for (const r of teamResults) {
    // A relay row whose name IS the team is the entry itself, not a swimmer.
    if (isRelayResult(r) && r.name === r.team) continue;
    keys.add(identityKeyOf(r.name));
  }
  for (const row of rosterRows) {
    if (row.team === team) keys.add(identityKeyOf(row.name));
  }
  return keys;
}

/** Spelling to render for an identity key: roster row first, then the pool. */
function resolveAuditDisplayName(
  nameKey: string,
  team: string,
  rosterRows: ScorerRosterRow[],
  teamResults: SwimmerResult[],
  identityKeyOf: (name: string) => string
): string {
  return (
    rosterRows.find(r => r.team === team && identityKeyOf(r.name) === nameKey)?.name ??
    teamResults.find(r => identityKeyOf(r.name) === nameKey)?.name ??
    nameKey
  );
}

/** Report athletes split across two name spellings on this team. */
function auditDuplicateAthletes(
  collector: LineupAuditCollector,
  workspace: Workspace,
  team: string,
  gender: Gender
): void {
  for (const pair of detectDuplicateAthletes(workspace, { team, gender })) {
    collector.pushIssue(pair.canonicalName, {
      type: 'duplicate_athlete',
      message: `Also appears as "${pair.aliasName}" — likely the same athlete`,
      duplicate: pair,
    });
    collector.pushIssue(pair.aliasName, {
      type: 'duplicate_athlete',
      message: `Also appears as "${pair.canonicalName}" — likely the same athlete`,
      duplicate: pair,
    });
    collector.pushChecklist({
      type: 'duplicate_athlete',
      group: 'roster',
      message: `${pair.canonicalName}: also entered as "${pair.aliasName}" — likely the same athlete`,
      athleteName: pair.canonicalName,
      duplicate: pair,
    });
  }
}

/**
 * Flag every athlete on this team whose program's division is unmapped, or
 * whose team is not on record as sponsoring their gender's program.
 *
 * Both are the "unknown", never a guessed default, cases `resolveTeamDivision`/
 * `programSponsorsGender` exist to make legible (CLAUDE.md's Data provenance
 * rules 5 and 7). Today those signals surface only on a cut badge, per swim,
 * wherever one happens to render — a team leaning on entries this uncertain
 * has no single line a coach reviews before submitting. One checklist item
 * per affected athlete, not one per team, so "N athletes affected" is a real
 * count rather than a single team-level line hiding how many entries it touches.
 */
function auditProgramProvenance(
  collector: LineupAuditCollector,
  opts: { rosterRows: ScorerRosterRow[]; team: string; gender: Gender }
): void {
  const { rosterRows, team, gender } = opts;
  const teamRows = rosterRows.filter(r => r.team === team);
  if (teamRows.length === 0) return;

  const resolution = resolveTeamDivision(team);

  if (resolution.division == null) {
    for (const row of teamRows) {
      collector.pushChecklist({
        type: 'program_division_unknown',
        group: 'program',
        message: `${row.name}: ${team}'s division is not mapped — cut standards and lineup rules for this athlete may be judged against the wrong table`,
        athleteName: row.name,
      });
    }
    return; // Division unknown already covers "nothing is verified for this program".
  }

  const sponsoredGender = gender === Gender.WOMEN ? 'Women' : 'Men';
  if (!programSponsorsGender(resolution, sponsoredGender)) {
    for (const row of teamRows) {
      collector.pushChecklist({
        type: 'program_gender_unsponsored',
        group: 'program',
        message: `${row.name}: ${team} is not recorded as sponsoring ${sponsoredGender.toLowerCase()}'s swimming & diving`,
        athleteName: row.name,
      });
    }
  }
}

/**
 * Flag every individual swim on this team currently resting on a
 * converted-time cutline estimate (`state: 'converted_estimate'` — a metric
 * swim whose converted yards equivalent clears a published standard,
 * informative but never an earned cut; see `cutlineTags.ts`'s own doc
 * comment for the full rule). Today that signal only ever renders per-swim,
 * on whichever detail row happens to show a cut badge — this is the first
 * place it reaches a team-wide, pre-submit view: a team leaning heavily on
 * indicative-only swims for its entry decisions has no single line
 * summarizing how many.
 *
 * Scoped to individual swims, matching the plan this implements — a relay
 * carries two independent verdicts (`buildRelaySwimTagsForTeam`), a real
 * design decision left for its own pass rather than folded in here.
 *
 * Reuses `buildCutlineTagForTeam` exactly as every existing per-athlete
 * detail row already does (`AthleteCreditedSwimsRow.tsx` et al.) — same
 * division resolution, same course-of-record defaulting, no new cutline
 * logic. `SwimmerResult` carries no `timeType`, so course is read off the
 * event label same as everywhere else that already accepts this default —
 * except for a row holding a converted SCY estimate (`convertedFrom`, set on
 * recruit rows and plans built from a metric swim). Before 2026-09-22 such a
 * row read as a yards swim here, so exactly the rows this check exists for
 * never reached it. `cutlineSwimOfRecord` judges them as the metric swim.
 */
function auditConversionProvenance(
  collector: LineupAuditCollector,
  opts: { teamScored: SwimmerResult[]; team: string; gender: Gender }
): void {
  const { teamScored, team, gender } = opts;
  for (const r of teamScored) {
    if (isRelayResult(r) || !r.time) continue;
    const result = buildCutlineTagForTeam({ team, gender, ...cutlineSwimOfRecord(r) });
    if (result.state !== 'converted_estimate') continue;
    const { indicative } = result;
    collector.pushChecklist({
      type: 'conversion_estimate',
      group: 'provenance',
      message: `${r.name}: ${indicative.event} rests on a converted-time estimate (${indicative.recordedTime} ${indicative.swimCourse} → ${indicative.convertedTime} converted), not an earned ${indicative.tierLabel}`,
      athleteName: r.name,
    });
  }
}

/**
 * Recruit rows and plans that name an event their recorded course does not
 * swim (a hand-entered 1000 Freestyle recorded SCM). The what-if projection
 * leaves them out, because such a row has no SCY time. Without this item the
 * row would drop out of the lineup with no word; here it is named, with the
 * event that course swims in its place.
 *
 * Reads the stored rows, not `teamScored`: the projection never holds them.
 */
function auditStoredRowCourseMismatches(
  collector: LineupAuditCollector,
  opts: { workspace: Workspace; team: string; gender: Gender }
): void {
  const { workspace, team, gender } = opts;
  const rows = [
    ...(workspace.recruits ?? []).map(r => ({ row: r, kind: 'recruit row' })),
    ...(workspace.meetEntryPlans ?? []).map(p => ({ row: p, kind: 'planned entry' })),
  ];
  for (const { row, kind } of rows) {
    if (row.gender !== gender || teamFrom(row.team) !== team) continue;
    const mismatch = swimEventNotSwumInCourse(row);
    if (!mismatch) continue;
    collector.pushChecklist({
      type: 'event_not_swum_in_course',
      group: 'provenance',
      message: `${row.name}: the ${kind} ${mismatch.event} ${mismatch.course} is not scored. There is no ${mismatch.event} in ${mismatch.course}; that course swims the ${mismatch.courseEvent}. Check the event and course.`,
      athleteName: row.name,
    });
  }
}

/**
 * Relays of this team whose event label names no distance. Such a relay has
 * no leg any swim matches: a departing leg holder leaves the leg empty, and
 * autofill offers nobody. The label is named once per event so the coach can
 * correct it; no distance is guessed (the old parser silently took 200).
 */
function auditUnreadableRelayDistances(
  collector: LineupAuditCollector,
  opts: { pdfResults: SwimmerResult[]; team: string }
): void {
  const named = new Set<string>();
  for (const row of opts.pdfResults) {
    if (!isRelayResult(row) || teamFrom(row.team) !== opts.team) continue;
    if (named.has(row.event) || parseRelayDistanceYardsOrNull(row.event) != null) continue;
    named.add(row.event);
    collector.pushChecklist({
      type: 'relay_distance_unreadable',
      group: 'relays',
      message: `Relay ${row.event}: the event label names no distance, so its legs cannot be matched, filled or split-checked. Check the relay's event label.`,
      relayEvent: row.event,
    });
  }
}

/** Run the per-athlete checks over every athlete this team's audit covers. */
function auditRosteredAthletes(
  collector: LineupAuditCollector,
  opts: {
    teamResults: SwimmerResult[];
    rosterRows: ScorerRosterRow[];
    /** Counted against the WHOLE pool, not just this team's rows. */
    allResults: SwimmerResult[];
    team: string;
    gender: Gender;
    settings: ScoringSettings;
    resolver: AthleteAliasResolver;
    identityKeyOf: (name: string) => string;
  }
): void {
  const { teamResults, rosterRows, allResults, team, gender, settings, resolver, identityKeyOf } =
    opts;
  for (const nameKey of collectAuditedAthleteKeys(teamResults, rosterRows, team, identityKeyOf)) {
    const displayName = resolveAuditDisplayName(
      nameKey,
      team,
      rosterRows,
      teamResults,
      identityKeyOf
    );
    const counts = countSwimmerEntries(allResults, team, gender, displayName, resolver);
    auditEntryLimits(collector, displayName, counts, settings);
    const row = rosterRows.find(r => r.team === team && identityKeyOf(r.name) === nameKey);
    auditEmptyLineup(collector, row, displayName, counts);
  }
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
  const collector = createLineupAuditCollector(team, gender);
  const { athleteIssues, checklistItems } = collector;

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

  auditRosteredAthletes(collector, {
    teamResults,
    rosterRows: lookup.rows,
    allResults,
    team,
    gender,
    settings: merged,
    resolver,
    identityKeyOf,
  });

  auditProgramProvenance(collector, { rosterRows: lookup.rows, team, gender });
  auditConversionProvenance(collector, { teamScored, team, gender });
  auditStoredRowCourseMismatches(collector, { workspace, team, gender });

  // Athletes split across two name spellings. A split divides one human's
  // history into two identities: each sits under the entry cap independently,
  // each gets ranked and entered, and each counts against the distinct-scorer
  // cap. Names are gathered by `buildAliasEvidenceIndex` (meet results + the
  // frozen source copy + athleteHistory + recruits + meetEntryPlans), scoped to
  // this team and gender; already-linked and user-rejected pairs are excluded.
  if (detectDuplicates) auditDuplicateAthletes(collector, workspace, team, gender);

  // Vacate set must come from PDF/source legs + overrides (projected legs already show '—').
  const pdfResults =
    gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const vacateNames = computeVacateRelayLegNames(
    pdfResults,
    gender,
    merged,
    workspace.scorerRosterOverrides ?? []
  );

  const vacantRelayLegCount = auditVacantRelayLegs(collector, {
    teamScored,
    pdfResults,
    vacateNames,
    removeSeniors,
  });

  auditUnreadableRelayDistances(collector, { pdfResults, team });

  // Runs AFTER the leg sweep on purpose: it skips anyone that sweep already
  // flagged, so the two are an ordered pair, not two independent checks.
  auditNonScorersOnPdfRelays(collector, {
    vacateNames,
    rosterRows: lookup.rows,
    pdfResults,
    team,
  });

  return { athleteIssues, checklistItems, vacantRelayLegCount };
}

/** A scored relay leg is vacant when nobody is swimming it. */
function isVacantRelayLeg(leg: SwimmerResult): boolean {
  if (!isRelayResult(leg) || leg.name === leg.team) return false;
  return Boolean(leg.relayLegVacant || leg.relayMissingLeg);
}

/** Checklist wording for one vacant leg — stroke named when the source records it. */
function vacantLegFillMessage(leg: SwimmerResult, legIndex: number): string {
  const strokeLabel = relayMissingStrokeLabel(leg.relayMissingLeg?.stroke);
  return strokeLabel
    ? `Relay ${leg.event}: leg ${legIndex + 1} (${strokeLabel}) needs filling`
    : `Relay ${leg.event}: leg ${legIndex + 1} needs filling`;
}

/** Why the leg is empty, in the words the coach reads. */
function departedLegMessage(removedForScorerRule: boolean, removeSeniors: boolean): string {
  if (removedForScorerRule) {
    return 'Removed from relay — non-scorers cannot swim relays; fill this leg';
  }
  return removeSeniors
    ? 'Senior removed — relay leg needs filling'
    : 'Relay leg vacant — needs filling';
}

/**
 * Flag every vacant leg on the team, and name whoever left it. Returns the raw
 * leg count — which is per ROW, while the checklist item is deduped per
 * (entry, leg index), so the two numbers can legitimately differ.
 */
function auditVacantRelayLegs(
  collector: LineupAuditCollector,
  opts: {
    teamScored: SwimmerResult[];
    pdfResults: SwimmerResult[];
    vacateNames: Set<string>;
    removeSeniors: boolean;
  }
): number {
  const { teamScored, pdfResults, vacateNames, removeSeniors } = opts;
  const checklistVacantKeys = new Set<string>();
  let vacantRelayLegCount = 0;

  for (const leg of teamScored) {
    if (!isVacantRelayLeg(leg)) continue;
    vacantRelayLegCount += 1;

    const entryKey = stableRelayEntryKey(pdfResults, leg);
    const legIdx = leg.relayLegIndex ?? leg.relayMissingLeg?.legIndex ?? 0;
    const vacantKey = `${entryKey}|${legIdx}`;
    if (!checklistVacantKeys.has(vacantKey)) {
      checklistVacantKeys.add(vacantKey);
      collector.pushChecklist({
        type: 'relay_needs_fill',
        group: 'relays',
        message: vacantLegFillMessage(leg, legIdx),
        relayEvent: leg.event,
        legIndex: legIdx,
        relayEntryKey: entryKey,
      });
    }

    const departed = findDepartedNameForVacantLeg(pdfResults, leg);
    if (!departed) continue;
    const removedForScorerRule = vacateNames.has(normalizeSwimmerName(departed));
    collector.pushIssue(departed, {
      type: removedForScorerRule ? 'relay_scorer_off' : 'relay_leg_vacant',
      message: departedLegMessage(removedForScorerRule, removeSeniors),
      relayEvent: leg.event,
      legIndex: legIdx,
      relayEntryKey: entryKey,
    });
  }

  return vacantRelayLegCount;
}

/**
 * Spelling to render for a vacated name key.
 *
 * Keyed on the RAW normalized name, not the resolved identity: the vacate set is
 * built by `computeVacateRelayLegNames` without a resolver, so its keys are raw.
 */
function resolveVacatedDisplayName(
  nameKey: string,
  team: string,
  rosterRows: ScorerRosterRow[],
  pdfResults: SwimmerResult[]
): string {
  return (
    rosterRows.find(r => r.team === team && normalizeSwimmerName(r.name) === nameKey)?.name ??
    pdfResults.find(r => normalizeSwimmerName(r.name) === nameKey)?.name ??
    nameKey
  );
}

/** Whether this identity key swam a relay leg for the team in the source results. */
function appearsOnTeamRelayLeg(
  pdfResults: SwimmerResult[],
  team: string,
  nameKey: string
): boolean {
  return pdfResults.some(r => {
    if (!isRelayResult(r) || teamFrom(r.team) !== team) return false;
    if (r.name !== r.team && normalizeSwimmerName(r.name) === nameKey) return true;
    return Boolean(r.relayNames?.some(n => normalizeSwimmerName(n.name) === nameKey));
  });
}

/**
 * Athletes marked non-scorer who still appear on PDF relay legs — the
 * projection vacated them, so their leg needs a replacement. Skips anyone the
 * per-leg sweep already flagged.
 */
function auditNonScorersOnPdfRelays(
  collector: LineupAuditCollector,
  opts: {
    vacateNames: Set<string>;
    rosterRows: ScorerRosterRow[];
    pdfResults: SwimmerResult[];
    team: string;
  }
): void {
  const { vacateNames, rosterRows, pdfResults, team } = opts;
  for (const nameKey of vacateNames) {
    if (collector.athleteIssues.get(nameKey)?.some(i => i.type === 'relay_scorer_off')) continue;
    if (!appearsOnTeamRelayLeg(pdfResults, team, nameKey)) continue;
    const displayName = resolveVacatedDisplayName(nameKey, team, rosterRows, pdfResults);
    collector.pushIssue(displayName, {
      type: 'relay_scorer_off',
      message: 'Not a scorer — removed from relay projection until leg is filled',
    });
    collector.pushChecklist({
      type: 'relay_scorer_off',
      group: 'relays',
      message: `${displayName}: not a scorer — relay leg needs replacement`,
      athleteName: displayName,
    });
  }
}

/** Who was on this leg before it was vacated, from the source results. */
function findDepartedNameForVacantLeg(
  originalResults: SwimmerResult[],
  vacantLeg: SwimmerResult
): string | null {
  const idx = vacantLeg.relayLegIndex ?? vacantLeg.relayMissingLeg?.legIndex;
  if (idx == null) return null;

  const template = relayTemplateFromLeg(originalResults, vacantLeg);
  const namedLeg = template.relayNames?.[idx];
  if (namedLeg) return namedLeg.name ?? null;

  const legRow = originalResults.find(
    r => isRelayEntryLegAtIndex(r, template, idx)
  );
  return legRow?.name ?? null;
}

/**
 * Whether a row is the leg at `legIndex` of `template`'s relay entry.
 *
 * Matched on team/event/rank rather than `isLegOfRelayEntry`'s round-aware
 * comparison — this is the fallback path for an entry with no `relayNames`,
 * and it deliberately keeps the original's looser match.
 */
function isRelayEntryLegAtIndex(
  row: SwimmerResult,
  template: SwimmerResult,
  legIndex: number
): boolean {
  return (
    Boolean(row.isRelay) &&
    row.team === template.team &&
    row.event === template.event &&
    row.rank === template.rank &&
    (row.relayLegIndex ?? -1) === legIndex
  );
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

/** The team's relay entry carrying this key, or null when the key is stale. */
function findTeamRelayTemplateByEntryKey(
  results: SwimmerResult[],
  team: string,
  entryKey: string
): SwimmerResult | null {
  for (const r of results) {
    if (!isRelayResult(r)) continue;
    if (teamFrom(r.team) !== team) continue;
    const template = relayTemplateFromLeg(results, r);
    if (relayEntryKey(template) !== entryKey) continue;
    return template;
  }
  return null;
}

/** Individual swimmers already entered for the team, by normalized name. */
function individualEntrantNames(activeSwimmers: SwimmerResult[], team: string): Set<string> {
  const names = new Set<string>();
  for (const s of activeSwimmers) {
    if (s.team !== team || s.isRelay) continue;
    names.add(normalizeSwimmerName(s.name));
  }
  return names;
}

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
  const template = findTeamRelayTemplateByEntryKey(results, team, relayEntryKeyStr);
  if (!template) return null;

  // A roster swimmer with no swim at the leg's event may fill it from athlete
  // history (R1 e); a pool swim at the event always wins.
  const teamPool = activeSwimmers.filter(s => s.team === team && !s.isRelay);
  const hit = suggestBestRelayLegFill(
    [...teamPool, ...relayLegHistoryCandidates(workspace, teamPool, gender)],
    template,
    legIndex,
    individualEntrantNames(activeSwimmers, team),
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
    case 'program_division_unknown':
      return 'Division unknown';
    case 'program_gender_unsponsored':
      return 'Program unconfirmed';
    case 'conversion_estimate':
      return 'Converted cut';
    case 'relay_distance_unreadable':
      return 'Relay label';
    default:
      return 'Issue';
  }
}
