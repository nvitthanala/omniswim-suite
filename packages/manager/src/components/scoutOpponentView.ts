/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helpers for the "Scout a team" panel (F4). No React, no fetch.
 *
 * Every number comes from `scoutOpponent`. This file chooses words, orders the lists
 * and picks the scoring rules the coach asked for. It adds no scoring and no time.
 */

import { Gender } from '@omniswim/core/types';
import type { PlannedSwimEntry, ScoringSettings, Workspace } from '@omniswim/core/types';
import {
  RELAYS_NOT_SCOUTED_NOTE,
  ScoutError,
  isSameSchool,
  type ScoutEvent,
  type ScoutLeftOut,
  type ScoutNotScouted,
  type ScoutReport,
  type ScoutSide,
} from '../lib/opponentScouting';
import { OpponentLoadError } from '../lib/opponentScoutingLoad';
import {
  buildScoringChoices,
  describeTheoreticalError,
  resolveScoringChoice,
  type ScoringChoice,
  type TheoreticalProblem,
} from './theoreticalMeet/theoreticalMeetView';

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

/** Shown where a side has no time. Never "0.00". */
export const NO_TIME_TEXT = 'no time';

export const SCOUT_INTRO =
  'Compare your lineup with another team’s best times. Pick a team you have crawled, then see the events you lead, the events you trail, and the events one swim could change.';

/** Shown where the opponent has a measured time but the entry limit left the event out of their lineup. */
export const NO_ENTRY_TEXT = 'no entry';

export const TOTALS_SCOPE_NOTE = 'Relays and diving are not included.';

export const SCOUT_TERMS: ReadonlyArray<{ term: string; meaning: string }> = [
  { term: 'Lead', meaning: 'Your fastest swimmer in the event is faster than their fastest swimmer.' },
  { term: 'Margin', meaning: 'The gap between the two fastest swimmers, in seconds.' },
  {
    term: 'Swing event',
    meaning:
      'Two swimmers from different teams finish next to each other, and if they traded times, the other team would lead the event in points. Events are ranked by how close that pair is. A swing event does not mean the meet result would flip.',
  },
];

export const SCOUT_OUR_SIDE_NOTE =
  'Your side uses the times in your lineup: meet results, seeds and planned entries. Their side uses each swimmer’s best time ever recorded in short course yards, from the crawled SwimCloud pages.';

export const NO_CAPTURES_TEXT =
  'No team has been crawled yet. Crawl a team with the SwimCloud companion extension, then come back here. Without a crawl the app has no times for that team.';

export const NO_READY_CAPTURE_TEXT =
  'This team has no finished crawl. Wait for the crawl to finish, or crawl the team again.';

export const SCORING_CHOICE_REQUIRED_TEXT =
  'Choose the scoring rules to use. This workspace scores from a meet PDF, which cannot score a comparison.';

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

