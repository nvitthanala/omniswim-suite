/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * AutoBuilder public types (plans/2026-10-25/D5-AUTOBUILDER.md, section 2). `max-own`, `margin` and `goal-seek` are built (slices
 * A1, A6 and A7). A goal seek under the `prefer` load mode throws `mode_not_built`.
 */
import type { CompleteRulePreset } from '../rules/rulePreset';
import type { ConversionSettings } from '../sourcing/convert';
import type { LoadPreference, SessionPreset } from '../planner/types';
import type { sessionLoad } from '../planner/sessionLoad';
import type { EventKey, Gender, Hundredths, SwimmerId, TeamId } from '../model/primitives';
import type { Lineup, ScorerTag } from '../model/lineup';
import type { MeetModel } from '../model/meet';
import type { Results, Violation } from '../model/results';

/** HiGHS MIP result. `columns` holds values only when status is 'Optimal' (optimizerResult.ts:2-3 rule). */
export interface MipSolution {
  readonly status: string;
  readonly objective: number;
  readonly columns: Readonly<Record<string, number>>;
  /** Only when status is 'Time limit reached' and HiGHS reports primal_solution_status 2. Never an optimum. */
  readonly incumbent: { readonly objective: number; readonly columns: Readonly<Record<string, number>> } | null;
  /** HiGHS info 'mip_dual_bound' after the run; null when not reported. */
  readonly dualBound: number | null;
  /**
   * D5 amendment 1 (6.5 f), additive, optional: the solver's own run time in seconds. Diagnostic: the budget uses
   * `AutoBuildRequest.clock`. It is the fallback only when the request holds no clock.
   */
  readonly seconds?: number;
}
export type MipSolve = (lp: string, options: Readonly<Record<string, string | number | boolean>>) => Promise<MipSolution>;

export type RivalRef = { readonly kind: 'team'; readonly teamId: TeamId } | { readonly kind: 'closest' };
export type AutoBuildObjective =
  | { readonly kind: 'max-own' }
  | { readonly kind: 'margin'; readonly rival: RivalRef }
  | { readonly kind: 'robust'; readonly recentSwims: number; readonly minSwims: number }
  | {
      readonly kind: 'goal-seek';
      readonly target:
        | { readonly kind: 'total'; readonly points: number }
        | { readonly kind: 'margin'; readonly rival: RivalRef; readonly points: number };
    };

export interface AutoBuildLimits {
  /** K, 1..12 */
  readonly candidatesPerEvent: number;
  /** K_max, K..12 */
  readonly maxCandidatesPerEvent: number;
  /** T, 1..24 */
  readonly relaySquadsPerEvent: number;
  /** T_max, T..48 */
  readonly maxRelaySquadsPerEvent: number;
  /** 0..3 */
  readonly refineRounds: number;
  /**
   * Wall time of the whole `autoBuild` call, in seconds, (0, 120] (D5 amendment 1, 6.3). It covers column evaluation, every
   * solve and the gate, measured with `AutoBuildRequest.clock`. A gate reserve of 1 s comes off the top.
   */
  readonly timeLimitSeconds: number;
}
/** Algorithm parameters, not competition values. */
export const AUTOBUILD_DEFAULT_LIMITS: AutoBuildLimits = {
  candidatesPerEvent: 8,
  maxCandidatesPerEvent: 10,
  relaySquadsPerEvent: 12,
  maxRelaySquadsPerEvent: 24,
  refineRounds: 1,
  timeLimitSeconds: 10,
};
export const AUTOBUILD_DEFAULT_ROBUST = { recentSwims: 5, minSwims: 3 } as const;

export interface AutoBuildRequest {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly rules: CompleteRulePreset;
  readonly sourcing: ConversionSettings;
  /** Coach tags for every team plus suggested tags for opponents. An own-team tag must have no `source`. */
  readonly tags: readonly ScorerTag[];
  readonly ownTeamId: TeamId;
  readonly genders: readonly Gender[];
  readonly objective: AutoBuildObjective;
  /** null: no session-load rows (same as mode 'off'). Slice A3 builds the rows of mode 'respect' and 'prefer'. */
  readonly load: { readonly schedule: SessionPreset; readonly preference: LoadPreference } | null;
  readonly limits: AutoBuildLimits;
  /**
   * D5 amendment 1 (6.5 f), additive, optional: a monotonic clock in milliseconds. It starts the wall-time budget
   * `timeLimitSeconds` and fills `proof.timings`. The engine holds no clock of its own (the purity gate bans `performance`
   * and `Date.now`), so the caller passes one, for example `() => performance.now()`. Absent: every timing is `null`, and
   * the budget charges only the seconds that `MipSolution.seconds` reports, so evaluation time is not counted.
   */
  readonly clock?: () => number;
}

