/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Request refusals that read only the rules and the request (D5 2.1 items 3 to 7), and the rule values the search needs.
 */
import { pointTables, settled } from '../model/results';
import type { Cap } from '../rules/cap';
import type { CompleteRulePreset, DiverWeight, TieRule } from '../rules/rulePreset';
import type { MeetEvent, MeetModel } from '../model/meet';
import type { ScorerTag } from '../model/lineup';
import type { LoadPreference, SessionPreset } from '../planner/types';
import type { TeamId } from '../model/primitives';
import { autoBuildFail } from './types';
import type { AutoBuildLimits, AutoBuildObjective, AutoBuildRequest } from './types';

/** The per-event scorer cap that applies to one event, or `null` for unlimited. */
export interface EventCap {
  readonly cap: number;
  readonly overCap: 'holds-place' | 'removed-from-consideration';
}

/** The session-load rows of a request whose preference is not 'off' (D5 4.5, slice A3). */
export interface LoadRule {
  readonly schedule: SessionPreset;
  readonly preference: Exclude<LoadPreference, { readonly mode: 'off' }>;
  /** Races one swimmer may swim in one session. */
  readonly max: number;
  /** `prefer` mode: an extra race costs `penalty` points. `respect` mode: it is a hard row. */
  readonly prefer: boolean;
  /** Points per extra race (0 in `respect` mode). */
  readonly penalty: number;
  /** The power of ten (at most 10^4) that makes `penalty` whole: the integer scale must hold it. */
  readonly penaltyScale: number;
}

export interface Support {
  readonly ties: TieRule;
  readonly size: Cap;
  readonly weight: DiverWeight;
  readonly entryCaps: { readonly individual: Cap; readonly relay: Cap; readonly total: Cap };
  readonly exhibitionCounts: boolean;
  /** R: the own relays one event scores (`scorers.scoringRelaysPerTeamPerEvent`). */
  readonly relayCap: number;
  /** `entries.nonScoringRelaysAllowed`: `false` makes more than R own relays in one event a hard violation (README R42). An absent rule is `true`. */
  readonly nonScoringRelaysAllowed: boolean;
  readonly tables: { readonly individual: readonly number[]; readonly diving: readonly number[]; readonly relay: readonly number[] };
  /** The power of ten that makes every table value a whole number (rosterSuggest.ts:163). */
  readonly decScale: number;
  readonly rules: CompleteRulePreset;
  /** The session-load rows, or `null` when the request has no load or its mode is 'off'. Set by `loadRuleOf`, after the refusals. */
  readonly load: LoadRule | null;
}

const WHOLE = 1e-9;

/** The decimal scale of the three tables, refusing a table the bound proof cannot use. */
function checkTables(rules: CompleteRulePreset): { tables: Support['tables']; decScale: number } {
  const unsupported = (path: string, why: string): never => autoBuildFail('rule_unsupported', `${path}: ${why}`, path);
  const raw = pointTables(rules);
  const named: readonly (readonly [string, readonly number[]])[] = [
    ['scoring.individualPoints', raw.individual],
    ['scoring.divingPoints', raw.diving],
    ['scoring.relayPoints', raw.relay],
  ];
  let decScale = 1;
  for (const [path, table] of named) {
    table.forEach((v, i) => {
      if (!Number.isFinite(v) || v < 0) unsupported(path, `place ${i + 1} holds ${v}; a negative point value is not supported`);
      if (i > 0 && v > (table[i - 1] as number)) unsupported(path, `place ${i + 1} scores more than place ${i}; a table that rises with place is not supported`);
    });
    const whole = (scale: number): boolean => table.every((v) => Math.abs(v * scale - Math.round(v * scale)) < WHOLE);
    while (decScale < 10000 && !whole(decScale)) decScale *= 10;
    if (!whole(decScale)) unsupported(path, 'a point value has more than 4 decimals; the integer model cannot hold it exactly');
  }
  return { tables: raw, decScale };
}

