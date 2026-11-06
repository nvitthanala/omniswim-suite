/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The session-load state the page panel shows (D5 amendment 7, D7 live-model spec section 2). It reads the live model, so a swimmer a chosen roster
 * season removed is not counted in a session. It stays pure so a test can call it. The words are the dashboard's own.
 */
import { relayRepeatsForSchedule, requireComplete, scoreMeet, sessionLoad } from '@omniswim/engine';
import type { LoadPreference, RulePreset, ScorerTag, SessionPreset } from '@omniswim/engine';
import type { ScorerTagStateMessage } from '../shared/panelProtocol';
import { partitionTags } from './liveModel';
import type { LiveModel } from './liveModel';

/**
 * `live` is `null` while SwimCloud has not loaded the simulator results.
 * `tags` are the coach's tags plus the suggested opponent tags, as the scorer-tag scoring gets them. A rule preset with a scoring roster (NSISC)
 * cannot score a meet without them. A tag on a `not_member` swimmer is set aside first, as everywhere else.
 */
export function buildPlannerState(live: LiveModel | null, rules: RulePreset | undefined, schedule: SessionPreset | undefined, preference: LoadPreference, tags: readonly ScorerTag[]): ScorerTagStateMessage['planner'] {
  if (!rules) return { perSwimmer: [], violations: ['Choose the meet\'s OmniSwim rule preset before calculating session load.'] };
  if (live === null) return { perSwimmer: [], violations: ['Session load is pending because simulator results are not ready.'] };
  try {
    const completeRules = requireComplete(rules);
    // Tags mean something only under roster eligibility. Under 'points_pool' scoreMeet refuses any tag (tags_need_roster_mode), and the
    // planner scored with none before the live model, so it still does: a stored tag must not turn a working Plan tab into "pending".
    const eligibility = completeRules.scorers.eligibility;
    const rosterMode = eligibility.state === 'set' && eligibility.value === 'roster';
    const results = scoreMeet(live.model, live.lineup, rosterMode ? partitionTags(live, tags).kept : [], completeRules, live.sourcing);
    const repeated = results.violations.filter(v => v.kind === 'relay_swimmer_repeated');
    const visibleRepeats = schedule ? relayRepeatsForSchedule(repeated, schedule) : repeated;
    const repeatWarnings = visibleRepeats.map(v => `Relay rule violation: ${v.swimmerId} appears on multiple relays for ${v.eventKey} (${v.gender}).`);
    const note = schedule ? [] : ['No schedule chosen; relay event formats are unknown, so relay repeat violations are unfiltered.'];
    if (!schedule) return { perSwimmer: [], violations: [...repeatWarnings, ...note] };
    const load = sessionLoad(live.model, live.lineup, results, schedule, preference, completeRules, live.sourcing);
    const loadWarnings = load.violations.map(v => v.kind === 'session_load' ? `Session load: swimmer ${String(v.swimmerId)} has ${v.races} races on day ${v.session.day} (${v.session.slot}); limit ${v.limit}.` : v.kind === 'pending_setting' ? `Pending setting: ${v.setting} for ${v.eventKey}.` : v.kind === 'unscheduled_event' ? `Unscheduled event: ${v.eventKey}.` : `Session load issue: ${v.kind}.`);
    return { perSwimmer: load.perSwimmer.map(s => ({ swimmerId: String(s.swimmerId), sessions: s.sessions })), violations: [...repeatWarnings, ...loadWarnings] };
  } catch (cause) {
    return { perSwimmer: [], violations: [`Session load is pending: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
}

/** What the page panel gets when the live model could not be built (a roster of the wrong gender, say): the real tags and a roster-specific error. */
export function rosterErrorState(base: Omit<ScorerTagStateMessage, 'kind' | 'warnings' | 'error' | 'planner'>, reason: string): ScorerTagStateMessage {
  return {
    kind: 'scorer-tag-state',
    ...base,
    warnings: [],
    planner: { perSwimmer: [], violations: ['Session load is pending because the roster season could not be applied.'] },
    error: `The roster season could not be applied: ${reason}`,
  };
}
