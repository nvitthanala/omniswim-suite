/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the AutoBuilder panel sends (plans/2026-10-25/D5-AUTOBUILDER.md 12.10, amendment 7 item 3): the controls, and the request
 * built from the live simulator snapshot and the coach's stored choices (own team, rule preset, scorer tags, session schedule and
 * load preference). This file builds nothing of its own: every value comes from the snapshot, the store or a control.
 *
 * It imports types from the engine and only a few plain functions. It must not import `autoBuild` or any value from the engine's
 * `autobuilder/` folder: the dashboard bundle holds none of that code (tests/extensionBundleBoundaries.test.ts, T-B7b). The two
 * default tables below repeat `AUTOBUILD_DEFAULT_LIMITS` and `AUTOBUILD_DEFAULT_ROBUST`, and a test compares them.
 */
import { requireComplete } from '@omniswim/engine';
import { swimmerLabel, teamLabel } from '../shared/names';
import type {
  AutoBuildLimits,
  AutoBuildObjective,
  CompleteRulePreset,
  Gender,
  LoadPreference,
  LpSolve,
  RivalRef,
  RulePreset,
  ScorerTag,
  SessionPreset,
  TeamId,
} from '@omniswim/engine';
import { adaptSimulatorSnapshot, SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';
import type { AutoBuildWireRequest } from '../shared/autobuilderProtocol';
import { readScorerOwnTeam, readScorerRulePreset, readSessionLoadPreference, readSessionPreset, resolveRulePreset } from '../storage';
import type { PresetRef, StorageRepo } from '../storage';
import { suggestedTags, suggestOpponentRosters } from './suggestedRosters';
import type { SuggestedRosterState } from './suggestedRosters';

import { meetKeyForSnapshot } from './meetKey';

export { meetKeyForSnapshot };

/** A snapshot's identity. Two snapshots with the same key hold the same simulator state. */
export const snapshotKey = (snapshot: SimSnapshot): string => JSON.stringify(snapshot);

/** Algorithm parameters, not competition values. A test pins them to `AUTOBUILD_DEFAULT_LIMITS`. */
export const DEFAULT_LIMITS: AutoBuildLimits = {
  candidatesPerEvent: 8,
  maxCandidatesPerEvent: 10,
  relaySquadsPerEvent: 12,
  maxRelaySquadsPerEvent: 24,
  refineRounds: 1,
  timeLimitSeconds: 10,
};
/** A test pins it to `AUTOBUILD_DEFAULT_ROBUST`. */
export const DEFAULT_ROBUST = { recentSwims: 5, minSwims: 3 } as const;
/** The engine accepts a wall time in (0, 120] seconds. */
export const TIME_LIMIT_RANGE = { min: 1, max: 120 } as const;

export type ModeChoice = 'max-own' | 'margin' | 'closest' | 'robust' | 'goal-seek';

export interface AutoBuildControls {
  readonly mode: ModeChoice;
  /** `margin`: the team to beat. */
  readonly rivalTeamId: string;
  readonly robust: { readonly recentSwims: number; readonly minSwims: number };
  readonly goal: {
    readonly kind: 'total' | 'margin';
    readonly points: number;
    /** `margin` target: a team id, or `'closest'`. */
    readonly rival: string;
  };
  /** Opt in to roster swaps (`roster: 'propose-swaps'`). */
  readonly proposeSwaps: boolean;
  readonly timeLimitSeconds: number;
}

export const defaultControls = (): AutoBuildControls => ({
  mode: 'max-own',
  rivalTeamId: '',
  robust: { ...DEFAULT_ROBUST },
  goal: { kind: 'total', points: 0, rival: 'closest' },
  proposeSwaps: false,
  timeLimitSeconds: DEFAULT_LIMITS.timeLimitSeconds,
});

const rivalRef = (id: string): RivalRef => (id === 'closest' ? { kind: 'closest' } : { kind: 'team', teamId: id as TeamId });

/** The engine objective of the controls. The engine checks the rival and the target; this only maps. */
export function objectiveOf(controls: AutoBuildControls): AutoBuildObjective {
  switch (controls.mode) {
    case 'margin':
      return { kind: 'margin', rival: rivalRef(controls.rivalTeamId) };
    case 'closest':
      return { kind: 'margin', rival: { kind: 'closest' } };
    case 'robust':
      return { kind: 'robust', recentSwims: controls.robust.recentSwims, minSwims: controls.robust.minSwims };
    case 'goal-seek':
      return {
        kind: 'goal-seek',
        target: controls.goal.kind === 'total' ? { kind: 'total', points: controls.goal.points } : { kind: 'margin', rival: rivalRef(controls.goal.rival), points: controls.goal.points },
      };
    default:
      return { kind: 'max-own' };
  }
}

/** Names for the ids a result mentions, from the lineup display the adapter built. */
export interface Names {
  swimmer(id: string): string;
  team(id: string): string;
}

/** Everything a run used besides the controls. Accept compares it with the store again. */
export interface RunInputs {
  readonly meetKey: string;
  readonly ownTeamId: string;
  readonly ruleRef: PresetRef;
  readonly rulePreset: RulePreset;
  readonly ruleRev: number | undefined;
  readonly sessionRef: PresetRef | undefined;
  readonly sessionPreset: SessionPreset | undefined;
  readonly loadPreference: LoadPreference;
  /** The coach's tags, as stored, sorted. */
  readonly coachTags: readonly ScorerTag[];
  readonly names: Names;
}

export type PreparedRequest =
  | { readonly kind: 'ready'; readonly request: AutoBuildWireRequest; readonly inputs: RunInputs; readonly suggestions: readonly SuggestedRosterState[] }
  | { readonly kind: 'missing'; readonly missing: readonly string[] };

const byTeamSwimmer = (a: ScorerTag, b: ScorerTag): number => (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : a.swimmerId < b.swimmerId ? -1 : a.swimmerId > b.swimmerId ? 1 : 0);

/** The coach's stored tags for the meet, in a fixed order. An own-team tag carries no `source`. */
export async function readCoachTags(repo: StorageRepo, meetKey: string): Promise<ScorerTag[]> {
  const rows = await repo.list('tags', { index: 'byMeet', value: meetKey });
  return rows.map((t) => ({ teamId: String(t.teamId) as TeamId, swimmerId: String(t.swimmerId) as ScorerTag['swimmerId'], role: t.role })).sort(byTeamSwimmer);
}

/** The text of a name lookup over the lineup display. A missing name says so (`shared/names.ts`), never the bare id. */
export function namesOf(display: { readonly swimmers: Readonly<Record<string, { readonly name: string }>>; readonly teams: Readonly<Record<string, { readonly name: string }>> } | undefined): Names {
  return { swimmer: (id) => swimmerLabel(id, display?.swimmers[id]?.name), team: (id) => teamLabel(id, display?.teams[id]?.name) };
}

/**
 * Read the store and the snapshot and build one request. A choice the coach has not made, or a result the engine cannot score yet,
 * comes back as `missing` with plain-language reasons. Nothing is guessed.
 */
export async function prepareRequest(args: { snapshot: SimSnapshot; repo: StorageRepo; solveLp: LpSolve; controls: AutoBuildControls }): Promise<PreparedRequest> {
  const { snapshot, repo, solveLp, controls } = args;
  const meetKey = meetKeyForSnapshot(snapshot);
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey, snapshotId: 'live-snapshot' });
  if (adapted.kind !== 'ready') return { kind: 'missing', missing: ['SwimCloud has not loaded the simulator results yet.'] };
  const { model, lineup } = adapted.adapted;
  const missing: string[] = [];
  const ownTeamId = await readScorerOwnTeam(repo, meetKey);
  if (ownTeamId === undefined || !model.teams.some((t) => String(t.teamId) === String(ownTeamId))) missing.push('Choose your team in the page panel.');
  const ruleRef = await readScorerRulePreset(repo, meetKey);
  const resolved = ruleRef === undefined ? undefined : await resolveRulePreset(repo, ruleRef);
  if (ruleRef === undefined || resolved === undefined || !resolved.found) missing.push('Choose your OmniSwim scoring rules in the page panel.');
  if (ownTeamId === undefined || ruleRef === undefined || resolved === undefined || !resolved.found || missing.length > 0) return { kind: 'missing', missing };
  let rules: CompleteRulePreset;
  try {
    rules = requireComplete(resolved.value);
  } catch (cause) {
    return { kind: 'missing', missing: [`The chosen rules are not complete: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
  const coachTags = await readCoachTags(repo, meetKey);
  const suggestions = await suggestOpponentRosters(snapshot, meetKey, String(ownTeamId), coachTags, resolved.value, solveLp);
  const selected = await readSessionPreset(repo, meetKey);
  const loadPreference = await readSessionLoadPreference(repo, meetKey);
  const ownGenders = new Set(model.swimmers.filter((s) => String(s.teamId) === String(ownTeamId)).map((s) => s.gender));
  const genders = (['Men', 'Women'] as const satisfies readonly Gender[]).filter((g) => ownGenders.has(g));
  const request: AutoBuildWireRequest = {
    model,
    lineup,
    rules,
    sourcing: SIMULATOR_SOURCING,
    tags: [...coachTags, ...suggestedTags(suggestions)],
    ownTeamId: String(ownTeamId) as TeamId,
    genders,
    objective: objectiveOf(controls),
    load: selected.preset === undefined ? null : { schedule: selected.preset, preference: loadPreference },
    limits: { ...DEFAULT_LIMITS, timeLimitSeconds: controls.timeLimitSeconds },
    roster: controls.proposeSwaps ? 'propose-swaps' : 'fixed',
  };
  const inputs: RunInputs = {
    meetKey,
    ownTeamId: String(ownTeamId),
    ruleRef,
    rulePreset: resolved.value,
    ruleRev: resolved.rev,
    sessionRef: selected.ref,
    sessionPreset: selected.preset,
    loadPreference,
    coachTags,
    names: namesOf(lineup.display),
  };
  return { kind: 'ready', request, inputs, suggestions };
}
