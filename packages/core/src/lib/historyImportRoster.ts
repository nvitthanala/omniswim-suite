/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 1: bridge SwimCloud/history import into roster (recruits + meet entry plans).
 * Test: npx tsx scripts/test_history_import_roster.mjs
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ClassYear,
  Gender,
  HistoricalSwim,
  PlannedSwimEntry,
  Recruit,
  ScoringSettings,
  ScorerRosterOverride,
  SwimmerResult,
  Workspace,
} from '../types';
import {
  mergeHistoryIndex,
  matchAthleteToRoster,
  categorizeBestEvents,
  isChampionshipProgramEvent,
  meetProgramEvents,
  normalizeEventLabel,
} from './athleteHistory';
import { mergeScoringSettings } from './scoringDefaults';
import { usesScorerRoster, scorerRosterKey } from './scorerRoster';
import {
  convertTimeToSeconds,
  convertSwimToSCY,
  foldDiacritics,
  hasConversionFactor,
  normalizeSwimmerName,
} from './utils';
import { createPlannedEntry } from './whatIfProjection';
import {
  buildAliasResolver,
  IDENTITY_ALIAS_RESOLVER,
  type AthleteAliasResolver,
} from './athleteAliases';

export type ImportSwimmerAction = 'new_recruit' | 'add_to_lineup' | 'history_matched' | 'already_recruit';

export type ImportSwimmerPreview = {
  name: string;
  team: string;
  gender: Gender;
  swimCount: number;
  action: ImportSwimmerAction;
  matchedRosterName: string | null;
};

export type HistoryImportRosterResult = {
  /** Full workspace patch to apply in one onUpdate. Empty preview → no-op fields match input. */
  patch: Partial<Workspace>;
  summary: {
    swimsMerged: number;
    newRecruits: number;
    lineupEntriesAdded: number;
    swimmers: ImportSwimmerPreview[];
  };
  /** True when preview was empty or team blank — patch should not be applied (or is identity). */
  noop: boolean;
};

export type HistoryImportRosterOpts = {
  team: string;
  gender: Gender;
  sourceLabel?: string;
  sourceType?: string;
  /**
   * Per-swimmer class-year overrides keyed by `normalizeSwimmerName(name)`, matched
   * diacritic-insensitively. Applied only to new recruits / planned entries for the named
   * swimmers; swimmers absent from the map keep their parsed default.
   */
  classYearOverrides?: Record<string, ClassYear>;
  /**
   * Athlete alias resolver so a confirmed link ("Stevie" == "Steven") unifies the
   * import onto the existing athlete instead of creating a duplicate. Defaults to
   * a resolver built from `workspace.athleteAliases`.
   */
  resolver?: AthleteAliasResolver;
};

/** Diacritic-insensitive class-year override lookup keyed by normalized name. */
export function buildClassYearOverrideLookup(
  overrides?: Record<string, ClassYear>
): Map<string, ClassYear> {
  const map = new Map<string, ClassYear>();
  if (!overrides) return map;
  for (const [rawName, year] of Object.entries(overrides)) {
    const norm = normalizeSwimmerName(rawName);
    if (!map.has(norm)) map.set(norm, year);
    const folded = foldDiacritics(norm);
    if (!map.has(folded)) map.set(folded, year);
  }
  return map;
}

function lookupClassYearOverride(
  map: Map<string, ClassYear>,
  ...names: string[]
): ClassYear | undefined {
  for (const name of names) {
    const norm = normalizeSwimmerName(name);
    const hit = map.get(norm) ?? map.get(foldDiacritics(norm));
    if (hit) return hit;
  }
  return undefined;
}

function isRelayEventName(event: string): boolean {
  return /\brelay\b/i.test(event);
}

/**
 * Roster class-year labels, both the two-letter code and the spelled-out word.
 * A flat dispatch: no label takes precedence over another.
 */
const CLASS_YEAR_BY_LABEL = new Map<string, ClassYear>([
  ['FR', ClassYear.FR],
  ['FRESHMAN', ClassYear.FR],
  ['SO', ClassYear.SO],
  ['SOPHOMORE', ClassYear.SO],
  ['JR', ClassYear.JR],
  ['JUNIOR', ClassYear.JR],
  ['SR', ClassYear.SR],
  ['SENIOR', ClassYear.SR],
  ['HS', ClassYear.HS],
]);

