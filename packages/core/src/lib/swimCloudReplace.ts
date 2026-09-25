/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Replace mode for a full SwimCloud reimport (plans/2026-09-24, item A1).
 *
 * A merge import (`importHistoryToRoster`, the default) never deletes a row.
 * So a reimport cannot correct a row an earlier import wrote under older
 * rules: a recruit row built from a self-reported swim, a `d1_a` badge read
 * off a bare `A`, a `D2 B` stamp read as a meet name. The real case is Fabio
 * Capocci on the HSU 2026-27 roster plan: his recruit row and optimizer plan
 * for 100 Backstroke 48.15 are the SCY conversion of a self-reported
 * `100 Back LCM 56.98 U`.
 *
 * A replace removes one team and gender's SwimCloud-sourced rows first, then
 * runs the ordinary import on what is left. User decision (2026-09-24): a
 * replace may delete that team's SwimCloud history, recruit rows and plan
 * entries, after a preview and a backup. **Manual and PDF data stay.**
 *
 * This module only decides what goes. {@link planSwimCloudReplace} is pure;
 * {@link applySwimCloudReplacePlan} turns a plan into a patch. The caller must
 * show the plan and back the workspace up before it saves the result.
 *
 * ## What is SwimCloud-sourced
 *
 * - **History.** `source: 'swimcloud'` (the JSON/HTML bridge) **or
 *   `source: 'paste'`**. The SwimCloud paste parsers
 *   (`parseSwimCloudPersonalBestsDetailed`, `parseSwimCloudRosterPasteDetailed`)
 *   are the only writers of `'paste'`, and every stored SwimCloud row older
 *   than the JSON bridge is one. Measured 2026-09-25 on `data/meets.json`: the
 *   HSU 2026-27 roster plan holds 870 history rows, all `'paste'`, and none
 *   `'swimcloud'`. A filter on `'swimcloud'` alone removes nothing there.
 * - **Plans.** `source: 'swimcloud'` goes. `source: 'optimizer'` goes only
 *   when it traces (below). `'manual'` and `'pdf'` never go.
 * - **Recruit rows.** A row with a recorded `source` goes when that source is
 *   SwimCloud. A row with no `source` (every row written before 2026-09-25)
 *   goes only when it traces.
 *
 * Never touched: meet results, psych results, aliases, scorer overrides,
 * relay-leg overrides, deleted swimmers, the history-source log, and every
 * row of another team or gender.
 *
 * ## Tracing
 *
 * A recruit row or optimizer plan **traces** to a history row when all of
 * these match:
 *
 * - the athlete: `aliasNameKey` of the alias-resolved name (so "Capocci,
 *   Fabio" and "Fabio Capocci" are one athlete, and so are linked spellings);
 * - the event: `swimEventIdentity`, so "100 Back SCY" and "100 Backstroke" are
 *   one event;
 * - the course and the time, to the hundredth, as any of these statements of
 *   the history row: the swim as recorded; its SCY conversion today (the same
 *   `convertSwimToSCYDetailed` call the import makes); for an SCM swim, the
 *   SCY conversion the import made before 2026-09-22 (below). A row that
 *   still carries `convertedFrom` also traces through the metric swim it
 *   names.
 *
 * The pre-2026-09-22 SCM statement exists only to recognize rows the old
 * import wrote. Until 2026-09-22 the import converted every SCM swim with
 * `CONVERSION_FACTORS[event].both_scm` (the NCAA D1 2025-26 factor) for every
 * team, rounded to the hundredth. Today it uses the division's table and
 * truncates. Measured on the HSU plan: 8 of 214 recruit rows and 3 of 67
 * plans (Noel Kis, Máté Hosszú, Alex Tarkovács, Emiliano Pina) match only the
 * old statement; with it, all 214 and 67 trace. It never produces a time
 * anyone reads.
 *
 * A traced row stays when its time **also** traces to data the replace keeps:
 * a history row of another source, a loaded-meet, source or psych result, or
 * (for a plan) a recruit row that stays. It could have come from either, so
 * it is not proven SwimCloud-built. It is listed in `keptAmbiguous`.
 *
 * A row that should trace but does not stays and is listed in `keptUntraced`:
 * a recruit row with no source, or an optimizer plan, of an athlete who loses
 * SwimCloud history. Known case: a 400 IM LCM recruit converted with the
 * 50 Freestyle factor by a fallback removed before this change.
 */

import {
  Gender,
  type HistoricalSwim,
  type HistoricalSwimSource,
  type PlannedSwimEntry,
  type Recruit,
  type RelayLegOverride,
  type SwimmerResult,
  type Workspace,
} from '../types';
import { CONVERSION_FACTORS } from '../constants';
import { aliasNameKey, buildAliasResolver, type AthleteAliasResolver } from './athleteAliases';
import { swimEventIdentity } from './bestTimeEligibility';
import {
  convertSwimToSCYDetailed,
  convertTimeToSeconds,
  formatSecondsToTime,
  hasConversionFactorForCourse,
  resolveConversionFactorKey,
} from './utils';

/**
 * The {@link HistoricalSwim.source} values a SwimCloud import writes:
 * `'swimcloud'` (JSON/HTML bridge) and `'paste'` (the SwimCloud paste
 * parsers, the only writers of `'paste'`).
 */
export const SWIMCLOUD_HISTORY_SOURCES: readonly HistoricalSwimSource[] = Object.freeze([
  'swimcloud',
  'paste',
]);

/** The source is one a SwimCloud import writes. See {@link SWIMCLOUD_HISTORY_SOURCES}. */
export function isSwimCloudHistorySource(source: string | null | undefined): boolean {
  return (SWIMCLOUD_HISTORY_SOURCES as readonly string[]).includes(String(source ?? ''));
}

export type SwimCloudReplaceOpts = {
  /** Team name. Trimmed; rows match on their trimmed team, exactly. */
  team: string;
  gender: Gender;
  /** Defaults to a resolver built from `workspace.athleteAliases`. */
  resolver?: AthleteAliasResolver;
};

/**
 * Why a row is removed.
 *
 * - `swimcloud_source` — the row's own `source` says SwimCloud.
 * - `traced_to_removed_swim` — the row has no such source, but its athlete,
 *   event and time trace to a history row being removed, and to nothing kept.
 */
export type SwimCloudReplaceReason = 'swimcloud_source' | 'traced_to_removed_swim';

export type SwimCloudReplaceRemoval<T> = {
  row: T;
  reason: SwimCloudReplaceReason;
  /** The removed history row it traced to. Set only for `traced_to_removed_swim`. */
  tracedTo?: HistoricalSwim;
};

/** Recruit rows and plans a replace keeps, grouped for a preview. */
export type SwimCloudReplaceKeptRows = {
  recruits: Recruit[];
  plans: PlannedSwimEntry[];
};

/** What a replace removes, and what it keeps, for one team and gender. */
export type SwimCloudReplacePlan = {
  /** Trimmed team the plan was made for. */
  team: string;
  gender: Gender;
  historyToRemove: HistoricalSwim[];
  recruitsToRemove: SwimCloudReplaceRemoval<Recruit>[];
  plansToRemove: SwimCloudReplaceRemoval<PlannedSwimEntry>[];
  /** Rows of this team and gender that stay, per plane. */
  keptCounts: { history: number; recruits: number; plans: number };
  /** Traced to a removed swim and also to kept data, so kept. See the module note. */
  keptAmbiguous: SwimCloudReplaceKeptRows;
  /**
   * Rows with no SwimCloud source that belong to an athlete losing SwimCloud
   * history but trace to nothing. Kept, and listed so a preview can show them.
   */
  keptUntraced: SwimCloudReplaceKeptRows;
  /**
   * Relay-leg overrides that name a removed recruit row by `recruitId`. They
   * are kept; the leg falls back to `assigneeName`, as it does for any id
   * that no longer resolves.
   */
  relayOverridesLosingRecruit: RelayLegOverride[];
};

type Course = 'SCY' | 'LCM' | 'SCM';

const SEP = '\u0000';

/** Trimmed team, the one team comparison this module makes. */
function trimmedTeam(team: string | null | undefined): string {
  return String(team ?? '').trim();
}

function traceKey(athlete: string, event: string, course: Course, time: string): string | null {
  const seconds = convertTimeToSeconds(time);
  if (!Number.isFinite(seconds)) return null;
  const identity = swimEventIdentity(event);
  if (!athlete || !identity) return null;
  return [athlete, identity, course, Math.round(seconds * 100)].join(SEP);
}

function isRelayEvent(event: string): boolean {
  return /\brelay\b/i.test(String(event ?? ''));
}

/**
 * The SCY time the import wrote for an SCM swim before 2026-09-22: the D1
 * `both_scm` factor for every team, rounded to the hundredth. For tracing
 * only. Null for an event that path could not convert.
 */
function preSeptember22ScmTime(event: string, time: string): string | null {
  const factorKey = resolveConversionFactorKey(event);
  if (!factorKey) return null;
  const seconds = convertTimeToSeconds(time);
  if (!Number.isFinite(seconds)) return null;
  return formatSecondsToTime(seconds * CONVERSION_FACTORS[factorKey].both_scm);
}

/**
 * Every statement of a swim a row written from it could hold: as recorded,
 * its SCY conversion today, and for SCM its pre-2026-09-22 conversion.
 */
function swimStatementKeys(
  athlete: string,
  swim: { event: string; time: string; timeType?: Course; gender?: Gender; team?: string }
): string[] {
  const course: Course = swim.timeType ?? 'SCY';
  const keys = [traceKey(athlete, swim.event, course, swim.time)];
  const convertible =
    course !== 'SCY' &&
    !isRelayEvent(swim.event) &&
    hasConversionFactorForCourse(swim.event, course) &&
    Number.isFinite(convertTimeToSeconds(swim.time));
  if (convertible) {
    const now = convertSwimToSCYDetailed(
      swim.event,
      swim.time,
      swim.gender ?? Gender.MEN,
      course,
      { team: swim.team }
    );
    keys.push(traceKey(athlete, now.event, 'SCY', now.time));
    if (course === 'SCM') {
      const legacy = preSeptember22ScmTime(swim.event, swim.time);
      if (legacy) keys.push(traceKey(athlete, now.event, 'SCY', legacy));
    }
  }
  return keys.filter((k): k is string => k !== null);
}

/**
 * The keys a recruit row or plan traces through: its own event and time, and
 * the metric swim its `convertedFrom` names while that record still describes
 * the row (the row's time equals `scyTime`).
 */
function rowTraceKeys(
  athlete: string,
  row: Pick<Recruit, 'event' | 'time' | 'convertedFrom'> & { timeType?: Course }
): string[] {
  const keys = [traceKey(athlete, row.event, row.timeType ?? 'SCY', row.time)];
  const from = row.convertedFrom;
  if (from && convertTimeToSeconds(from.scyTime) === convertTimeToSeconds(row.time)) {
    keys.push(traceKey(athlete, from.sourceEvent, from.sourceCourse, from.sourceTime));
  }
  return keys.filter((k): k is string => k !== null);
}

/** The result planes of one gender: working, frozen source, and psych. */
function resultPlanes(workspace: Workspace, gender: Gender): SwimmerResult[] {
  return gender === Gender.MEN
    ? [
        ...(workspace.menResults ?? []),
        ...(workspace.sourceMenResults ?? []),
        ...(workspace.psychMenResults ?? []),
      ]
    : [
        ...(workspace.womenResults ?? []),
        ...(workspace.sourceWomenResults ?? []),
        ...(workspace.psychWomenResults ?? []),
      ];
}

type RowOfTeam = { team: string; gender: Gender };

function belongsTo(row: RowOfTeam, team: string, gender: Gender): boolean {
  return row.gender === gender && trimmedTeam(row.team) === team;
}

/** Everything tracing reads, built once per plan. */
type TraceIndex = {
  athleteKey: (name: string) => string;
  /** Trace key → first removed history row stated by it. */
  removed: Map<string, HistoricalSwim>;
  /** Trace keys of kept history rows and of result rows. */
  keptBasis: Set<string>;
  /** Athletes with at least one removed history row. */
  athletesLosingHistory: Set<string>;
};

function buildTraceIndex(
  workspace: Workspace,
  team: string,
  gender: Gender,
  resolver: AthleteAliasResolver,
  historyToRemove: ReadonlySet<HistoricalSwim>
): TraceIndex {
  const athleteKey = (name: string) =>
    aliasNameKey(resolver.resolveAthleteName(name, team, gender));
  const removed = new Map<string, HistoricalSwim>();
  const keptBasis = new Set<string>();
  const athletesLosingHistory = new Set<string>();

  for (const swim of workspace.athleteHistory ?? []) {
    if (!belongsTo(swim, team, gender)) continue;
    const athlete = athleteKey(swim.name);
    const keys = swimStatementKeys(athlete, swim);
    if (historyToRemove.has(swim)) {
      athletesLosingHistory.add(athlete);
      for (const k of keys) if (!removed.has(k)) removed.set(k, swim);
    } else {
      for (const k of keys) keptBasis.add(k);
    }
  }
  for (const r of resultPlanes(workspace, gender)) {
    if (trimmedTeam(r.team) !== team) continue;
    if (r.gender != null && r.gender !== gender) continue;
    if (r.isRelay && r.name === r.team) continue;
    for (const k of swimStatementKeys(athleteKey(r.name), { ...r, timeType: 'SCY', gender })) {
      keptBasis.add(k);
    }
  }
  return { athleteKey, removed, keptBasis, athletesLosingHistory };
}

type Trace =
  | { kind: 'removed'; tracedTo: HistoricalSwim }
  | { kind: 'ambiguous' }
  | { kind: 'untraced' }
  | { kind: 'unrelated' };

function traceRow(
  index: TraceIndex,
  row: Pick<Recruit, 'name' | 'event' | 'time' | 'convertedFrom'> & { timeType?: Course },
  extraKeptBasis: ReadonlySet<string> = new Set()
): Trace {
  const athlete = index.athleteKey(row.name);
  const keys = rowTraceKeys(athlete, row);
  const hit = keys.map(k => index.removed.get(k)).find(h => h !== undefined);
  if (hit) {
    const alsoKept = keys.some(k => index.keptBasis.has(k) || extraKeptBasis.has(k));
    return alsoKept ? { kind: 'ambiguous' } : { kind: 'removed', tracedTo: hit };
  }
  return index.athletesLosingHistory.has(athlete) ? { kind: 'untraced' } : { kind: 'unrelated' };
}

/**
 * Decide what a replace reimport removes for one team and gender. Pure: the
 * workspace is not changed. See the module note for every rule.
 *
 * Returns an empty plan (nothing to remove) when the team is blank.
 */
export function planSwimCloudReplace(
  workspace: Workspace,
  opts: SwimCloudReplaceOpts
): SwimCloudReplacePlan {
  const team = trimmedTeam(opts.team);
  const gender = opts.gender;
  const plan: SwimCloudReplacePlan = {
    team,
    gender,
    historyToRemove: [],
    recruitsToRemove: [],
    plansToRemove: [],
    keptCounts: { history: 0, recruits: 0, plans: 0 },
    keptAmbiguous: { recruits: [], plans: [] },
    keptUntraced: { recruits: [], plans: [] },
    relayOverridesLosingRecruit: [],
  };
  if (!team) return plan;
  const resolver = opts.resolver ?? buildAliasResolver(workspace);

  for (const swim of workspace.athleteHistory ?? []) {
    if (!belongsTo(swim, team, gender)) continue;
    if (isSwimCloudHistorySource(swim.source)) plan.historyToRemove.push(swim);
    else plan.keptCounts.history += 1;
  }
  const index = buildTraceIndex(workspace, team, gender, resolver, new Set(plan.historyToRemove));

  const keptRecruitKeys = new Set<string>();
  for (const recruit of workspace.recruits ?? []) {
    if (!belongsTo(recruit, team, gender)) continue;
    const removal = recruitRemoval(index, recruit, plan);
    if (removal) {
      plan.recruitsToRemove.push(removal);
      continue;
    }
    plan.keptCounts.recruits += 1;
    for (const k of rowTraceKeys(index.athleteKey(recruit.name), recruit)) keptRecruitKeys.add(k);
  }

  for (const entry of workspace.meetEntryPlans ?? []) {
    if (!belongsTo(entry, team, gender)) continue;
    const removal = planRemoval(index, entry, plan, keptRecruitKeys);
    if (removal) plan.plansToRemove.push(removal);
    else plan.keptCounts.plans += 1;
  }

  const removedRecruitIds = new Set(plan.recruitsToRemove.map(r => r.row.id));
  plan.relayOverridesLosingRecruit = (workspace.relayLegOverrides ?? []).filter(
    o => o.recruitId != null && removedRecruitIds.has(o.recruitId)
  );
  return plan;
}

/** A recruit row's removal, or null when it stays (recorded on `plan` when notable). */
function recruitRemoval(
  index: TraceIndex,
  recruit: Recruit,
  plan: SwimCloudReplacePlan
): SwimCloudReplaceRemoval<Recruit> | null {
  if (recruit.source != null) {
    return isSwimCloudHistorySource(recruit.source)
      ? { row: recruit, reason: 'swimcloud_source' }
      : null;
  }
  const trace = traceRow(index, recruit);
  if (trace.kind === 'removed') {
    return { row: recruit, reason: 'traced_to_removed_swim', tracedTo: trace.tracedTo };
  }
  if (trace.kind === 'ambiguous') plan.keptAmbiguous.recruits.push(recruit);
  if (trace.kind === 'untraced') plan.keptUntraced.recruits.push(recruit);
  return null;
}

/** A plan's removal, or null when it stays (recorded on `plan` when notable). */
function planRemoval(
  index: TraceIndex,
  entry: PlannedSwimEntry,
  plan: SwimCloudReplacePlan,
  keptRecruitKeys: ReadonlySet<string>
): SwimCloudReplaceRemoval<PlannedSwimEntry> | null {
  if (entry.source === 'swimcloud') return { row: entry, reason: 'swimcloud_source' };
  if (entry.source !== 'optimizer') return null;
  const trace = traceRow(index, entry, keptRecruitKeys);
  if (trace.kind === 'removed') {
    return { row: entry, reason: 'traced_to_removed_swim', tracedTo: trace.tracedTo };
  }
  if (trace.kind === 'ambiguous') plan.keptAmbiguous.plans.push(entry);
  if (trace.kind === 'untraced') plan.keptUntraced.plans.push(entry);
  return null;
}

/** The planes a replace changes. */
export type SwimCloudReplacePatch = Required<
  Pick<Workspace, 'athleteHistory' | 'recruits' | 'meetEntryPlans' | 'activeEntryIds'>
>;

/**
 * The workspace planes with the plan's rows removed, in their original order.
 * Removed plans also leave `activeEntryIds`. Nothing else changes.
 *
 * Rows are matched by object identity, so the plan must come from this same
 * workspace object. Throws when a planned row is missing: a stale plan must
 * never be applied to a different copy of the workspace.
 */
export function applySwimCloudReplacePlan(
  workspace: Workspace,
  plan: SwimCloudReplacePlan
): SwimCloudReplacePatch {
  const history = new Set<HistoricalSwim>(plan.historyToRemove);
  const recruits = new Set<Recruit>(plan.recruitsToRemove.map(r => r.row));
  const plans = new Set<PlannedSwimEntry>(plan.plansToRemove.map(r => r.row));

  const athleteHistory = withoutRows(workspace.athleteHistory ?? [], history, 'history row');
  const nextRecruits = withoutRows(workspace.recruits ?? [], recruits, 'recruit row');
  const meetEntryPlans = withoutRows(workspace.meetEntryPlans ?? [], plans, 'plan');
  const removedPlanIds = new Set([...plans].map(p => p.id));
  const activeEntryIds = (workspace.activeEntryIds ?? []).filter(id => !removedPlanIds.has(id));
  return { athleteHistory, recruits: nextRecruits, meetEntryPlans, activeEntryIds };
}

function withoutRows<T>(rows: readonly T[], remove: ReadonlySet<T>, label: string): T[] {
  const kept: T[] = [];
  const found = new Set<T>();
  for (const row of rows) {
    if (remove.has(row)) found.add(row);
    else kept.push(row);
  }
  if (found.size !== remove.size) {
    throw new Error(
      `SwimCloud replace plan does not match this workspace: ${remove.size - found.size} ${label}(s) ` +
        'to remove are not in it. Re-plan against the workspace being saved.'
    );
  }
  return kept;
}
