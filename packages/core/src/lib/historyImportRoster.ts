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
import { mergeHistoryIndex, matchAthleteToRoster, categorizeBestEvents } from './athleteHistory';
import { mergeScoringSettings } from './scoringDefaults';
import { usesScorerRoster, scorerRosterKey } from './scorerRoster';
import { convertTimeToSeconds, convertToSCY, normalizeSwimmerName } from './utils';
import { createPlannedEntry } from './whatIfProjection';

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
};

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

function rosterNamesForTeam(workspace: Workspace, team: string, gender: Gender): string[] {
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

function groupPreviewBySwimmer(preview: HistoricalSwim[]): Map<string, HistoricalSwim[]> {
  const map = new Map<string, HistoricalSwim[]>();
  for (const s of preview) {
    const key = `${normalizeSwimmerName(s.name)}|${s.team}|${s.gender}`;
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return map;
}

function bestSwimsByEvent(swims: HistoricalSwim[]): HistoricalSwim[] {
  const best = new Map<string, HistoricalSwim>();
  for (const s of swims) {
    const prev = best.get(s.event);
    if (!prev) {
      best.set(s.event, s);
      continue;
    }
    const sec = convertTimeToSeconds(convertToSCY(s.time, s.event, s.gender, s.timeType ?? 'SCY'));
    const prevSec = convertTimeToSeconds(
      convertToSCY(prev.time, prev.event, prev.gender, prev.timeType ?? 'SCY')
    );
    if (sec < prevSec) best.set(s.event, s);
  }
  return [...best.values()].sort((a, b) => {
    const sa = convertTimeToSeconds(convertToSCY(a.time, a.event, a.gender, a.timeType ?? 'SCY'));
    const sb = convertTimeToSeconds(convertToSCY(b.time, b.event, b.gender, b.timeType ?? 'SCY'));
    return sa - sb;
  });
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
  opts: Pick<HistoryImportRosterOpts, 'team' | 'gender'>
): ImportSwimmerPreview[] {
  if (!preview.length || !opts.team.trim()) return [];
  const rosterNames = rosterNamesForTeam(workspace, opts.team, opts.gender);
  const recruitKeys = new Set(
    (workspace.recruits ?? [])
      .filter(r => r.gender === opts.gender && r.team === opts.team)
      .map(r => normalizeSwimmerName(r.name))
  );
  const groups = groupPreviewBySwimmer(preview);
  const out: ImportSwimmerPreview[] = [];

  for (const [, swims] of groups) {
    const sample = swims[0];
    if (sample.team !== opts.team || sample.gender !== opts.gender) continue;
    const match = matchAthleteToRoster(sample.name, rosterNames);
    const isRecruitAlready = recruitKeys.has(normalizeSwimmerName(sample.name));
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
      const hasNew = bestSwimsByEvent(swims).some(s => !existingEvents.has(s.event));
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
  const settings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const indCap = settings.maxIndividualEntriesPerSwimmer ?? 3;
  const relayCap = settings.maxRelayEntriesPerSwimmer ?? 4;

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
  const results =
    gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];

  const existingRecruitEventKeys = new Set(
    recruits
      .filter(r => r.gender === gender && r.team === team)
      .map(r => recruitEventKey(r.name, r.team, r.gender, r.event))
  );

  let newRecruits = 0;
  let lineupEntriesAdded = 0;
  const swimmerPreviews = previewHistoryImportActions(workspace, preview, { team, gender });

  const groups = groupPreviewBySwimmer(preview);
  for (const [, swims] of groups) {
    const sample = swims[0];
    if (sample.team !== team || sample.gender !== gender) continue;

    const match = matchAthleteToRoster(sample.name, rosterNames);
    const matchedName = match.match && match.confidence >= 0.7 ? match.match : null;
    const displayName = matchedName ?? sample.name;
    const isOnRoster = Boolean(matchedName);
    const isExistingRecruit = recruits.some(
      r =>
        r.gender === gender &&
        r.team === team &&
        normalizeSwimmerName(r.name) === normalizeSwimmerName(displayName)
    );

    const ranked = bestSwimsByEvent(swims);
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
    const classYear = parseClassYear(sample.classYear);

    for (const swim of candidates) {
      const relayish = isRelayEventName(swim.event);
      if (counts.events.has(swim.event)) continue;
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