/** Parse a class-year label. An unrecognized or missing label stays HS. */
function parseClassYear(raw: string | undefined): ClassYear {
  const label = String(raw ?? '')
    .trim()
    .toUpperCase();
  return CLASS_YEAR_BY_LABEL.get(label) ?? ClassYear.HS;
}

/** The results plane for one gender. Defensive `?? []`: stored workspaces may omit it. */
function resultsForGender(workspace: Workspace, gender: Gender): SwimmerResult[] {
  return gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
}

/** A result row belongs to this team and does not contradict this gender. */
function resultMatchesTeamAndGender(
  row: { team?: string; gender?: Gender },
  team: string,
  gender: Gender
): boolean {
  if (String(row.team ?? '').trim() !== team) return false;
  return row.gender == null || row.gender === gender;
}

/**
 * A relay aggregate row: the team itself standing in for the squad, not a swimmer.
 * Such a row must never contribute a name to a roster.
 */
function isRelayTeamRow(row: { name: string; team?: string; isRelay?: boolean }): boolean {
  return Boolean(row.isRelay) && row.name === row.team;
}

export function rosterNamesForTeam(workspace: Workspace, team: string, gender: Gender): string[] {
  const names = new Set<string>();
  for (const r of resultsForGender(workspace, gender)) {
    if (!resultMatchesTeamAndGender(r, team, gender)) continue;
    if (isRelayTeamRow(r)) continue;
    names.add(r.name);
  }
  for (const r of workspace.recruits ?? []) {
    if (r.gender !== gender || r.team !== team) continue;
    names.add(r.name);
  }
  return [...names];
}