/** "0.25 s". */
export function formatMargin(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

/** "+3", "-1.5", "0". A tenth is shown only when the value has one. */
export function formatPointChange(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return value > 0 ? `+${text}` : `-${text}`;
}

/** Points as a plain number. A tied place can split points, so a tenth is kept when present. */
export function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Name 48.50" for a best entry. */
export function bestLabel(entry: { swimmer: string; time: string }): string {
  return `${entry.swimmer} ${entry.time}`;
}

/** Who leads, in words. */
export function leaderText(event: ScoutEvent, ourTeam: string, opponentTeam: string): string {
  if (event.leader === 'tie') return 'Tied';
  return `${event.leader === 'ours' ? ourTeam : opponentTeam} leads by ${formatMargin(event.marginSec)}`;
}

/** What a swap of the two fastest swimmers would do, in words. */
export function swapText(event: ScoutEvent): string {
  const { ourChange, theirChange } = event.swap;
  if (event.leader === 'tie') return 'Tied times. Nothing to swap.';
  if (ourChange === 0 && theirChange === 0) return 'A swap moves no team points.';
  return `If your fastest and their fastest traded times: you ${formatPointChange(ourChange)} points, they ${formatPointChange(theirChange)} points.`;
}

/** One summary sentence for the whole report. */
export function summaryText(report: ScoutReport): string {
  if (report.events.length === 0) {
    return `No event has a time on both sides, so nothing can be compared. ${plural(report.noTime.length, 'event')} ${report.noTime.length === 1 ? 'has' : 'have'} a time on one side only.`;
  }
  const parts = [
    `You lead in ${plural(report.wins.length, 'event')}.`,
    `${report.opponentTeam} leads in ${plural(report.losses.length, 'event')}.`,
  ];
  if (report.ties.length > 0) parts.push(`${plural(report.ties.length, 'event')} ${report.ties.length === 1 ? 'is' : 'are'} tied.`);
  if (report.noTime.length > 0) {
    parts.push(`${plural(report.noTime.length, 'event')} ${report.noTime.length === 1 ? 'has' : 'have'} a time on one side only and ${report.noTime.length === 1 ? 'is' : 'are'} not counted.`);
  }
  return parts.join(' ');
}

/** The reason a swim was left out of the comparison, in words. */
export function leftOutText(item: ScoutLeftOut): string {
  const reasons: Record<ScoutLeftOut['reason'], string> = {
    exhibition: 'an exhibition swim, which does not score',
    time_trial: 'a time trial, which does not score',
    converted_estimate: 'a time converted from another course, which is an estimate',
    not_scy: 'not recorded in short course yards',
    no_valid_time: 'not a finished time (NT, DQ or blank)',
    caller_excluded: 'a time typed by hand, not a recorded swim',
    unknown_source: 'a time with no recorded origin, which may be typed by hand',
  };
  const side = item.side === 'ours' ? 'Your side' : 'Their side';
  return `${side}: ${item.swimmer}, ${item.event}, ${item.time} – ${reasons[item.reason]}.`;
}

/** One line for each thing that was not compared. */
export function notScoutedText(item: ScoutNotScouted): string {
  if (item.reason === 'relay') return RELAYS_NOT_SCOUTED_NOTE;
  const where = item.side === null ? '' : item.side === 'ours' ? 'Your side: ' : 'Their side: ';
  const label = item.event === null ? '' : `${item.event}. `;
  return `${where}${label}${item.note}`;
}

/** The side that has no entry, in words. "No time" means no measured time. "No entry" means a time exists and the entry limit left the event out. */
export function missingSideText(
  side: ScoutSide,
  ourTeam: string,
  opponentTeam: string,
  reason: 'no_time' | 'entry_cap' = 'no_time'
): string {
  const team = side === 'ours' ? ourTeam : opponentTeam;
  return `${team}: ${reason === 'entry_cap' ? NO_ENTRY_TEXT : NO_TIME_TEXT}`;
}

/** One line for an event with a side missing. */
export function noTimeLine(
  item: {
    event: string;
    missing: ScoutSide;
    reason: 'no_time' | 'entry_cap';
    cappedBest?: { swimmer: string; time: string };
    present: { swimmer: string; time: string };
  },
  ourTeam: string,
  opponentTeam: string
): string {
  const head = `${item.event}. ${missingSideText(item.missing, ourTeam, opponentTeam, item.reason)}.`;
  const why =
    item.reason === 'entry_cap' && item.cappedBest !== undefined
      ? ` Their fastest recorded time is ${bestLabel(item.cappedBest)}, but the entry limit left this event out of their lineup.`
      : '';
  return `${head}${why} Other side: ${bestLabel(item.present)}.`;
}

/** The closest pair whose trade changes which team leads the event's points, in words. */
export function swingText(event: ScoutEvent, ourTeam: string, opponentTeam: string): string {
  const s = event.swing;
  if (s === null) return 'No single trade of neighbours changes which team leads this event.';
  return (
    `Closest pair: ${ourTeam} ${s.ourSwimmer} (${s.ourTime}, place ${s.ourPlace}) and ${opponentTeam} ${s.theirSwimmer} ` +
    `(${s.theirTime}, place ${s.theirPlace}) are ${formatMargin(s.gapSec)} apart (${s.gapPercent.toFixed(2)} percent of the slower time). ` +
    `Event points now: ${ourTeam} ${formatPoints(s.ourPointsNow)}, ${opponentTeam} ${formatPoints(s.theirPointsNow)}. ` +
    `If they traded times: ${ourTeam} ${formatPoints(s.ourPointsIfTraded)}, ${opponentTeam} ${formatPoints(s.theirPointsIfTraded)}.`
  );
}

/* -------------------------------------------------------------------------- */
/* Our side: which rows are typed by hand                                      */
/* -------------------------------------------------------------------------- */

/**
 * Row ids of our lineup whose time was typed by hand, in a planned entry or a recruit row. A hand-typed time may be a
 * target, not a swim, so scouting leaves it out and lists it. A plan that replaces a meet row holds its
 * time under the meet row's id, so both ids are returned. Only active plans count (a plan the coach
 * switched off does not change the row).
 */
export function handTypedRowIds(
  workspace: Pick<Workspace, 'meetEntryPlans' | 'activeEntryIds'> & Partial<Pick<Workspace, 'recruits'>>,
  gender: Gender,
  team: string
): Set<string> {
  const ids = new Set<string>();
  const active = workspace.activeEntryIds;
  for (const plan of workspace.meetEntryPlans ?? ([] as PlannedSwimEntry[])) {
    if (plan.source !== 'manual' || plan.gender !== gender || plan.team !== team) continue;
    if (plan.active === false) continue;
    if (active !== undefined && active.length > 0 && !active.includes(plan.id)) continue;
    ids.add(plan.id);
    if (plan.replacesResultId !== undefined) ids.add(plan.replacesResultId);
  }
  // A recruit row keeps its own id in the projection.
  for (const recruit of workspace.recruits ?? []) {
    if (recruit.source === 'manual' && recruit.gender === gender && recruit.team === team) ids.add(recruit.id);
  }
  return ids;
}

/**
 * Row ids of recruit rows with NO recorded `source`. Absent means unknown, never measured and never typed:
 * the row may be a SwimCloud best or a coach's own number, and nothing in the row says which. Scouting
 * leaves these out and lists them (`unknown_source`) rather than guess. A row with a measured source
 * (`swimcloud`, `paste`, `pdf`, `csv`, `ocr`) is kept.
 */
export function unknownSourceRowIds(workspace: Partial<Pick<Workspace, 'recruits'>>, gender: Gender, team: string): Set<string> {
  const ids = new Set<string>();
  for (const recruit of workspace.recruits ?? []) {
    if (recruit.source === undefined && recruit.gender === gender && recruit.team === team) ids.add(recruit.id);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* The team picker                                                             */
/* -------------------------------------------------------------------------- */

interface PickerGroup {
  readonly teamId: string;
  readonly title: string;
  readonly named: boolean;
  readonly divisionTag: { readonly text: string };
}

/**
 * The picker text for a crawled team. A capture that carries no school name reads "Team 58 (school name
 * not recorded)", so the coach knows the name could not be checked against their own team.
 */
export function pickerLabel(group: PickerGroup): string {
  return group.named ? `${group.title} (${group.divisionTag.text})` : `${group.title} (school name not recorded)`;
}

/**
 * True when a crawled team is the coach's own school, by the school name the capture carries. A capture
 * with no school name cannot be told apart here (the workspace holds no SwimCloud team id); the comparison
 * refuses it after the load, by the name on the roster page.
 */
export function isOwnTeamGroup(group: Pick<PickerGroup, 'title' | 'named'>, ourTeam: string): boolean {
  return group.named && isSameSchool(group.title, ourTeam);
}

/* -------------------------------------------------------------------------- */
/* Scoring rules                                                               */
/* -------------------------------------------------------------------------- */

/** The id of the "this workspace's own rules" option. A preset id is never this. */
export const WORKSPACE_RULES_ID = 'workspace';

export interface ScoutScoringOption {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  /** Set when the option cannot be chosen. The reason is shown. */
  readonly disabledReason: string | null;
}

/**
 * The scoring rules the coach may pick. The first is this workspace's own rules, unless the workspace
 * scores from a meet PDF; then it is listed as unavailable and no default is chosen.
 */
export function scoutScoringOptions(workspaceSettings: ScoringSettings | undefined): ScoutScoringOption[] {
  const pdf = workspaceSettings === undefined || workspaceSettings.usePdfPlacePoints === true;
  const own: ScoutScoringOption = {
    id: WORKSPACE_RULES_ID,
    label: 'This workspace’s scoring rules',
    group: 'Workspace',
    disabledReason: pdf ? SCORING_CHOICE_REQUIRED_TEXT : null,
  };
  const presets = buildScoringChoices().map(
    (c: ScoringChoice): ScoutScoringOption => ({ id: c.id, label: c.label, group: c.group, disabledReason: null })
  );
  return [own, ...presets];
}

/** The default selection: the workspace's own rules when usable, else none (the coach must choose). */
export function defaultScoringId(workspaceSettings: ScoringSettings | undefined): string {
  return scoutScoringOptions(workspaceSettings)[0]?.disabledReason === null ? WORKSPACE_RULES_ID : '';
}

/**
 * The settings and conference for a choice. The workspace's own rules keep the workspace conference. A
 * preset passes only the conference that preset names, so a workspace conference cannot override it.
 * Returns `null` for no choice or an unusable one.
 */
export function resolveScoutScoring(
  id: string,
  workspace: { scoringSettings: ScoringSettings | undefined; conference: string | undefined }
): { settings: ScoringSettings; conference: string | undefined } | null {
  if (id === '') return null;
  if (id === WORKSPACE_RULES_ID) {
    const own = workspace.scoringSettings;
    if (own === undefined || own.usePdfPlacePoints === true) return null;
    return { settings: own, conference: workspace.conference };
  }
  return resolveScoringChoice(id);
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

const SCOUT_SENTENCES: Readonly<Record<string, string>> = {
  'pdf-points-settings': SCORING_CHOICE_REQUIRED_TEXT,
  'same-team': 'That is your own team. Pick a different team to scout.',
  'invalid-input': 'The comparison could not start. Check the team and the gender.',
  'gender-mismatch': 'A swim is for the other gender. Reload the lineup and try again.',
  'no-place-table': 'These scoring rules have no place table, so nothing can score.',
  'one-capture-required': 'Pick one crawl of one team.',
  'no-team-for-gender': 'This crawl has no roster for this gender. Crawl the team again with that roster.',
};

/** One plain sentence plus the builder's own text, for any error the scout can meet. */
export function describeScoutError(error: unknown): TheoreticalProblem {
  if (error instanceof ScoutError || error instanceof OpponentLoadError) {
    return {
      code: error.code,
      message: SCOUT_SENTENCES[error.code] ?? 'The comparison could not be made.',
      detail: error.message,
      retryable: false,
    };
  }
  return describeTheoreticalError(error);
}