export interface AutoBuildEvaluation {
  /**
   * Mode units: points (max-own, robust, margin) or the target metric (goal seek). Prefer mode subtracts penaltyPoints. In robust mode these
   * are the robust own points (`robustOwnPoints`), scored with the robust seed pins, less the penalty.
   */
  readonly objective: number;
  /** Results.teams own total, normal seeds */
  readonly ownPoints: number;
  /** closest: the team that binds */
  readonly rival: { readonly teamId: TeamId; readonly points: number } | null;
  /** Robust mode: the own points of the lineup scored with the robust seed pins (D5 5.4). `null` in every other mode. */
  readonly robustOwnPoints: number | null;
  /** Own swimmers with z = 1 only (section 8.2) */
  readonly penaltyPoints: number;
  readonly results: Results;
  readonly load: ReturnType<typeof sessionLoad> | null;
}
export type EntryChange =
  | { readonly kind: 'added'; readonly entryKey: string }
  | { readonly kind: 'removed'; readonly entryKey: string; readonly why: 'replaced' | 'leg_not_in_search' };

export type AutoBuildExplanation =
  | {
      readonly kind: 'unusual_event';
      readonly entryKey: string;
      readonly swimmerId: SwimmerId;
      readonly eventKey: EventKey;
      readonly gender: Gender;
      readonly place: number;
      readonly points: number;
      readonly seed: Hundredths;
      readonly estimated: boolean;
      readonly otherTeamsAhead: number;
      readonly nextOtherTeamBehind: { readonly teamId: TeamId; readonly seed: Hundredths } | null;
      readonly marginalPoints: number;
      readonly skipped: readonly {
        readonly eventKey: EventKey;
        readonly placeAlone: number;
        readonly marginalPoints: number;
        readonly binding: 'entry_cap' | 'session_load' | 'teammates';
      }[];
    }
  | {
      readonly kind: 'roster_add';
      readonly swimmerId: SwimmerId;
      readonly spotsAfter: { readonly numerator: number; readonly denominator: number };
      readonly marginalPoints: number;
    };

export interface AutoBuildProposal {
  /** The whole meet */
  readonly lineup: Lineup;
  readonly rosterAdds: readonly { readonly teamId: TeamId; readonly gender: Gender; readonly swimmerId: SwimmerId }[];
  /**
   * Input tags plus a role-'scorer' tag (no `source`) per add. Storing them is the coach's Accept, never automatic (R52).
   * Deviation (additive): sorted by team id, swimmer id and role, so the result does not depend on input order.
   */
  readonly tagsForScoring: readonly ScorerTag[];
  readonly entryChanges: readonly EntryChange[];
  /** The section 4.9 count: roster adds plus entry changes. */
  readonly changeCount: number;
  readonly evaluation: AutoBuildEvaluation;
  /** Slice A8. Empty in A1. */
  readonly explanations: readonly AutoBuildExplanation[];
  /** Section 8.3 warnings absent from the current results */
  readonly newWarnings: readonly Violation[];
  readonly method: 'mip' | 'mip-incumbent' | 'local-search';
}

export type AutoBuildRestriction =
  | 'scorers_only_entries'
  | 'relays_within_scoring_cap'
  | 'disjoint_relays'
  | 'relay_leg_bases'
  | 'held_split_entries'
  | 'strict_diver_weight'
  | 'robust_frozen_pairs'
  /**
   * Slice A2: a relay event that holds an own relay with a leg off the decision set (a swimmer tagged off the scoring roster,
   * or off the roster) stays as entered. Its decision legs count toward the entry caps as fixed entries, and its free legs
   * stay off the roster.
   */
  | 'fixed_relay_events';

/**
 * What `autoBuild` proves. In goal seek the quantity is the change count (D5 4.9), `bestFound` is the changes of the lineup found, and
 * `upperBound` is a lower bound on them. A `target_unreachable` result found no lineup: its `bestFound` is 0 (the current lineup's own
 * changes), `upperBound` and `gap` are null, and the status is `proven_optimal` only when the reason is `proven`. A `current_meets_target`
 * result is `proven_optimal` at 0 changes. `proven_optimal` holds within `searchSpace.restrictions` only. The fewest-changes tie-break (4.9) is
 * minimal within the columns actually built (pruning under a numeric per-event cap removes some multi-member columns), and
 * it runs only when time is left. It is a tie-break, not a guarantee. The current column is never pruned, so a zero-change
 * tie is always reachable inside the space.
 */