function groupPreviewBySwimmer(
  preview: HistoricalSwim[],
  resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER
): Map<string, HistoricalSwim[]> {
  const map = new Map<string, HistoricalSwim[]>();
  for (const s of preview) {
    const resolved = resolver.resolveAthleteName(s.name, s.team, s.gender);
    const key = `${normalizeSwimmerName(resolved)}|${s.team}|${s.gender}`;
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return map;
}

/**
 * SCY-equivalent lineup candidates: each swim is converted to its SCY program event and
 * time (400 Free LCM → 500 Free, etc.), non-championship events (25s, 100 IM, diving, odd
 * metric distances) are dropped, and the fastest swim per program event is kept (sorted).
 * The original swims are never mutated — conversion happens on read.
 */
/**
 * A metric swim we hold no published factor for cannot be stated in SCY. Relays are
 * carried through as-is, so they are always statable.
 */
function canStateInSCY(swim: HistoricalSwim, relay: boolean): boolean {
  if (relay) return true;
  if ((swim.timeType ?? 'SCY') === 'SCY') return true;
  return hasConversionFactor(swim.event);
}

/** The SCY program event and time for a swim. Relays keep their own event and time. */
function toSCYProgramSwim(swim: HistoricalSwim, relay: boolean): { event: string; time: string } {
  if (relay) return { event: swim.event, time: swim.time };
  return convertSwimToSCY(swim.event, swim.time, swim.gender, swim.timeType ?? 'SCY');
}

/**
 * Whether the program contests this event. The loaded meet decides its own program;
 * fall back to the standard championship program when no meet is loaded, and for
 * relays either way.
 */
function isEventContested(
  event: string,
  relay: boolean,
  allowedEvents: ReadonlySet<string> | null
): boolean {
  if (!relay && allowedEvents && allowedEvents.size > 0) {
    return allowedEvents.has(normalizeEventLabel(event));
  }
  return isChampionshipProgramEvent(event);
}

/** Keep the fastest swim per program event. Ties keep the incumbent. */
function keepIfFastest(
  best: Map<string, HistoricalSwim>,
  event: string,
  candidate: HistoricalSwim
): void {
  const prev = best.get(event);
  if (!prev || convertTimeToSeconds(candidate.time) < convertTimeToSeconds(prev.time)) {
    best.set(event, candidate);
  }
}

function toProgramCandidates(
  swims: HistoricalSwim[],
  allowedEvents: ReadonlySet<string> | null = null
): HistoricalSwim[] {
  const best = new Map<string, HistoricalSwim>();
  for (const s of swims) {
    const relay = isRelayEventName(s.event);
    if (!canStateInSCY(s, relay)) continue;
    const { event, time } = toSCYProgramSwim(s, relay);
    if (!isEventContested(event, relay, allowedEvents)) continue;
    keepIfFastest(best, event, { ...s, event, time, timeType: 'SCY' });
  }
  return [...best.values()].sort(
    (a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time)
  );
}

/**
 * The events the workspace's loaded meet contests, for this gender. Read from the
 * FROZEN source copy so previously-imported entries cannot widen the program that
 * is meant to constrain the next import. Null when no meet is loaded, which means
 * "fall back to the standard championship program".
 */
function workspaceProgramEvents(workspace: Workspace, gender: Gender): Set<string> | null {
  const source =
    gender === Gender.MEN
      ? workspace.sourceMenResults ?? workspace.menResults
      : workspace.sourceWomenResults ?? workspace.womenResults;
  const program = meetProgramEvents(source);
  return program.size > 0 ? program : null;
}

function planKey(name: string, team: string, gender: Gender, event: string): string {
  return `${normalizeSwimmerName(name)}|${team}|${gender}|${event}`;
}

function recruitEventKey(name: string, team: string, gender: Gender, event: string): string {
  return planKey(name, team, gender, event);
}

function existingPlanEvents(
  plans: PlannedSwimEntry[],
  name: string,
  team: string,
  gender: Gender
): Set<string> {
  const nameKey = normalizeSwimmerName(name);
  const set = new Set<string>();
  for (const p of plans) {
    if (p.gender !== gender || p.team !== team) continue;
    if (normalizeSwimmerName(p.name) !== nameKey) continue;
    set.add(p.event);
  }
  return set;
}

/** Entries already charged against a swimmer's caps, and the events they occupy. */
type EntryCounts = { individual: number; relay: number; events: Set<string> };

/**
 * Roster-plane rows (planned entries and recruit rows) share one exact team/gender/name
 * filter. Result rows do not — they carry an optional gender and an untrimmed team.
 */
function rosterRowMatchesSwimmer(
  row: { name: string; team: string; gender: Gender },
  nameKey: string,
  team: string,
  gender: Gender
): boolean {
  if (row.gender !== gender || row.team !== team) return false;
  return normalizeSwimmerName(row.name) === nameKey;
}

function countExistingEntries(
  plans: PlannedSwimEntry[],
  recruits: Recruit[],
  results: { name: string; team: string; gender?: Gender; event: string; isRelay?: boolean }[],
  name: string,
  team: string,
  gender: Gender
): EntryCounts {
  const nameKey = normalizeSwimmerName(name);
  const counts: EntryCounts = { individual: 0, relay: 0, events: new Set<string>() };

  const consider = (event: string, isRelay: boolean) => {
    if (counts.events.has(event)) return;
    counts.events.add(event);
    if (isRelay) counts.relay += 1;
    else counts.individual += 1;
  };

  for (const r of results) {
    if (!resultMatchesTeamAndGender(r, team, gender)) continue;
    if (normalizeSwimmerName(r.name) !== nameKey) continue;
    const relayish = Boolean(r.isRelay) || isRelayEventName(r.event);
    // A relay aggregate row standing in for the squad is not this swimmer's entry.
    if (relayish && r.name === team) continue;
    consider(r.event, relayish);
  }
  // Plans first, then recruits — the original visit order, which `consider` dedupes by
  // event anyway, so the attribution is the same either way.
  for (const row of [...plans, ...recruits]) {
    if (!rosterRowMatchesSwimmer(row, nameKey, team, gender)) continue;
    consider(row.event, isRelayEventName(row.event));
  }

  return counts;
}

/** A fuzzy roster match at or above this confidence counts as the same athlete. */
const ROSTER_MATCH_CONFIDENCE = 0.7;

type RosterMatch = { match: string | null; confidence: number };

/** The match is strong enough to treat the incoming swimmer as already on the roster. */
function isConfidentRosterMatch(m: RosterMatch): m is RosterMatch & { match: string } {
  return Boolean(m.match) && m.confidence >= ROSTER_MATCH_CONFIDENCE;
}

/** Alias-resolved name keys of every recruit already on this team's roster. */
function recruitNameKeys(
  workspace: Workspace,
  team: string,
  gender: Gender,
  resolver: AthleteAliasResolver
): Set<string> {
  const keys = new Set<string>();
  for (const r of workspace.recruits ?? []) {
    if (r.gender !== gender || r.team !== team) continue;
    keys.add(normalizeSwimmerName(resolver.resolveAthleteName(r.name, team, gender)));
  }
  return keys;
}

/**
 * Which import action a swimmer earns. An ordered rule chain, not a dispatch table:
 * being a recruit already outranks having a new event to add, which outranks being
 * an unknown name.
 */
function classifyImportAction(
  swims: HistoricalSwim[],
  match: RosterMatch,
  resolvedName: string,
  recruitKeys: ReadonlySet<string>,
  existingPlans: PlannedSwimEntry[],
  team: string,
  gender: Gender,
  programEvents: Set<string> | null
): ImportSwimmerAction {
  if (recruitKeys.has(normalizeSwimmerName(resolvedName))) return 'already_recruit';
  if (match.match && recruitKeys.has(normalizeSwimmerName(match.match))) return 'already_recruit';
  if (!isConfidentRosterMatch(match)) return 'new_recruit';

  const existingEvents = existingPlanEvents(existingPlans, match.match, team, gender);
  const hasNewEvent = toProgramCandidates(swims, programEvents).some(
    s => !existingEvents.has(s.event)
  );
  return hasNewEvent ? 'add_to_lineup' : 'history_matched';
}

/**
 * Classify how each unique swimmer in a preview would be handled (for UI badges).
 */
export function previewHistoryImportActions(
  workspace: Workspace,
  preview: HistoricalSwim[],
  opts: Pick<HistoryImportRosterOpts, 'team' | 'gender' | 'resolver'>
): ImportSwimmerPreview[] {
  if (!preview.length || !opts.team.trim()) return [];
  const { team, gender } = opts;
  const resolver = opts.resolver ?? buildAliasResolver(workspace);
  const rosterNames = rosterNamesForTeam(workspace, team, gender);
  const recruitKeys = recruitNameKeys(workspace, team, gender, resolver);
  const programEvents = workspaceProgramEvents(workspace, gender);
  const out: ImportSwimmerPreview[] = [];

  for (const [, swims] of groupPreviewBySwimmer(preview, resolver)) {
    const sample = swims[0];
    if (sample.team !== team || sample.gender !== gender) continue;
    const resolvedName = resolver.resolveAthleteName(sample.name, team, gender);
    const match = matchAthleteToRoster(resolvedName, rosterNames);
    out.push({
      name: sample.name,
      team: sample.team,
      gender: sample.gender,
      swimCount: swims.length,
      action: classifyImportAction(
        swims,
        match,
        resolvedName,
        recruitKeys,
        workspace.meetEntryPlans ?? [],
        team,
        gender,
        programEvents
      ),
      matchedRosterName: match.match,
    });
  }
  return out;
}

/**
 * Candidate swims in the order the entry budget is spent on them: the profile's
 * preferred individual events first, then any remaining individual events, then
 * preferred relays, then any remaining relays. Order is load-bearing — a scarce cap
 * is spent strictly top-down, so the first events listed are the ones that get in.
 *
 * Falls back to every ranked event of the matching kind when the profile names none.
 */
function orderCandidateSwims(
  ranked: HistoricalSwim[],
  profile: { primaryEvents: string[]; relayEvents: string[] }
): HistoricalSwim[] {
  const eventsOfKind = (relay: boolean) =>
    ranked.filter(s => isRelayEventName(s.event) === relay).map(s => s.event);
  const preferredIndividual = profile.primaryEvents.length
    ? profile.primaryEvents
    : eventsOfKind(false);
  const preferredRelay = profile.relayEvents.length ? profile.relayEvents : eventsOfKind(true);

  const candidates: HistoricalSwim[] = [];
  const alreadyQueued = (event: string) => candidates.some(c => c.event === event);
  const queueRemainingOfKind = (relay: boolean) => {
    for (const swim of ranked) {
      if (isRelayEventName(swim.event) !== relay) continue;
      if (alreadyQueued(swim.event)) continue;
      candidates.push(swim);
    }
  };

  // Preferred individual events. No dedupe test here: this writes into an empty list,
  // and a repeated event is absorbed downstream by the per-event guard on the budget.
  for (const ev of preferredIndividual) {
    const swim = ranked.find(s => s.event === ev);
    if (swim) candidates.push(swim);
  }
  queueRemainingOfKind(false);
  for (const ev of preferredRelay) {
    const swim = ranked.find(s => s.event === ev);
    if (swim && !alreadyQueued(swim.event)) candidates.push(swim);
  }
  queueRemainingOfKind(true);
  return candidates;
}

/** Who an incoming group of swims belongs to, once aliases and the roster are consulted. */
type ImportIdentity = {
  /** The name every recruit row or planned entry written for this swimmer will carry. */
  displayName: string;
  /** A confident roster match exists, so the swimmer is already known to the team. */
  isOnRoster: boolean;
  /** A recruit row already carries this swimmer's alias-resolved name. */
  isExistingRecruit: boolean;
};

/**
 * Resolve an incoming swimmer onto the roster: apply aliases, look for a confident
 * roster match, and decide which name their rows will carry.
 */
function resolveImportIdentity(
  sample: HistoricalSwim,
  recruits: Recruit[],
  rosterNames: string[],
  resolver: AthleteAliasResolver,
  team: string,
  gender: Gender
): ImportIdentity {
  const resolvedName = resolver.resolveAthleteName(sample.name, team, gender);
  const match = matchAthleteToRoster(resolvedName, rosterNames);
  const matchedName = isConfidentRosterMatch(match) ? match.match : null;
  const displayName = matchedName ?? resolvedName;
  const displayKey = normalizeSwimmerName(displayName);
  const isExistingRecruit = recruits.some(
    r =>
      r.gender === gender &&
      r.team === team &&
      normalizeSwimmerName(resolver.resolveAthleteName(r.name, team, gender)) === displayKey
  );
  return { displayName, isOnRoster: Boolean(matchedName), isExistingRecruit };
}

/** Per-swimmer entry caps in force for this workspace. */
type EntryCaps = { individual: number; relay: number; total: number };

/** Entry caps, with the defaults that apply when a conference sets none. */
function entryCapsFor(settings: {
  maxIndividualEntriesPerSwimmer?: number;
  maxRelayEntriesPerSwimmer?: number;
  maxTotalEntriesPerSwimmer?: number;
}): EntryCaps {
  return {
    individual: settings.maxIndividualEntriesPerSwimmer ?? 3,
    relay: settings.maxRelayEntriesPerSwimmer ?? 4,
    total: settings.maxTotalEntriesPerSwimmer ?? 999,
  };
}

/** Entry slots still available to a swimmer, counted down as candidates are accepted. */
type EntryBudget = { individual: number; relay: number; total: number };

/** Slots left for a swimmer after the entries they already hold are charged. */
function openEntryBudget(counts: EntryCounts, caps: EntryCaps): EntryBudget {
  return {
    individual: Math.max(0, caps.individual - counts.individual),
    relay: Math.max(0, caps.relay - counts.relay),
    total: Math.max(0, caps.total - (counts.individual + counts.relay)),
  };
}

/** Whether one more entry of this kind fits under both the total and per-kind caps. */
function budgetHasRoom(budget: EntryBudget, relayish: boolean): boolean {
  if (budget.total <= 0) return false;
  return relayish ? budget.relay > 0 : budget.individual > 0;
}

/** Charge an accepted entry against the budget and the swimmer's running counts. */
function spendBudget(
  budget: EntryBudget,
  counts: EntryCounts,
  event: string,
  relayish: boolean
): void {
  counts.events.add(event);
  budget.total -= 1;
  if (relayish) {
    budget.relay -= 1;
    counts.relay += 1;
  } else {
    budget.individual -= 1;
    counts.individual += 1;
  }
}

/** Everything the import writes into, accumulated across all swimmers in one pass. */
type ImportAccumulator = {
  recruits: Recruit[];
  meetEntryPlans: PlannedSwimEntry[];
  activeEntryIds: string[];
  overrides: ScorerRosterOverride[];
  existingRecruitEventKeys: Set<string>;
  newRecruits: number;
  lineupEntriesAdded: number;
};

/** Replace any existing scorer override for this athlete with an is-scorer one. */
function upsertScorerOverride(
  overrides: ScorerRosterOverride[],
  recruit: Recruit
): ScorerRosterOverride[] {
  const key = scorerRosterKey(recruit.team, recruit.gender, recruit.name);
  const rest = overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key);
  return [
    ...rest,
    { name: recruit.name, team: recruit.team, gender: recruit.gender, isScorer: true },
  ];
}

