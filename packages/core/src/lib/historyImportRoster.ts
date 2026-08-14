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
  ScorerRosterOverride,
  Workspace,
} from '../types';
import {
  mergeHistoryIndex,
  matchAthleteToRoster,
  categorizeBestEvents,
  isChampionshipProgramEvent,
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

function parseClassYear(raw: string | undefined): ClassYear {
  const u = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (u === 'FR' || u === 'FRESHMAN') return ClassYear.FR;
  if (u === 'SO' || u === 'SOPHOMORE') return ClassYear.SO;
  if (u === 'JR' || u === 'JUNIOR') return ClassYear.JR;
  if (u === 'SR' || u === 'SENIOR') return ClassYear.SR;
  if (u === 'HS') return ClassYear.HS;
  return ClassYear.HS;
}

export function rosterNamesForTeam(workspace: Workspace, team: string, gender: Gender): string[] {
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const names = new Set<string>();
  for (const r of results) {
    if (String(r.team ?? '').trim() !== team) continue;
    if (r.gender != null && r.gender !== gender) continue;
    if (r.isRelay && r.name === r.team) continue;
    names.add(r.name);
  }
  for (const r of workspace.recruits ?? []) {
    if (r.gender !== gender) continue;
    if (r.team !== team) continue;
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
function toProgramCandidates(swims: HistoricalSwim[]): HistoricalSwim[] {
  const best = new Map<string, HistoricalSwim>();
  for (const s of swims) {
    const relay = isRelayEventName(s.event);
    // A metric swim we hold no published factor for cannot be stated in SCY. Such
    // events (25s, 100 IM) are never part of the championship program and would be
    // dropped on the next line anyway — skip before converting rather than after.
    if (!relay && (s.timeType ?? 'SCY') !== 'SCY' && !hasConversionFactor(s.event)) continue;
    const { event, time } = relay
      ? { event: s.event, time: s.time }
      : convertSwimToSCY(s.event, s.time, s.gender, s.timeType ?? 'SCY');
    if (!isChampionshipProgramEvent(event)) continue;
    const candidate: HistoricalSwim = { ...s, event, time, timeType: 'SCY' };
    const sec = convertTimeToSeconds(time);
    const prev = best.get(event);
    if (!prev || sec < convertTimeToSeconds(prev.time)) best.set(event, candidate);
  }
  return [...best.values()].sort(
    (a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time)
  );
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

function countExistingEntries(
  plans: PlannedSwimEntry[],
  recruits: Recruit[],
  results: { name: string; team: string; gender?: Gender; event: string; isRelay?: boolean }[],
  name: string,
  team: string,
  gender: Gender
): { individual: number; relay: number; events: Set<string> } {
  const nameKey = normalizeSwimmerName(name);
  const events = new Set<string>();
  let individual = 0;
  let relay = 0;

  const consider = (event: string, isRelay: boolean) => {
    if (events.has(event)) return;
    events.add(event);
    if (isRelay) relay += 1;
    else individual += 1;
  };

  for (const r of results) {
    if (String(r.team ?? '').trim() !== team) continue;
    if (r.gender != null && r.gender !== gender) continue;
    if (normalizeSwimmerName(r.name) !== nameKey) continue;
    const relayish = Boolean(r.isRelay) || isRelayEventName(r.event);
    if (relayish && r.name === team) continue;
    consider(r.event, relayish);
  }
  for (const p of plans) {
    if (p.gender !== gender || p.team !== team) continue;
    if (normalizeSwimmerName(p.name) !== nameKey) continue;
    consider(p.event, isRelayEventName(p.event));
  }
  for (const r of recruits) {
    if (r.gender !== gender || r.team !== team) continue;
    if (normalizeSwimmerName(r.name) !== nameKey) continue;
    consider(r.event, isRelayEventName(r.event));
  }

  return { individual, relay, events };
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
  const resolver = opts.resolver ?? buildAliasResolver(workspace);
  const rosterNames = rosterNamesForTeam(workspace, opts.team, opts.gender);
  const recruitKeys = new Set(
    (workspace.recruits ?? [])
      .filter(r => r.gender === opts.gender && r.team === opts.team)
      .map(r => normalizeSwimmerName(resolver.resolveAthleteName(r.name, opts.team, opts.gender)))
  );
  const groups = groupPreviewBySwimmer(preview, resolver);
  const out: ImportSwimmerPreview[] = [];

  for (const [, swims] of groups) {
    const sample = swims[0];
    if (sample.team !== opts.team || sample.gender !== opts.gender) continue;
    const resolvedName = resolver.resolveAthleteName(sample.name, opts.team, opts.gender);
    const match = matchAthleteToRoster(resolvedName, rosterNames);
    const isRecruitAlready = recruitKeys.has(normalizeSwimmerName(resolvedName));
    let action: ImportSwimmerAction;
    if (isRecruitAlready || (match.match && recruitKeys.has(normalizeSwimmerName(match.match)))) {
      action = 'already_recruit';
    } else if (match.match && match.confidence >= 0.7) {
      const existingEvents = existingPlanEvents(
        workspace.meetEntryPlans ?? [],
        match.match,
        opts.team,
        opts.gender
      );
      const hasNew = toProgramCandidates(swims).some(s => !existingEvents.has(s.event));
      action = hasNew ? 'add_to_lineup' : 'history_matched';
    } else {
      action = 'new_recruit';
    }
    out.push({
      name: sample.name,
      team: sample.team,
      gender: sample.gender,
      swimCount: swims.length,
      action,
      matchedRosterName: match.match,
    });
  }
  return out;
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
  const emptySummary = {
    swimsMerged: 0,
    newRecruits: 0,
    lineupEntriesAdded: 0,
    swimmers: [] as ImportSwimmerPreview[],
  };

  if (!preview.length || !team) {
    return {
      noop: true,
      patch: {},
      summary: emptySummary,
    };
  }

  const gender = opts.gender;
  const resolver = opts.resolver ?? buildAliasResolver(workspace);
  const settings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const indCap = settings.maxIndividualEntriesPerSwimmer ?? 3;
  const relayCap = settings.maxRelayEntriesPerSwimmer ?? 4;
  const totalCap = settings.maxTotalEntriesPerSwimmer ?? 999;

  const athleteHistory = mergeHistoryIndex(workspace.athleteHistory ?? [], preview);
  const historySources = [
    ...(workspace.historySources ?? []),
    {
      type: opts.sourceType ?? 'paste',
      label:
        opts.sourceLabel ??
        `Import ${preview.length} swims (${team})`,
      importedAt: Date.now(),
    },
  ];

  const recruits = [...(workspace.recruits ?? [])];
  const meetEntryPlans = [...(workspace.meetEntryPlans ?? [])];
  const activeEntryIds = [...(workspace.activeEntryIds ?? [])];
  let overrides = [...(workspace.scorerRosterOverrides ?? [])];

  const rosterNames = rosterNamesForTeam(workspace, team, gender);
  const classYearOverrides = buildClassYearOverrideLookup(opts.classYearOverrides);
  const results =
    gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];

  const existingRecruitEventKeys = new Set(
    recruits
      .filter(r => r.gender === gender && r.team === team)
      .map(r => recruitEventKey(r.name, r.team, r.gender, r.event))
  );

  let newRecruits = 0;
  let lineupEntriesAdded = 0;
  const swimmerPreviews = previewHistoryImportActions(workspace, preview, { team, gender, resolver });

  const groups = groupPreviewBySwimmer(preview, resolver);
  for (const [, swims] of groups) {
    const sample = swims[0];
    if (sample.team !== team || sample.gender !== gender) continue;

    const resolvedSampleName = resolver.resolveAthleteName(sample.name, team, gender);
    const match = matchAthleteToRoster(resolvedSampleName, rosterNames);
    const matchedName = match.match && match.confidence >= 0.7 ? match.match : null;
    const displayName = matchedName ?? resolvedSampleName;
    const isOnRoster = Boolean(matchedName);
    const isExistingRecruit = recruits.some(
      r =>
        r.gender === gender &&
        r.team === team &&
        normalizeSwimmerName(resolver.resolveAthleteName(r.name, team, gender)) ===
          normalizeSwimmerName(displayName)
    );

    const ranked = toProgramCandidates(swims);
    const profile = categorizeBestEvents(
      ranked,
      team,
      gender,
      displayName,
      settings,
      ranked.filter(s => isRelayEventName(s.event)).map(s => s.event)
    );

    const counts = countExistingEntries(
      meetEntryPlans,
      recruits,
      results,
      displayName,
      team,
      gender
    );

    const preferredInd = profile.primaryEvents.length
      ? profile.primaryEvents
      : ranked.filter(s => !isRelayEventName(s.event)).map(s => s.event);
    const preferredRelay = profile.relayEvents.length
      ? profile.relayEvents
      : ranked.filter(s => isRelayEventName(s.event)).map(s => s.event);

    const candidates: HistoricalSwim[] = [];
    for (const ev of preferredInd) {
      const swim = ranked.find(s => s.event === ev);
      if (swim) candidates.push(swim);
    }
    for (const swim of ranked) {
      if (!isRelayEventName(swim.event) && !candidates.some(c => c.event === swim.event)) {
        candidates.push(swim);
      }
    }
    for (const ev of preferredRelay) {
      const swim = ranked.find(s => s.event === ev);
      if (swim && !candidates.some(c => c.event === swim.event)) candidates.push(swim);
    }
    for (const swim of ranked) {
      if (isRelayEventName(swim.event) && !candidates.some(c => c.event === swim.event)) {
        candidates.push(swim);
      }
    }

    let indSlots = Math.max(0, indCap - counts.individual);
    let relaySlots = Math.max(0, relayCap - counts.relay);
    let totalSlots = Math.max(0, totalCap - (counts.individual + counts.relay));
    const classYear =
      lookupClassYearOverride(classYearOverrides, displayName, sample.name) ??
      parseClassYear(sample.classYear);

    for (const swim of candidates) {
      const relayish = isRelayEventName(swim.event);
      if (counts.events.has(swim.event)) continue;
      if (totalSlots <= 0) continue;
      if (relayish) {
        if (relaySlots <= 0) continue;
      } else if (indSlots <= 0) {
        continue;
      }

      if (isOnRoster || isExistingRecruit) {
        const existingEvents = existingPlanEvents(meetEntryPlans, displayName, team, gender);
        if (existingEvents.has(swim.event)) continue;
        const entry = createPlannedEntry({
          name: displayName,
          team,
          gender,
          classYear,
          event: swim.event,
          time: swim.time,
          timeType: swim.timeType ?? 'SCY',
          source: 'swimcloud',
          active: true,
        });
        meetEntryPlans.push(entry);
        activeEntryIds.push(entry.id);
        lineupEntriesAdded += 1;
        counts.events.add(swim.event);
        totalSlots -= 1;
        if (relayish) {
          relaySlots -= 1;
          counts.relay += 1;
        } else {
          indSlots -= 1;
          counts.individual += 1;
        }
      } else {
        // New swimmer → create recruit rows (visible on roster via buildWhatIfResults)
        const rk = recruitEventKey(displayName, team, gender, swim.event);
        if (existingRecruitEventKeys.has(rk)) continue;
        const recruit: Recruit = {
          id: uuidv4(),
          name: displayName,
          team,
          event: swim.event,
          time: swim.time,
          gender,
          classYear,
          timeType: swim.timeType ?? 'SCY',
        };
        recruits.push(recruit);
        existingRecruitEventKeys.add(rk);
        newRecruits += 1;
        counts.events.add(swim.event);
        totalSlots -= 1;
        if (relayish) {
          relaySlots -= 1;
          counts.relay += 1;
        } else {
          indSlots -= 1;
          counts.individual += 1;
        }

        if (usesScorerRoster(settings)) {
          const key = scorerRosterKey(recruit.team, recruit.gender, recruit.name);
          const rest = overrides.filter(
            o => scorerRosterKey(o.team, o.gender, o.name) !== key
          );
          overrides = [
            ...rest,
            {
              name: recruit.name,
              team: recruit.team,
              gender: recruit.gender,
              isScorer: true,
            },
          ];
        }
      }
    }
  }

  const patch: Partial<Workspace> = {
    athleteHistory,
    historySources,
    recruits,
    meetEntryPlans,
    activeEntryIds,
  };
  if (usesScorerRoster(settings)) {
    patch.scorerRosterOverrides = overrides;
  }

  return {
    noop: false,
    patch,
    summary: {
      swimsMerged: preview.length,
      newRecruits,
      lineupEntriesAdded,
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