/** D5 2.1 item 4. */
export function checkRules(rules: CompleteRulePreset): Support {
  const unsupported = (path: string, why: string): never => autoBuildFail('rule_unsupported', `${path}: ${why}`, path);
  if (settled(rules.scorers.eligibility, 'scorers.eligibility') !== 'roster') {
    unsupported('scorers.eligibility', 'only "roster" is supported: a points pool couples events');
  }
  const size = settled(rules.scorers.scoringTeamSize, 'scorers.scoringTeamSize');
  if (size !== 'unlimited' && settled(rules.scorers.scoringTeamScope, 'scorers.scoringTeamScope') === 'event') {
    unsupported('scorers.scoringTeamScope', 'a numeric team size per event is not supported');
  }
  if (settled(rules.scoring.nonScorerPlacement, 'scoring.nonScorerPlacement') === 'holds-place') {
    unsupported('scoring.nonScorerPlacement', '"holds-place" is not supported: a held non-scorer place would depend on the roster');
  }
  if (!settled(rules.scorers.relayLegsMustBeScorers, 'scorers.relayLegsMustBeScorers')) {
    unsupported('scorers.relayLegsMustBeScorers', 'a relay with a leg off the roster is not supported yet');
  }
  if (settled(rules.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent') === 'unlimited') {
    unsupported('scorers.scoringRelaysPerTeamPerEvent', '"unlimited" is not supported');
  }
  const weight = settled(rules.scorers.diverWeight, 'scorers.diverWeight');
  if (!Number.isInteger(weight.numerator) || !Number.isInteger(weight.denominator) || weight.numerator < 1 || weight.numerator > weight.denominator) {
    unsupported('scorers.diverWeight', 'the weight must be a fraction of at most one spot');
  }
  const { tables, decScale } = checkTables(rules);
  return {
    ties: settled(rules.scoring.ties, 'scoring.ties'),
    size,
    weight,
    entryCaps: {
      individual: settled(rules.entries.maxIndividualPerSwimmer, 'entries.maxIndividualPerSwimmer'),
      relay: settled(rules.entries.maxRelayPerSwimmer, 'entries.maxRelayPerSwimmer'),
      total: settled(rules.entries.maxTotalPerSwimmer, 'entries.maxTotalPerSwimmer'),
    },
    exhibitionCounts: settled(rules.entries.exhibitionCounts, 'entries.exhibitionCounts'),
    relayCap: settled(rules.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent') as number,
    nonScoringRelaysAllowed: rules.entries.nonScoringRelaysAllowed === undefined ? true : settled(rules.entries.nonScoringRelaysAllowed, 'entries.nonScoringRelaysAllowed'),
    tables,
    decScale,
    rules,
    load: null,
  };
}

/** The per-event scorer cap of an event (diving uses its own rule when it has one), or `null` for unlimited. */
export function eventCap(rules: CompleteRulePreset, event: MeetEvent): EventCap | null {
  const swimming = settled(rules.scorers.perEventScorerCap, 'scorers.perEventScorerCap');
  const diving = settled(rules.scorers.divingPerEventScorerCap, 'scorers.divingPerEventScorerCap');
  const rule = event.kind === 'diving' && diving.kind === 'own' ? diving : swimming;
  if (rule.cap === 'unlimited') return null;
  return { cap: rule.cap, overCap: rule.overCap };
}

/** D5 2.1 item 3. */
export function checkOwnTags(tags: readonly ScorerTag[], ownTeamId: TeamId): void {
  for (const tag of tags) {
    if (tag.teamId === ownTeamId && tag.source !== undefined) {
      autoBuildFail('own_tag_not_coach', `the tag for swimmer "${tag.swimmerId}" on the own team is marked "${tag.source}"; pass only coach tags for the own team`, tag.swimmerId);
    }
  }
}

/** D5 2.1 item 2, after the preflight. */
export function checkTeams(model: MeetModel, ownTeamId: TeamId): void {
  if (model.teams.length === 0) autoBuildFail('draft_meet', 'the meet model has no team (a draft meet)');
  if (!model.teams.some((t) => t.teamId === ownTeamId)) autoBuildFail('own_team_unknown', `team "${ownTeamId}" is not in the meet model`, ownTeamId);
}

const inRange = (n: number, lo: number, hi: number): boolean => Number.isInteger(n) && n >= lo && n <= hi;

/** D5 2.1 item 7 (`limits_invalid`, `rival_invalid`, `target_invalid`). */
export function checkLimits(limits: AutoBuildLimits): void {
  const bad = (field: string, why: string): never => autoBuildFail('limits_invalid', `limits.${field}: ${why}`, field);
  if (!inRange(limits.candidatesPerEvent, 1, 12)) bad('candidatesPerEvent', 'an integer from 1 to 12');
  if (!inRange(limits.maxCandidatesPerEvent, limits.candidatesPerEvent, 12)) bad('maxCandidatesPerEvent', 'an integer from candidatesPerEvent to 12');
  if (!inRange(limits.relaySquadsPerEvent, 1, 24)) bad('relaySquadsPerEvent', 'an integer from 1 to 24');
  if (!inRange(limits.maxRelaySquadsPerEvent, limits.relaySquadsPerEvent, 48)) bad('maxRelaySquadsPerEvent', 'an integer from relaySquadsPerEvent to 48');
  if (!inRange(limits.refineRounds, 0, 3)) bad('refineRounds', 'an integer from 0 to 3');
  if (!(Number.isFinite(limits.timeLimitSeconds) && limits.timeLimitSeconds > 0 && limits.timeLimitSeconds <= 120)) {
    bad('timeLimitSeconds', 'a number above 0 and at most 120');
  }
}

export function checkObjective(model: MeetModel, ownTeamId: TeamId, objective: AutoBuildObjective): void {
  const rival = objective.kind === 'margin' ? objective.rival : objective.kind === 'goal-seek' && objective.target.kind === 'margin' ? objective.target.rival : null;
  if (rival !== null && rival.kind === 'team' && (rival.teamId === ownTeamId || !model.teams.some((t) => t.teamId === rival.teamId))) {
    autoBuildFail('rival_invalid', `rival "${rival.teamId}" is the own team or is not in the meet model`, rival.teamId);
  }
  if (objective.kind === 'goal-seek' && !Number.isFinite(objective.target.points)) {
    autoBuildFail('target_invalid', 'the goal-seek target is not a finite number', 'target.points');
  }
}

/** D5 2.1 item 5, the part that reads only the load preference. */
export function checkLoadSettings(load: NonNullable<AutoBuildRequest['load']>): void {
  const pref = load.preference;
  if (pref.mode === 'off') return;
  if (pref.maxRacesPerSession.state !== 'set') {
    autoBuildFail('pending_setting', 'load.preference.maxRacesPerSession is pending', 'load.preference.maxRacesPerSession');
  }
  if (pref.diving.state !== 'set') autoBuildFail('pending_setting', 'load.preference.diving is pending', 'load.preference.diving');
  if (pref.mode === 'prefer') {
    const penalty = pref.penaltyPointsPerExtraRace;
    if (penalty.state !== 'set') return autoBuildFail('pending_setting', 'load.preference.penaltyPointsPerExtraRace is pending', 'load.preference.penaltyPointsPerExtraRace');
    const pen = penalty.value;
    if (!Number.isFinite(pen) || pen < 0 || Math.abs(pen * 10000 - Math.round(pen * 10000)) > 1e-5) {
      autoBuildFail('rule_unsupported', 'a prefer penalty needs at most 4 decimals', 'load.preference.penaltyPointsPerExtraRace');
    }
  }
}

/** The load rows of a request, after `checkLoadSettings` has refused a pending setting. `null`: no load, or mode 'off'. */
export function loadRuleOf(load: AutoBuildRequest['load']): LoadRule | null {
  if (load === null || load.preference.mode === 'off') return null;
  const pref = load.preference;
  if (pref.maxRacesPerSession.state !== 'set') return autoBuildFail('pending_setting', 'load.preference.maxRacesPerSession is pending', 'load.preference.maxRacesPerSession');
  const prefer = pref.mode === 'prefer';
  let penalty = 0;
  if (pref.mode === 'prefer') {
    if (pref.penaltyPointsPerExtraRace.state !== 'set') {
      return autoBuildFail('pending_setting', 'load.preference.penaltyPointsPerExtraRace is pending', 'load.preference.penaltyPointsPerExtraRace');
    }
    penalty = pref.penaltyPointsPerExtraRace.value;
  }
  let penaltyScale = 1;
  while (penaltyScale < 10000 && Math.abs(penalty * penaltyScale - Math.round(penalty * penaltyScale)) > 1e-6) penaltyScale *= 10;
  return { schedule: load.schedule, preference: pref, max: pref.maxRacesPerSession.value, prefer, penalty, penaltyScale };
}

/** D5 2.1 item 6: a candidate event missing from the schedule. */
export function checkSchedule(load: NonNullable<AutoBuildRequest['load']>, events: readonly MeetEvent[]): void {
  for (const e of events) {
    const scheduled = load.schedule.events.some((row) => row.eventKey === e.eventKey && (row.gender === 'both' || row.gender === e.gender));
    if (!scheduled) autoBuildFail('unscheduled_event', `event "${e.eventKey}" (${e.gender}) is not in the session schedule`, `${e.eventKey}|${e.gender}`);
  }
}