/** Fields shared by every row the import writes for one swimmer. */
type RowContext = {
  displayName: string;
  team: string;
  gender: Gender;
  classYear: ClassYear;
};

/**
 * Add a planned lineup entry for a swimmer already on the roster.
 * Returns false when a plan for that event already exists, so nothing was written.
 */
function appendLineupEntry(
  acc: ImportAccumulator,
  ctx: RowContext,
  swim: HistoricalSwim
): boolean {
  const existingEvents = existingPlanEvents(
    acc.meetEntryPlans,
    ctx.displayName,
    ctx.team,
    ctx.gender
  );
  if (existingEvents.has(swim.event)) return false;
  const entry = createPlannedEntry({
    name: ctx.displayName,
    team: ctx.team,
    gender: ctx.gender,
    classYear: ctx.classYear,
    event: swim.event,
    time: swim.time,
    timeType: swim.timeType ?? 'SCY',
    source: 'swimcloud',
    active: true,
  });
  acc.meetEntryPlans.push(entry);
  acc.activeEntryIds.push(entry.id);
  acc.lineupEntriesAdded += 1;
  return true;
}

/**
 * Add a recruit row for a swimmer new to the roster — this is what makes them visible
 * via buildWhatIfResults. Returns false when a recruit row for that event already exists.
 */