export interface AutoBuildProof {
  readonly status: 'proven_optimal' | 'gap' | 'unknown';
  /** Objective units (goal seek: changes) */
  readonly bestFound: number;
  /** Goal seek: lower bound on changes */
  readonly upperBound: number | null;
  /** |upperBound - bestFound|; null when unknown */
  readonly gap: number | null;
  readonly searchSpace: {
    readonly restrictions: readonly AutoBuildRestriction[];
    /**
     * D5 amendment 1 (6.5 b), additive: the same restrictions, each with a `binding` flag. `strict_diver_weight` is binding when
     * the current lineup passes the gate but breaks the strict diver weight (4.4), so the search space excludes it. The
     * guard then treats the current lineup normally. Every other restriction is `binding: false` in A1.
     */
    readonly restrictionStatus: readonly { readonly restriction: AutoBuildRestriction; readonly binding: boolean }[];
    /**
     * D5 amendment 2, additive: the relay events that stay as entered (`fixed_relay_events`). A fixed event has no columns, no leg
     * options and no outside slot, so it is not in `events`.
     */
    readonly fixedRelayEvents: readonly { readonly eventKey: EventKey; readonly gender: Gender }[];
    /**
     * D5 5.4 (A7), additive: the pairs that robust mode freezes because they have fewer than `minSwims` usable swims. A frozen pair is never added, and
     * a current entry of a pinned swimmer is never dropped. `swims` is the count the rule found. Empty in every other mode. The restriction
     * `robust_frozen_pairs` is listed exactly when this list is not empty.
     */
    readonly frozenPairs: readonly { readonly swimmerId: SwimmerId; readonly eventKey: EventKey; readonly gender: Gender; readonly swims: number }[];
    /**
     * One entry per built event. For an individual or diving event, `candidates` is the candidate swimmers, `outside` the swimmers
     * outside them, and `columns` the columns. For a relay event, `candidates` is `|Q_e|` (the squads), `outside` is 1 when a squad
     * lies outside `Q_e` (`tau_out` exists) and 0 otherwise, and `columns` is the number of columns (sets of at most R disjoint
     * squads, plus the current column).
     */
    readonly events: readonly {
      readonly eventKey: EventKey;
      readonly gender: Gender;
      readonly candidates: number;
      readonly outside: number;
      readonly columns: number;
    }[];
  };
  /** `ms` is `null` when the solver reports no run time and the request holds no clock. */
  readonly solves: readonly {
    readonly stage: 'relaxed' | 'restricted' | 'tie-break' | 'local-search';
    readonly status: string;
    readonly ms: number | null;
    readonly rows: number;
    readonly cols: number;
  }[];
  /** Each is `null` when the request holds no clock (deviation from D5: the engine cannot read a clock itself). */
  readonly timings: { readonly evaluateMs: number | null; readonly solveMs: number | null; readonly gateMs: number | null };
}

export type AutoBuildResult =
  | { readonly kind: 'improved'; readonly proposal: AutoBuildProposal; readonly current: AutoBuildEvaluation; readonly proof: AutoBuildProof }
  | {
      readonly kind: 'unchanged';
      readonly reason: 'proven_no_better' | 'none_found_within_limits' | 'current_meets_target';
      readonly current: AutoBuildEvaluation;
      readonly proof: AutoBuildProof;
    }
  | {
      readonly kind: 'current_infeasible';
      readonly currentViolations: readonly Violation[];
      readonly alternative: AutoBuildProposal | null;
      readonly current: AutoBuildEvaluation;
      readonly proof: AutoBuildProof;
    }
  | {
      readonly kind: 'target_unreachable';
      readonly reason: 'proven' | 'within_limits';
      readonly current: AutoBuildEvaluation;
      readonly proof: AutoBuildProof;
    };

export type AutoBuildErrorCode =
  | 'own_team_unknown'
  | 'draft_meet'
  | 'nothing_to_build'
  | 'own_tag_not_coach'
  | 'rule_unsupported'
  | 'pending_setting'
  | 'unscheduled_event'
  | 'rival_invalid'
  | 'target_invalid'
  | 'limits_invalid'
  | 'robust_no_spread'
  | 'scale_unsupported'
  | 'model_mismatch'
  /**
   * The request asks for an objective that is not built: goal seek with the `prefer` load mode (D5 4.7 leaves open whether the target metric
   * carries the load penalty). The subject names the objective kind.
   */
  | 'mode_not_built';

export class AutoBuildError extends Error {
  readonly code: AutoBuildErrorCode;
  /** The setting path, id or field the error is about, when it has one. */
  readonly subject: string | null;

  constructor(code: AutoBuildErrorCode, message: string, subject: string | null = null) {
    super(message);
    this.name = 'AutoBuildError';
    this.code = code;
    this.subject = subject;
  }
}

export const autoBuildFail = (code: AutoBuildErrorCode, message: string, subject: string | null = null): never => {
  throw new AutoBuildError(code, message, subject);
};