function appendRecruitRow(
  acc: ImportAccumulator,
  ctx: RowContext,
  swim: HistoricalSwim,
  markAsScorer: boolean
): boolean {
  const key = recruitEventKey(ctx.displayName, ctx.team, ctx.gender, swim.event);
  if (acc.existingRecruitEventKeys.has(key)) return false;
  const recruit: Recruit = {
    id: uuidv4(),
    name: ctx.displayName,
    team: ctx.team,
    event: swim.event,
    time: swim.time,
    gender: ctx.gender,
    classYear: ctx.classYear,
    timeType: swim.timeType ?? 'SCY',
  };
  acc.recruits.push(recruit);
  acc.existingRecruitEventKeys.add(key);
  acc.newRecruits += 1;
  if (markAsScorer) acc.overrides = upsertScorerOverride(acc.overrides, recruit);
  return true;
}

/** Settings resolved once for the whole import and read by every swimmer group. */
type ImportContext = {
  team: string;
  gender: Gender;
  caps: EntryCaps;
  settings: ScoringSettings;
  resolver: AthleteAliasResolver;
  rosterNames: string[];
  results: SwimmerResult[];
  programEvents: Set<string> | null;
  classYearOverrides: Map<string, ClassYear>;
  markNewRecruitsAsScorers: boolean;
};

/**
 * Import one swimmer's swims: resolve who they are, rank their events against the
 * program, then spend their remaining entry budget on the best candidates. A swimmer
 * already known to the team gains lineup entries; a new one gains recruit rows.
 */
function importSwimmerGroup(
  acc: ImportAccumulator,
  ctx: ImportContext,
  swims: HistoricalSwim[]
): void {
  const sample = swims[0];
  if (sample.team !== ctx.team || sample.gender !== ctx.gender) return;

  const { displayName, isOnRoster, isExistingRecruit } = resolveImportIdentity(
    sample,
    acc.recruits,
    ctx.rosterNames,
    ctx.resolver,
    ctx.team,
    ctx.gender
  );

  const ranked = toProgramCandidates(swims, ctx.programEvents);
  const profile = categorizeBestEvents(
    ranked,
    ctx.team,
    ctx.gender,
    displayName,
    ctx.settings,
    ranked.filter(s => isRelayEventName(s.event)).map(s => s.event),
    undefined,
    ctx.programEvents
  );

  const counts = countExistingEntries(
    acc.meetEntryPlans,
    acc.recruits,
    ctx.results,
    displayName,
    ctx.team,
    ctx.gender
  );

  const budget = openEntryBudget(counts, ctx.caps);
  const rowContext: RowContext = {
    displayName,
    team: ctx.team,
    gender: ctx.gender,
    classYear:
      lookupClassYearOverride(ctx.classYearOverrides, displayName, sample.name) ??
      parseClassYear(sample.classYear),
  };

  for (const swim of orderCandidateSwims(ranked, profile)) {
    const relayish = isRelayEventName(swim.event);
    if (counts.events.has(swim.event)) continue;
    if (!budgetHasRoom(budget, relayish)) continue;

    // A swimmer already known to the team joins the lineup; a new one becomes a
    // recruit row. Either writer declines when that event is already present.
    const written =
      isOnRoster || isExistingRecruit
        ? appendLineupEntry(acc, rowContext, swim)
        : appendRecruitRow(acc, rowContext, swim, ctx.markNewRecruitsAsScorers);
    if (!written) continue;

    spendBudget(budget, counts, swim.event, relayish);
  }
}

/** Copy the workspace planes the import writes into, so the originals stay untouched. */
function openImportAccumulator(
  workspace: Workspace,
  team: string,
  gender: Gender
): ImportAccumulator {
  const recruits = [...(workspace.recruits ?? [])];
  return {
    recruits,
    meetEntryPlans: [...(workspace.meetEntryPlans ?? [])],
    activeEntryIds: [...(workspace.activeEntryIds ?? [])],
    overrides: [...(workspace.scorerRosterOverrides ?? [])],
    existingRecruitEventKeys: new Set(
      recruits
        .filter(r => r.gender === gender && r.team === team)
        .map(r => recruitEventKey(r.name, r.team, r.gender, r.event))
    ),
    newRecruits: 0,
    lineupEntriesAdded: 0,
  };
}

/** The workspace's history-source log with this import appended. */
function appendHistorySource(
  workspace: Workspace,
  opts: HistoryImportRosterOpts,
  swimCount: number,
  team: string
): NonNullable<Workspace['historySources']> {
  return [
    ...(workspace.historySources ?? []),
    {
      type: opts.sourceType ?? 'paste',
      label: opts.sourceLabel ?? `Import ${swimCount} swims (${team})`,
      importedAt: Date.now(),
    },
  ];
}

/**
 * Merge preview into athleteHistory and bridge new/existing athletes onto the roster
 * via recruits and meetEntryPlans. Does not mutate menResults/womenResults.
 */
export function importHistoryToRoster(
  workspace: Workspace,
  preview: HistoricalSwim[],
  opts: HistoryImportRosterOpts
): HistoryImportRosterResult {
  const team = opts.team.trim();

  if (!preview.length || !team) {
    return {
      noop: true,
      patch: {},
      summary: {
        swimsMerged: 0,
        newRecruits: 0,
        lineupEntriesAdded: 0,
        swimmers: [] as ImportSwimmerPreview[],
      },
    };
  }

  const gender = opts.gender;
  const resolver = opts.resolver ?? buildAliasResolver(workspace);
  const settings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const caps = entryCapsFor(settings);

  const athleteHistory = mergeHistoryIndex(workspace.athleteHistory ?? [], preview);
  const historySources = appendHistorySource(workspace, opts, preview.length, team);
  const acc = openImportAccumulator(workspace, team, gender);

  const ctx: ImportContext = {
    team,
    gender,
    caps,
    settings,
    resolver,
    rosterNames: rosterNamesForTeam(workspace, team, gender),
    results: resultsForGender(workspace, gender),
    programEvents: workspaceProgramEvents(workspace, gender),
    classYearOverrides: buildClassYearOverrideLookup(opts.classYearOverrides),
    markNewRecruitsAsScorers: usesScorerRoster(settings),
  };
  const swimmerPreviews = previewHistoryImportActions(workspace, preview, { team, gender, resolver });

  for (const [, swims] of groupPreviewBySwimmer(preview, resolver)) {
    importSwimmerGroup(acc, ctx, swims);
  }

  const patch: Partial<Workspace> = {
    athleteHistory,
    historySources,
    recruits: acc.recruits,
    meetEntryPlans: acc.meetEntryPlans,
    activeEntryIds: acc.activeEntryIds,
  };
  if (ctx.markNewRecruitsAsScorers) {
    patch.scorerRosterOverrides = acc.overrides;
  }

  return {
    noop: false,
    patch,
    summary: {
      swimsMerged: preview.length,
      newRecruits: acc.newRecruits,
      lineupEntriesAdded: acc.lineupEntriesAdded,
      swimmers: swimmerPreviews,
    },
  };
}

export function formatHistoryImportSummary(summary: HistoryImportRosterResult['summary']): string {
  const parts = [`${summary.swimsMerged} swim(s) merged`];
  if (summary.newRecruits > 0) parts.push(`${summary.newRecruits} new recruit entr${summary.newRecruits === 1 ? 'y' : 'ies'}`);
  if (summary.lineupEntriesAdded > 0) {
    parts.push(`${summary.lineupEntriesAdded} lineup entr${summary.lineupEntriesAdded === 1 ? 'y' : 'ies'} added`);
  }
  return parts.join(', ');
}
