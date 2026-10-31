# D5: AutoBuilder (F4, P6)

Status: design draft, 2026-10-29, architect. Code citations are at HEAD 6ce422bd. In `01-REDESIGN-PLAN.md` F4, "design item D4" means this file. This spec builds after P5 (the planner), because session load is a constraint.

## 0. Decisions

1. **Formulation B only** (S4 table, `01-REDESIGN-PLAN.md` F4). Each event gets one column per subset of own entries. Each candidate pair gets one binary `x[s,e]`, tied to the columns by an equality. Caps act on `x`. Formulation A is never used.
2. **Column values come from `scoreMeet`, one event at a time.** Once the tags are fixed, `scoreMeet` ranks and scores each field on its own (`results.ts:1060-1077`; team size and entry caps only report). So the meet total equals the sum of the event totals, and the MIP objective is exactly that sum. A whole-meet `scoreMeet` re-score is the only gate (section 8).
3. **No up-front proof exists that a top-K column bound loses nothing.** Section 6.1 gives a counterexample. Instead, every call computes a certificate. A relaxed MIP gives a valid upper bound `UB`, and the gap is `UB - best found`. A gap of 0 proves the truncation lost nothing. A positive gap is reported, never hidden.
4. **Opponents are fixed for one call.** Their entries are the lineup's entries for other teams, as given. The simulator already enters each team's best entries under the page limits. Their tags are the caller's merged coach and suggested tags (D2 3.14). The AutoBuilder never re-optimizes an opponent.
5. **Coach tags are pins** (R21, R65). A `'scorer'` tag fixes the swimmer on the roster. A `'non-scorer'` or `'exhibition'` tag fixes the swimmer off it, and their entries stay unchanged. An own member with no tag is free. An untagged swimmer with `unknown` membership never gets a new entry (D2 3.8).
6. **The guard** follows legacy `rosterOptimizer.ts:9-21, 62-75, 186`. A proposal is accepted only when it strictly beats the current lineup on the mode's own objective, computed through `scoreMeet`. Otherwise the result is `'unchanged'` and gives a reason.
7. **No A/B final brackets are modeled.** `scoreMeet` has no rounds (D2 section 9 item 17) and projects from seeds. With seed projection, the A/B bracket gives the same order as one timed final, so the points are identical. If `scoreMeet` later models rounds, the columns follow automatically.
8. **Invariant 17** (`rankEventsByStrength`) governs heuristic event rankings. The AutoBuilder ranks nothing by heuristic: it scores the meet itself, which is invariant 17's rule 1. Explanations (section 9) use rule 1 on engine data.

## 1. Terms

- **Side**: one team and one gender.
- **Built genders** `G`: the request's `genders`. Own entries of other genders are fixed.
- **Decision swimmers** `S_g`: own members of gender `g` who are coach-tagged `'scorer'` (pinned, `P_g`) or untagged with `roster: 'member'` (free, `F_g`).
- **Pinned off**: own swimmers tagged `'non-scorer'` or `'exhibition'`. They and their entries are fixed.
- **Solver-owned entries**: every own entry in a built gender by a swimmer with `z = 1`. Own relays are solver-owned from slice A2 on; in slice A1 they are fixed (12.1).
- **Kept entries**: the current entries of a free swimmer who ends with `z = 0`. They stay in the lineup unchanged, as non-scorer entries.
- **Held entries**: a free swimmer's current entry in a `timed-final-split` event. It stays whatever `z` is (`x[s,e] = z[s]`). Section 4.6 explains why.
- **Standing entry**: a fixed entry that holds a rank in its field after the roster and cap removals. In the event's empty-column evaluation it has `place !== null`.

## 2. Public API (engine, additive)

New directory: `packages/engine/src/autobuilder/`. New export block "3.15 AutoBuilder (D5)" in `packages/engine/src/index.ts`.

```ts
// autobuilder/types.ts
import type { MeetModel, Lineup, ScorerTag, CompleteRulePreset, ConversionSettings, Results, Violation,
  TeamId, SwimmerId, Gender, EventKey, Hundredths, SessionPreset, LoadPreference, SessionRef } from '../index';

/** HiGHS MIP result. `columns` holds values only when status is 'Optimal' (optimizerResult.ts:2-3 rule). */
export interface MipSolution {
  readonly status: string;
  readonly objective: number;
  readonly columns: Readonly<Record<string, number>>;
  /** Only when status is 'Time limit reached' and HiGHS reports primal_solution_status 2. Never an optimum. */
  readonly incumbent: { readonly objective: number; readonly columns: Readonly<Record<string, number>> } | null;
  /** HiGHS info 'mip_dual_bound' after the run; null when not reported. */
  readonly dualBound: number | null;
}
export type MipSolve = (lp: string, options: Readonly<Record<string, string | number | boolean>>) => Promise<MipSolution>;

export type RivalRef = { readonly kind: 'team'; readonly teamId: TeamId } | { readonly kind: 'closest' };
export type AutoBuildObjective =
  | { readonly kind: 'max-own' }
  | { readonly kind: 'margin'; readonly rival: RivalRef }
  | { readonly kind: 'robust'; readonly recentSwims: number; readonly minSwims: number }   // integers, 1 <= minSwims <= recentSwims <= 20
  | { readonly kind: 'goal-seek'; readonly target:
        | { readonly kind: 'total'; readonly points: number }
        | { readonly kind: 'margin'; readonly rival: RivalRef; readonly points: number } };

export interface AutoBuildLimits {
  readonly candidatesPerEvent: number;      // K, 1..12
  readonly maxCandidatesPerEvent: number;   // K_max, K..12
  readonly relaySquadsPerEvent: number;     // T, 1..24
  readonly maxRelaySquadsPerEvent: number;  // T_max, T..48
  readonly refineRounds: number;            // 0..3
  readonly timeLimitSeconds: number;        // total HiGHS time across all solves, (0, 120]
}
/** Algorithm parameters, not competition values. */
export const AUTOBUILD_DEFAULT_LIMITS: AutoBuildLimits =
  { candidatesPerEvent: 8, maxCandidatesPerEvent: 12, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 10 };
export const AUTOBUILD_DEFAULT_ROBUST = { recentSwims: 5, minSwims: 3 } as const;   // open question 1

export interface AutoBuildRequest {
  readonly model: MeetModel; readonly lineup: Lineup; readonly rules: CompleteRulePreset;
  readonly sourcing: ConversionSettings;
  /** Coach tags for every team plus suggested tags for opponents. An own-team tag must have no `source`. */
  readonly tags: readonly ScorerTag[];
  readonly ownTeamId: TeamId;
  readonly genders: readonly Gender[];
  readonly objective: AutoBuildObjective;
  /** null: no session-load rows (same as mode 'off'). */
  readonly load: { readonly schedule: SessionPreset; readonly preference: LoadPreference } | null;
  readonly limits: AutoBuildLimits;
}

export interface AutoBuildEvaluation {
  /** Mode units: points (max-own, robust, margin) or the target metric (goal seek). Prefer mode subtracts penaltyPoints. */
  readonly objective: number;
  readonly ownPoints: number;                       // Results.teams own total, normal seeds
  readonly rival: { readonly teamId: TeamId; readonly points: number } | null;   // closest: the team that binds
  readonly robustOwnPoints: number | null;
  readonly penaltyPoints: number;                   // own swimmers with z = 1 only (section 8.2)
  readonly results: Results;
  readonly load: ReturnType<typeof import('../planner/sessionLoad').sessionLoad> | null;
}
export type EntryChange =
  | { readonly kind: 'added'; readonly entryKey: string }
  | { readonly kind: 'removed'; readonly entryKey: string; readonly why: 'replaced' | 'leg_not_in_search' };
export interface AutoBuildProposal {
  readonly lineup: Lineup;                          // the whole meet
  readonly rosterAdds: readonly { readonly teamId: TeamId; readonly gender: Gender; readonly swimmerId: SwimmerId }[];
  /** Input tags plus a role-'scorer' tag (no `source`) per add. Storing them is the coach's Accept, never automatic (R52). */
  readonly tagsForScoring: readonly ScorerTag[];
  readonly entryChanges: readonly EntryChange[];
  readonly changeCount: number;                     // the section 4.9 count
  readonly evaluation: AutoBuildEvaluation;
  readonly explanations: readonly AutoBuildExplanation[];   // section 9
  readonly newWarnings: readonly Violation[];               // section 8.3 warnings absent from the current results
  readonly method: 'mip' | 'mip-incumbent' | 'local-search';
}
export interface AutoBuildProof {
  readonly status: 'proven_optimal' | 'gap' | 'unknown';
  readonly bestFound: number;                       // objective units (goal seek: changes)
  readonly upperBound: number | null;               // goal seek: lower bound on changes
  readonly gap: number | null;                      // |upperBound - bestFound|; null when unknown
  readonly searchSpace: {
    readonly restrictions: readonly AutoBuildRestriction[];
    readonly events: readonly { readonly eventKey: EventKey; readonly gender: Gender;
      readonly candidates: number; readonly outside: number; readonly columns: number }[] };
  readonly solves: readonly { readonly stage: 'relaxed' | 'restricted' | 'tie-break' | 'local-search';
    readonly status: string; readonly ms: number; readonly rows: number; readonly cols: number }[];
  readonly timings: { readonly evaluateMs: number; readonly solveMs: number; readonly gateMs: number };
}
export type AutoBuildRestriction = 'scorers_only_entries' | 'relays_within_scoring_cap' | 'disjoint_relays'
  | 'relay_leg_bases' | 'held_split_entries' | 'strict_diver_weight' | 'robust_frozen_pairs';
export type AutoBuildResult =
  | { readonly kind: 'improved'; readonly proposal: AutoBuildProposal; readonly current: AutoBuildEvaluation; readonly proof: AutoBuildProof }
  | { readonly kind: 'unchanged'; readonly reason: 'proven_no_better' | 'none_found_within_limits' | 'current_meets_target';
      readonly current: AutoBuildEvaluation; readonly proof: AutoBuildProof }
  | { readonly kind: 'current_infeasible'; readonly currentViolations: readonly Violation[];
      readonly alternative: AutoBuildProposal | null; readonly current: AutoBuildEvaluation; readonly proof: AutoBuildProof }
  | { readonly kind: 'target_unreachable'; readonly reason: 'proven' | 'within_limits';
      readonly current: AutoBuildEvaluation; readonly proof: AutoBuildProof };

export type AutoBuildErrorCode = 'own_team_unknown' | 'draft_meet' | 'nothing_to_build' | 'own_tag_not_coach'
  | 'rule_unsupported' | 'pending_setting' | 'unscheduled_event' | 'rival_invalid' | 'target_invalid'
  | 'limits_invalid' | 'robust_no_spread' | 'scale_unsupported' | 'model_mismatch';
export class AutoBuildError extends Error { readonly code: AutoBuildErrorCode; readonly subject: string | null }

export function autoBuild(req: AutoBuildRequest, solve: MipSolve): Promise<AutoBuildResult>;
```

### 2.1 Refusals (in this order; every one throws)

1. Preflight. Run `scoreMeet(model, lineup, tags, rules, sourcing)` on the current lineup (and `sessionLoad` when `load` is set). Its `ScoreMeetError` reaches the caller unchanged. This covers `scoring_roster_missing` for an untagged own or opponent side (R65), `leg_basis_unsupported`, and `roster_not_member`. Same pattern as `rosterSuggest.ts:616-623`.
2. `draft_meet`: `model.teams` is empty (R54). `own_team_unknown`: `ownTeamId` is not in the model. `nothing_to_build`: no decision swimmer in any built gender.
3. `own_tag_not_coach`: an own-team tag has `source` set.
4. `rule_unsupported`, with the setting path as subject:
   - `scorers.eligibility` is not `'roster'`. The SwimCloud page preset is `points_pool` (`simulatorRules.ts:156`); its team pool couples events.
   - `scorers.scoringTeamScope` is `'event'` with a numeric size.
   - `scoring.nonScorerPlacement` is `'holds-place'`. A held non-scorer's place would depend on `z`. This is a later slice.
   - `scorers.relayLegsMustBeScorers` is false. This is a later slice.
   - `scorers.scoringRelaysPerTeamPerEvent` is `'unlimited'`.
   - A point table rises with place, holds a negative value, or has more than 4 decimals. Reuse the checks and decimal scale of `rosterSuggest.ts:130-187`. Section 6 needs a non-increasing, non-negative table.
   - `prefer` mode with a penalty that has more than 4 decimals.
5. `pending_setting`, with a subject such as `load.preference.maxRacesPerSession` or `schedule:<event>|<gender>:fastHeatSize`:
   - `load.preference` is not `'off'` and `maxRacesPerSession` or `diving` is pending.
   - `prefer` mode and the penalty is pending.
   - Any `pending_setting` violation from a column's `sessionLoad` (section 5.3) other than `'cFinal'`. `cFinal` affects only non-scorers.
6. `unscheduled_event`: `load` is set and a candidate pair's event is missing from the schedule. `sessionLoad` would emit `unscheduled_event` (`sessionLoad.ts:41`), never zero races.
7. `rival_invalid`: the rival is the own team or is not in the model. `target_invalid`: a non-finite target. `limits_invalid`: a value outside the ranges in section 2.
8. `robust_no_spread`: robust mode, and no own candidate pair has a spread (section 5.4). A model built from the simulator alone always lands here, because simulator swims carry no date (`02-SIMULATOR-RECON.md:150-153`).
9. `scale_unsupported`: section 5.2. `model_mismatch`: section 8.

### 2.2 Acceptance (slice A1 unless marked)

1. `refusals`: one test per code above. Each asserts `code` and `subject`.
2. `preflightPassesThrough`: an untagged own side gives `ScoreMeetError('scoring_roster_missing')`, not an `AutoBuildError`.
3. `ownTagWithSource`: an own tag with `source: 'suggested'` throws `own_tag_not_coach`.
4. `resultKinds`: each result kind is produced by at least one fixture (A1: improved, unchanged ×2, current_infeasible; A6: target_unreachable, current_meets_target).

## 3. Search space

### 3.1 Candidate pairs (individual and diving)

The pair `(s, e)` is a candidate when all of these hold:
- `s ∈ S_g` and `e` is a non-relay model event of gender `g`.
- `resolveLineup` gives a non-null value for `{kind:'individual', seedSwimId:null}`. That is a rankable SCY or converted swim (`results.ts:386-410`, invariant 8).
- The pair is **scorable**: in the singleton evaluation (column `{s}`, section 5), `s` takes a place within the point table. This filter is exact for every mode. An own entry placed past the table earns 0, and every entry behind it or tied with it is also past the table, so the entry moves no points for any team. It only costs a cap and a race.

A current solver-owned entry is always available through the event's **current column** (3.3), scorable or not.

`C_e` is the first K scorable candidates by seed: fastest first, dives highest first, ties by swimmer id in code-unit order. Refinement (6.3) can grow `C_e` up to `K_max`. Scorable candidates outside `C_e` are the event's **outside pairs**.

### 3.2 Relay squads (slice A2)

Leg options for swimmer `s` at position `i` of relay `e`. The expected leg events are those of `expectedLegEvents` (`results.ts:412-424`). This follows invariant 13 (exact event) and invariant 19.
- **Leg 1**: a `flat-start-swim` from a model swim of `s` in the expected event that passes `isRankable` and has a non-null `scyValue`. Or a `split` with `legEventKey` equal to the expected event, `course: 'SCY'` and `start: 'flat'`.
- **Legs 2 to 4**: a `split` with the expected `legEventKey`, `course: 'SCY'` and `start` of `'flying'` or `'unknown'`. A `'flying'` or `'unknown'` start never counts as a leadoff, because that could be optimistic. A flat-start swim is never used on legs 2 to 4: `scoreMeet` flags `basis_position` (`results.ts:507`). See open question 5.
- `flyover-estimate` is not used: `scoreMeet` throws on it (`results.ts:433`).
- Per position, the best option is the fastest. Ties go to the lower `swimId` or `splitId`.

A squad is four distinct decision swimmers of the relay's gender, with an option at each position. Its time is the sum of the four leg values. Free relays fix legs 2 to 4 in swimmer-id order (no duplicate sets) and pick the leadoff that gives the smallest total.

`Q_e` holds:
- The top T squads by time. Generate them with a best-first k-best search over the per-position option lists sorted by time. Skip a squad that repeats a swimmer. Break ties by the canonical leg string.
- For each of those squads, the best squad that shares no swimmer with it. Without this, the top T squads can all share one swimmer, and no B relay would exist.
- The current own squads.

`tau_out` is the time of the (T+1)-th squad in time order. Any squad not in the top T is at least that slow.

### 3.3 Columns

- **Individual and diving event**: every subset of `C_e`, the empty set included. With K = 8 that is 256 subsets, against S4's sizes 1 to 4. Add the **current column** (the current solver-owned entries of `e`) when it is not already a subset.
  - Pruning: under a numeric per-event cap with `'removed-from-consideration'`, drop subsets larger than the cap. The over-cap entries leave the places, so a larger subset has the same value at a higher cost. The current column is never dropped.
- **Relay event**: every set of at most `R = scoringRelaysPerTeamPerEvent` squads from `Q_e` that are pairwise swimmer-disjoint, the empty set included, plus the current column.

### 3.4 Search restrictions

Each restriction is listed in `proof.searchSpace.restrictions`. A gap of 0 is a proof within these restrictions only.

| Restriction | Meaning | Why |
| --- | --- | --- |
| `scorers_only_entries` | The AutoBuilder never adds an entry for a swimmer off the roster. | A non-scorer entry earns 0 and moves nothing under `'removed-from-consideration'`. |
| `relays_within_scoring_cap` | At most R own relays per event. | A relay over the cap scores 0 under R67 `'exhibition'`, and under R42 it is an entry violation. |
| `disjoint_relays` | One swimmer is never on two relays of one event. | NCAA 5-7-1-g (`generic` v2). NSISC v5 leaves the rule absent (open question 2). |
| `relay_leg_bases` | Only the bases in 3.2. | A flat-start leg on legs 2 to 4 raises a `basis_position` violation, and no flyover setting exists yet. |
| `held_split_entries` | 4.6. | — |
| `strict_diver_weight` | 4.4. | — |
| `robust_frozen_pairs` | 5.4. | — |

## 4. The MIP (formulation B)

Build one MIP per built gender, except `margin/closest` and `goal-seek`. Those couple the genders through team totals, so they get one joint MIP. All coefficients are integers at scale `D` (5.2).

| Family | Rows | Rule source |
| --- | --- | --- |
| E1 one column per event | `Σ_p y[e,p] = 1` | — |
| E2 link (formulation B) | `Σ_{p ∋ s} y[e,p] − x[s,e] = 0` for every s in some column of e | S4 |
| Z1 roster gate | `x[s,e] − z[s] ≤ 0` for s ∈ F (relay legs too) | R37, R71, `planRoster` `results.ts:944-951` |
| Z2 no empty add | `z[s] − Σ_e x[s,e] ≤ 0` for s ∈ F | R78 warns on a scorer with no entry |
| Z3 held split entries | `x[s,e] − z[s] = 0` | 4.6 |
| C1 to C3 entry caps | individual: `Σ_{e non-relay} x[s,e] + k_I(s) ≤ cap_I`; relay: `Σ_{e relay} x[s,e] + k_R(s) ≤ cap_R`; total: both sums `≤ cap_T`. `k` counts the swimmer's fixed entries (A1: fixed relays). Omit a row when the cap is `'unlimited'`. | R73 (7 total), R75 (every entry counts), `entryCapViolations` `results.ts:525-558` (distinct entry keys) |
| D1 to D3 diver indicator | `d[s] ≤ z[s]` (or ≤ 1 if pinned); `d[s] − Σ_{e diving} x[s,e] ≤ 0`; `d[s] + x[s,e] ≤ 1` for every non-diving pair (individual and relay). A1: `d = 0` for a leg of a fixed relay. | R9, R28, `teamSizeViolations` `results.ts:986-1013` |
| T1 scoring-team size | `Σ_{s∈S} (den·z[s] − (den−num)·d[s]) ≤ size·den`, pinned `z = 1`. Omit when unlimited. | R24 (18), R9 (1/3) |
| L0 race indicators | `g[s,e,σ] − Σ_{p∋s} r_p(s,σ)·y[e,p] = 0`, only where `r_p(s,σ)` differs across the columns that hold s | R17, R20, R35, R43, `sessionLoad.ts:70-125` |
| L1 respect | `Σ_e race(s,e,σ) ≤ maxRacesPerSession` per s ∈ S and session σ. Omit trivially true rows. | R6, R17 |
| L2 prefer | `v[s,σ] − Σ_e race(s,e,σ) ≥ −max`, `v ≥ 0` general | F3 prefer |
| M margin (closest) | `t − Σ y·(own − pts_k) ≤ const_k`, one row per other team k | R5 |
| GS goal seek | `value ≥ ⌈target·D⌉` | R5 |

### 4.1 Variables

- `y[e,p]` binary per column.
- `x[s,e]` binary per (swimmer, event) that appears in any column. Disjoint relays keep relay `x` binary.
- `z[s]` binary for s ∈ F. Pinned swimmers are the constant 1.
- `d[s]` binary for swimmers with a diving pair.
- `g[s,e,σ]` binary.
- `v[s,σ]` general integer, `0..|E|`.
- `t` general integer, bounded by ±(the sum of |coefficients|).
- `one`, fixed at 1, carries the objective constant (`rosterSuggest.ts:565-578`).

### 4.2 Per-event scorer cap

The per-event scorer cap is a scoring rule, not an entry rule. Entering over-cap scorers is legal, and those entries are held or removed. So no row is needed. The column values already apply the cap through `scoreMeet` (`overCapKeys`, `results.ts:764-807`), and 3.3 prunes the dominated columns.

### 4.3 Relay rules

- **Legality** (invariant 19) and the leg bases come from squad generation: there are no rows.
- **R67 and R42**: columns hold at most R relays, so the solver never creates an over-cap or exhibition relay. Opponent relays over their cap are constants inside the column values.
- **`nonScoringRelaysAllowed: false`** cannot fire on solver relays.
- **`relaySwimmerOncePerEvent`** cannot fire either, because squads are disjoint.
- An own relay with an exhibition leg (R76) is never built, because exhibition-tagged swimmers are not decision swimmers.

### 4.4 Diver weight: strict rule

D3 uses a stricter rule than the code. `teamSizeViolations` counts a swimmer as a diver when they have a dive entry and no relay entry, even if they also swim individual events (`results.ts:1002`). The comment at `results.ts:980` says "whose entries are all diving". The MIP counts a diver only when every entry is a dive. Its weight is then never below the gate's weight, so a feasible MIP solution never raises `scoring_team_size`. The AutoBuilder never earns 2/3 of a spot by adding a dive entry for a swimmer who swims an individual event. See open question 4 and Found.

### 4.5 Session races

Each column carries `r_p(s,σ)`, the races that swimmer s swims in session σ for event e. They come from `sessionLoad` on the column's sub-lineup (5.3), so they match `sessionLoad` exactly:
- a timed final counts 1 race;
- a prelims-finals event counts 1 prelims race, plus 1 finals race when s ranks within the table among scorers (`sessionLoad.ts:79-88`);
- a split timed final counts 1 race in the fast or slow heat by seed among all entries, or in the small-field session (`sessionLoad.ts:105-124`);
- dives count 0 under `'excluded'` (`sessionLoad.ts:63-66`).

`race(s,e,σ)` is `c·x[s,e]` when every column that holds s gives the same count c, else `g[s,e,σ]` from L0. A race term never puts a column-swimmer term directly into a session row.

### 4.6 Held split entries

`sessionLoad` ranks a split timed final over every entry, non-scorers included (R40; `sessionLoad.ts:113-121`). It also counts every entry for the small-field test (`sessionLoad.ts:108`). If a free swimmer's kept entry left the event when `z` turns 1, the heat of every own scorer would depend on `z`. So such an entry is held: `x = z` (Z3), and the column evaluation always includes it. Points do not change: a non-scorer is removed from the places.

### 4.7 Objective per mode (before the tie-break)

| Mode | Maximize |
| --- | --- |
| max-own | `Σ y·own(e,p) + const` |
| margin, team k | `Σ y·(own − pts_k)(e,p) + const` |
| margin, closest | `t` (rows M) |
| robust | `Σ y·ownRobust(e,p) + const` |
| goal seek | minimize changes (4.9), subject to GS |
| prefer (any mode but goal seek) | subtract `pen·D·Σ v` |

When the own team trails, `closest` maximizes the margin over the leader. That is the max-min reading: the result is the margin over whichever team ends closest.

### 4.8 LP text and solver options

- Follow `rosterSuggest.ts`: `formatInt` refuses a non-integer (`:221`), `render` (`:565`), `readColumn` fails loudly on a fractional or missing value (`:580`), and the objective is recomputed from the columns (`:679`). Declare `v` and `t` in a `General` section.
- Build canonical text: number teams, swimmers and events in sorted-id order, and columns by sorted member ids. Permuting the input arrays gives byte-identical LP text.
- Options: `{ mip_rel_gap: 0, mip_abs_gap: 0.5, random_seed: 0, output_flag: false, time_limit: <remaining seconds> }`. This copies `rosterSuggest.ts:102-108`. The objective is a whole number, so a gap below 0.5 proves the optimum.
- Copy the conventions into `autobuilder/lp.ts`. Do not edit `rosterSuggest.ts`.

### 4.9 Change count

The same expression serves the goal-seek objective and the tie-break.

- **Pinned s**: `Σ_{cur} (1 − x) + Σ_{¬cur} x`.
- **Free s**: `z[s] + Σ_{cur kept} (z − x) + Σ_{¬cur} x`. A kept pair with no `x` variable has `x = 0`.
- **Relay e**: `Σ_p y·|squads(p) Δ squads(cur_e)|`. A squad's identity is its ordered leg swimmer ids.

This is linear because `x ≤ z`.

## 5. Column values

### 5.1 Evaluation

For event (e, g) and column p, build three inputs and call `scoreMeet`:

- **Sub-model**: `events: [e]`. Keep only the swims and splits of the swimmers in the sub-lineup. All teams and swimmers stay.
- **Sub-lineup**: the fixed entries of (e, g) in current lineup order, then the held entries, then p's entries in their **built positions**:
  - a current entry keeps its place among the event's entries and reuses the current entry object, so a coach's `seedSwimId` pin stays;
  - a new entry comes after every fixed or surviving entry of the event, sorted by `entryKey`, with `seedSwimId: null`;
  - a new relay takes the lowest letter unused by a surviving own relay, in squad-time order.

  Kept non-held entries are left out. They are removed non-scorers and move nothing.
- **Tags**: the input tags plus a `'scorer'` tag for each free member of p.

Read the points per team for e from `Results.events`.

The built lineup (8.1) uses the same positions. That keeps `ties: 'ordered'` (lineup order breaks a tie, `results.ts:700`) and the split-heat tie-break (`sessionLoad.ts:116`) consistent by construction.

Measured: one-event `scoreMeet` costs 0.31 ms with 3 teams on config C (reduced model) and 1.10 ms with 10 teams (relays 2.6 ms). That is about 4 to 5 s per gender at 10 teams. Slice A4 therefore adds a fast evaluator under a parity test. The `scoreMeet` path stays as the reference.

### 5.2 Integer scale

1. Let `decScale` be the decimal scale from `rosterSuggest.ts:163`.
2. Collect the tie-group sizes seen in every evaluation: rows that share a `place` under `'split'`.
3. Set `D = decScale · lcm(sizes ∪ {1})`.
4. Every value v must satisfy `|v·D − round(v·D)| < 1e-6`. Otherwise throw `scale_unsupported`.
5. Also throw `scale_unsupported` when the total of |coefficients| reaches `2^40` (`rosterSuggest.ts:668`).

### 5.3 Races per column (A3)

Run `sessionLoad(subModel, subLineup, subResults, schedule restricted to (e, g), preference, rules)`. Take `perSwimmer` for p's members. `penaltyPoints` is never read (8.2).

### 5.4 Robust mode: the spread (A7)

For a pair (s, e), the eligible swims are the model swims of s in e that meet all of these:
- `isRankable`;
- `scy.kind === 'recorded-scy'`, so no converted estimate mixes in conversion error;
- `date !== null`;
- inside `model.recordRange` (`dates`: from ≤ date ≤ to; `seasons`: `seasonId` listed).

Take the `recentSwims` most recent (date descending, ties by `swimId`). If fewer than `minSwims` remain, the spread is **absent**. Otherwise sort them fastest first (dives highest first). The **robust swim** is the one at index `⌈(n−1)/2⌉`, the slower middle. It is a real swim and never faster than the best.

Rules:
- `ownRobust(e,p)` is the own points with each own column entry's `seedSwimId` pinned to its robust swim. `scoreMeet` scores this unchanged, and no synthetic time exists.
- A pair with an absent spread is **frozen**. It is never added. If it is a current solver entry, `x = 1` is fixed. It is valued at its normal seed and listed with its swim count.
- Opponents keep their normal seeds (R5: "own points").
- Relays and their legs are not slowed. Only `times_by_event` holds history, and it has no flying legs (`02-SIMULATOR-RECON.md:528-537`).
- Session races use normal seeds, the lineup as entered.

## 6. Exactness: the certificate

### 6.1 Why a top-K bound is not lossless

Take an event e where the 8 fastest own swimmers are each at the total cap in events worth more. The 9th takes 5th in e. Every top-8 subset leaves those points out. The test `deepTeamNeedsNinth` builds this case.

### 6.2 The relaxed MIP

Add to the restricted MIP:

- **Outside individual pair** `o[s,e]` (binary):
  - add `ub(s,e) = own({s})`, the singleton column's own points, to the objective;
  - count it in C1 to C3, Z1 (`o ≤ z`), D2 and D3;
  - count its certain races only: the prelims session of a prelims-finals event, or the session of a timed final; nothing for a split timed final or a final;
  - add `x[s,e] + o[s,e] ≤ 1` when s is also in a column.
- **Outside relay slot** `oR[e]` (general, 0..R):
  - add `Σ_p y·|p| + oR ≤ R`;
  - add `ub_rel(e)`, the relay table at place `1 + #(standing fixed relays faster than tau_out)` (`≤` under `'ordered'`), per unit;
  - charge `w[s,e]` binary with `Σ_s w = 4·oR`, `w + x ≤ 1`, `w ≤ z`; `w` counts in the relay and total caps, D3, and the relay's session.
- **Margin mode**: also add `λ_k(s) = Σ_r step_r` to each rival term. The sum runs over k's standing entries r whose value is not better than s's. `step_r = max_{q ≥ q_r} (table[q] − table[q+1])`, with `table[L+1] = 0` and `q_r` the place of r in the empty column. Do not reuse the single-column loss: the NSISC steps are uneven (20-17-16 … 11-9-7).
- **Goal seek**: outside terms count 0 changes.

**Lemma (validity).** Take any lineup in the full space with own set `S_e = S_in ∪ S_out` in event e, where `S_in ⊆ C_e`.
1. Adding entries to a field never raises an existing entry's points. A faster entry shifts its tie group down one place. A tied entry extends the group by one trailing place, and the average of a non-increasing table over the longer window is not higher. An own entry pushed over a numeric cap earns 0.
2. So the members of `S_in` earn no more than `own(S_in)`, and each s in `S_out` earns at most `own({s})`.
3. Each added own entry costs a rival entry r at most one place shift or one tie extension, and either costs at most `step_r`.
4. The relaxed rows charge each outside entry at least its true cap, size and race usage. Prefer penalties are non-negative.

So every lineup maps to a relaxed solution with a value at least as high. The relaxed optimum is a valid UB, and its dual bound is one too. The lemma needs the point-table refusal in 2.1.

### 6.3 Solve sequence

1. Solve the relaxed MIP.
   - Optimal with every `o` and `oR` at 0: the solution is a real lineup and optimal. Status `proven_optimal`.
   - Otherwise, refine. For each event with an active `o` or `oR`, add those swimmers to `C_e` (up to `K_max`) or double T (up to `T_max`). Re-evaluate the new columns and solve again, for at most `refineRounds` rounds.
2. If outside terms are still active, fix them at 0 and solve the restricted MIP for the best real lineup. `UB` is the relaxed objective (or its `dualBound` at the time limit). `gap = UB − bestFound` in objective units. Status `gap`.
3. **Tie-break** (when time remains and stage 1 was Optimal): minimize changes (4.9) subject to objective `≥ P*`. In goal seek, this stage instead maximizes the metric subject to changes `≤ C*`. If it times out, keep the stage 1 solution and record the stage. Do not copy `rosterSuggest`'s per-candidate stage 3; it does not fit 10 s.
4. **Time budget**: each solve gets `time_limit = timeLimitSeconds − HiGHS time used so far`.
5. **Status**: read `columns` only on `'Optimal'`. On `'Time limit reached'`, use `incumbent` only as a lower bound and as a local-search seed (section 10, slice A5). Any other status is a non-result.
6. **Infeasible**: if the current lineup is feasible (8.3), it is a witness, so an infeasible MIP means `model_mismatch`. If the current lineup is not feasible, the result is `current_infeasible` with `alternative: null`.
7. **Sanity check**: when the current lineup is feasible, an optimum below the current objective means `model_mismatch`.

## 7. Determinism

Canonical LP text (4.8) plus `random_seed: 0` on the single-threaded wasm (`types.d.ts:61-62, 167`). Equal inputs give equal LP text and so equal solutions. No step reads Map iteration order or input array order. The built lineup orders new entries by event in `model.events` order, then by `entryKey`.

## 8. Gate and guard

### 8.1 Build

1. Copy the current lineup.
2. Remove the solver-owned entries that are not in the chosen columns, and the kept entries of swimmers whose `z` became 1.
3. Keep every surviving entry in place.
4. Append the new entries (5.1 order).

`rosterAdds` lists the free swimmers with `z = 1`.

### 8.2 Re-score

Run `scoreMeet(model, built, tagsForScoring, rules, sourcing)`. When `load` is set, also run `sessionLoad` on the result.

- `penaltyPoints` is the sum of `(races − max)·pen` over `perSwimmer` rows of own swimmers with `z = 1`.
- Never use `sessionLoad`'s `penaltyPoints`. It sums every swimmer of every team (`sessionLoad.ts:130-139`), and own entries push opponents out of finals.
- Robust mode re-scores with the robust seed pins (5.4).

### 8.3 Checks, all exact on scaled integers

1. The objective recomputed from the solver's columns equals the solver objective.
2. The re-scored objective times D equals the MIP objective. Otherwise throw `model_mismatch`, naming both numbers. No lineup is returned, and the current lineup is untouched.
3. **Hard violations**:
   - `entry_cap`, and `session_load` in respect mode, that name a swimmer with `z = 1`;
   - `scoring_team_size` for an own built side;
   - `relay_entries_over_limit`, `relay_swimmer_repeated`, and `relay_leg` with `wrong_gender`, `duplicate_swimmer`, `event_mismatch` or `basis_position`, on solver relays.

   Any of these is `model_mismatch`. Other hard violations must be a subset of the current results' violations.
4. **Warnings** are reported in `newWarnings` and never block: `relay_leg off_scoring_roster` (R77), `scorer_without_entry` (R78), and opponent `seed_time_missing`.
5. **The current lineup is feasible** when its results hold no hard violation that names a decision swimmer or an own built side.

### 8.4 Guard

| Case | Result |
| --- | --- |
| Current feasible, `best > current` | `improved` |
| Current feasible, `best = current`, proven | `unchanged`, `proven_no_better` |
| Current feasible, `best = current`, gap > 0 | `unchanged`, `none_found_within_limits` |
| Current infeasible | `current_infeasible`, with `alternative` the best feasible proposal and its signed delta (open question 3). `improved` only if strictly higher. |
| Goal seek, current reaches target | `unchanged`, `current_meets_target` |
| Goal seek, relaxed MIP infeasible | `target_unreachable`, `proven` |
| Goal seek, restricted MIP infeasible after refinement | `target_unreachable`, `within_limits` |

"Better" is measured by the mode's objective: own points, margin, robust points, or points minus penalty. Points always appear in both evaluations.

**Opponent tags stay frozen for the baseline and the proposal.** Accepting the proposal triggers a fresh opponent suggestion (D2 3.14 open question 2), so the total after Accept can differ. The engine guard cannot cover that. UI slice U1 re-suggests, re-scores, and blocks Apply when the re-scored objective is not above the re-scored current.

### 8.5 Acceptance

1. `neverWorse` (A1): 20 seeded fixtures with feasible random current lineups. Every result is `improved` or `unchanged`. For `improved`, `evaluation.objective > current.objective`, and `scoreMeet(proposal.lineup)` own total equals `evaluation.ownPoints`.
2. `unchangedSaysSo` (A1): the current lineup is the brute-force optimum. The result is `unchanged` with `proven_no_better` and no proposal.
3. `gateCatchesDrift` (A1): a stub solver returns tampered columns. The call throws `model_mismatch`.
4. `currentInfeasible` (A1): a current own swimmer is over the total cap. The result is `current_infeasible` with a feasible alternative and its delta.
5. `penaltyOwnOnly` (A3): `penaltyPoints` equals the own-only sum from `perSwimmer`, and differs from `sessionLoad.penaltyPoints` on a fixture where an opponent has an extra race.

## 9. Explanations (plan 4.2; slice A8)

```ts
export type AutoBuildExplanation =
  | { readonly kind: 'unusual_event'; readonly entryKey: string; readonly swimmerId: SwimmerId;
      readonly eventKey: EventKey; readonly gender: Gender;
      readonly place: number; readonly points: number;          // the proposal's ResultRow
      readonly seed: Hundredths; readonly estimated: boolean;   // seed swim scy.kind 'converted' gives the "est." badge (R58)
      readonly otherTeamsAhead: number;                          // standing other-team entries ranked ahead
      readonly nextOtherTeamBehind: { readonly teamId: TeamId; readonly seed: Hundredths } | null;
      readonly marginalPoints: number;                           // own(p) − own(p \ {s})
      readonly skipped: readonly { readonly eventKey: EventKey; readonly placeAlone: number;
          readonly marginalPoints: number; readonly binding: 'entry_cap' | 'session_load' | 'teammates' }[] }
  | { readonly kind: 'roster_add'; readonly swimmerId: SwimmerId;
      readonly spotsAfter: { readonly numerator: number; readonly denominator: number }; readonly marginalPoints: number };
```

An individual entry (s, e) is **unusual** when e is not among the swimmer's first n events, where n is the swimmer's number of individual entries in the proposal. The order is the singleton place (invariant 17 rule 1: the swimmer alone against other teams), then singleton points descending, then event key.

`skipped` lists the swimmer's higher-ranked events where they are not entered. `binding` is decided in this order:
1. `entry_cap`, when the swimmer is at a cap;
2. `session_load`, when adding the entry would break L1;
3. `teammates`, when their marginal points there are lower.

Every number comes from a `scoreMeet` evaluation or a model swim. The UI renders the text, for example: "Thin field: 3rd with 24.10. The next swimmer from another team is 24.52."

Acceptance:
1. `explanationFactsRederive`: every fact equals the value re-derived in the test from `Results`, the model and the column evaluations.
2. An entry in the swimmer's best events gets no explanation.
3. `estimated` is true only on converted seeds.

## 10. Fallback: local search (slice A5)

**When it runs**: only when the final MIP solve ends with `'Time limit reached'`. It never runs after `'Optimal'`.

**Seed**: the verified `incumbent` (every row is checked on its values), else the current state if feasible. With neither, nothing runs and the guard applies.

**State**: one column per event. `z` follows: free `z = 1` iff the swimmer is in some column.

**Moves**, in fixed order, taking the first strict improvement:
- (M1) replace one event's column, with events in `model.events` order and columns in index order;
- (M2) move one swimmer from event e1 to e2, where `p1 \ {s}` and `p2 ∪ {s}` both exist.

Feasibility and objective come from the MIP's integer rows and coefficients. No `scoreMeet` call is made per move. The search stops at a local optimum or at `min(2 s, remaining budget)`. Then the gate (8.3) runs. `method` is `'local-search'`. The proof keeps `UB` from the relaxed dual bound, or `unknown`.

Acceptance:
1. `localSearchNeverBelowSeed`: the result is at least the seed.
2. `fallbackOnlyAtTimeLimit`: a stub returning `'Optimal'` triggers no local search.
3. `gapWithIncumbent`: a stub returning `'Time limit reached'` with an incumbent and a dual bound reports `gap = dualBound/D − found ≥ 0`.

## 11. Worker protocol (slice A5)

Add a `solve-mip` request alongside `solve-lp`. It returns a `solved-mip` response shaped as `MipSolution` plus `id`, `loadMs` and `solveMs`. `solve-lp`, `SolvedResponse` and `optimalColumns` (`optimizerResult.ts:2-7`) do not change, so `rosterSuggest` keeps its rule.

Implementation, checked by the architect on highs 1.15.4 in Node:
1. `highs.createModel()`, then `model.readModel({ format: 'lp', data: lp })`.
2. Set the options, then `model.run()`.
3. Read `model.info.get('mip_dual_bound')`, `'mip_gap'`, `'objective_function_value'` and `'primal_solution_status'`. The value 2 means feasible.
4. Read `model.getSolution().colValue` with `model.getColName(i)`.
5. Call `model.dispose()`.

A forced 0.5 s limit gave status `Time limit reached`, dual bound 33045, incumbent 32645, and `primal_solution_status` 2. Legacy `highs.solve` also returns `Columns` at the time limit, but it gives no dual bound.

Add `optimizerClient.solveMip`.

## 12. Slices

Each slice: run its own tests while iterating, then the full gates once at the end (`npm test` and lint). Do not touch:
- the `scoreMeet` or `sessionLoad` logic;
- `rosterSuggest.ts`;
- `builtins.ts`;
- existing tests.

Exports from `results.ts` are export-only, with no behavior change.

### 12.1 A1: max-own, individual and diving, caps, size

**Owns**:
- `packages/engine/src/autobuilder/{types,support,space,evaluate,lp,solve,gate,index}.ts`;
- `packages/engine/src/index.ts` (the export block);
- `tests/engineAutoBuild.test.ts`;
- `tests/helpers/nodeMipSolve.ts` (Model API, as in section 11).

**Scope**:
- Own relays stay fixed exactly as in the current lineup. Their legs keep their current roles: a free leg stays at `z = 0`. Their counts are the constants `k_R` and `d = 0`.
- Uses the reference evaluator.
- No load rows.
- A non-Optimal final status gives `unchanged`, `none_found_within_limits`.

**Tests**: 2.2, 8.5.1 to 8.5.4, and:
1. `bruteForceMaxOwn`: 12 seeded synthetic fixtures (synthetic presets from `engineTestPresets` `set`; no competition values). Two tagged opponents, 4 or 5 own swimmers including a diver, 3 individual events and 1 diving event, a size of 3 spots at 1/3, a total cap of 2. Cover both `ties` values, plus a numeric per-event cap and an unlimited one. Enumerate every own entry set of the search space through whole-meet `scoreMeet`. The objective equals the maximum, the status is `proven_optimal`, and the proposal's re-score equals it.
2. `boundCoversOptimum`: the same fixtures with K = 1 and `refineRounds` 0. `bestFound ≤ bruteMax ≤ upperBound`.
3. `deepTeamNeedsNinth`: with K = 8 and 0 rounds, the status is `gap`. With 1 round, it is proven and the 9th swimmer is entered.
4. `noDiverDiscountFromDive`: a swimmer with swims and a dive score under a tight size limit is never counted at 1/3 while entered in an individual swim.
5. `pinsHonored`: pinned scorers stay on the roster. Pinned-off swimmers' entries are byte-identical, and they are never added. Untagged `unknown` swimmers get no new entry. `tagsForScoring` contains no `source`.
6. `orderIndependence`: permuting `model.teams`, `model.swimmers`, `model.swims` and the tags gives byte-identical LP text and a deep-equal result.
7. `orderedTiesPosition`: under `'ordered'`, a new own entry that ties an opponent loses the tie, and the column value and the gate agree.
8. `scaleExact`: three-way split ties give thirds, and the integer values are exact.
9. `fixedRelaysUntouched`.

### 12.2 A2: relays

**Owns**: `autobuilder/space.ts` (squads), `tests/engineAutoBuildRelay.test.ts`, and export-only `isRankable` and `scyValue` from `results.ts`.

**Tests**:
1. A brute force with one relay event matches.
2. `relayTrap`: one spot is left, and adding Y completes a relay worth more than X's individual points. Y is chosen.
3. Every built relay resolves with no `relay_leg` violation: medley order, leg 1 flat, legs 2 to 4 split, distinct legs.
4. Under `nsisc` v5, no own event has more than 2 relays, and there is no `relay_entries_over_limit`.
5. `disjointComplement`: all top-T squads share one swimmer, and a B relay is still built.
6. With a small T, the bound covers the brute-force optimum.

### 12.3 A3: session load

**Owns**: `autobuilder/evaluate.ts` (races), `lp.ts` (L rows), `tests/engineAutoBuildLoad.test.ts`.

**Tests**:
1. Plan F3 case under NSISC: in respect mode, no proposal has the 200 IM, the 50 free and the 200 medley relay finals on day 2. A current lineup with that load is `current_infeasible` or `improved` with the load fixed.
2. Prefer mode: a penalty below the gain takes the third race; a penalty above it does not.
3. A swimmer outside the scorer top 16 counts prelims only.
4. Split heats are assigned by seed over all entries, with held entries in place.
5. Refusals: `fastHeatSize` pending gives `pending_setting`; `cFinal` pending does not refuse; an unscheduled event refuses; dives are excluded.
6. 8.5.5.

### 12.4 A4: performance

**Owns**:
- the fast evaluator in `autobuilder/evaluate.ts`: pure arithmetic over the sorted standing field for the supported rules, which falls back to the reference for anything else;
- `tests/engineAutoBuildEvaluatorParity.test.ts`;
- `scripts/bench/autoBuildTiming.ts` (reuses `scaleTeams` from `rosterSuggestTiming.ts:77-99`).

**Tests**:
1. Parity: 2,000 random columns over configs A to D plus synthetic fields. The fast and reference evaluators give equal scaled per-team points and equal race counts.
2. Bench: config C scaled to 10 teams (16 recorded events), plus a 20-event fixture with generated values, labeled synthetic. End to end under 10 s in Node, median of 3. Record the times in the state file.

### 12.5 A5: time limit and fallback

**Owns**:
- `apps/extension/src/shared/optimizerProtocol.ts` (additive);
- `apps/extension/src/worker/optimizer.ts`;
- `apps/extension/src/dashboard/optimizerClient.ts`;
- `autobuilder/localSearch.ts`;
- tests.

**Tests**: section 10, plus the protocol tests. `solve-lp` stays byte-identical, and `columns` is `{}` unless the status is Optimal.

### 12.6 A6: margin and goal seek

**Owns**: `autobuilder/lp.ts` (M and GS rows, λ terms), `tests/engineAutoBuildModes.test.ts`.

**Tests**:
1. Margin against a team: max-own enters swimmer S in event A (+3 own), while margin mode enters S in event B (+1 own, −3 rival). The lineups differ.
2. Closest: the result equals the brute-force max-min.
3. Goal seek: the target is reached with 1 change against max-own's 4. `changeCount` equals the entry changes plus the roster adds.
4. An unreachable target gives `target_unreachable`, `proven`.
5. The margin bound covers the brute-force optimum on uneven NSISC steps.

### 12.7 A7: robust

**Owns**: `autobuilder/space.ts` (spread), tests.

**Tests**:
1. The robust swim is the slower middle of the 5 most recent swims.
2. Fewer than 3 swims gives a frozen and listed pair.
3. A simulator-only model gives `robust_no_spread`.
4. A consistent swimmer is picked over a volatile, faster one, unlike max-own.
5. The guard compares robust objectives.

### 12.8 A8: explanations

**Owns**: `autobuilder/explain.ts`, tests (section 9).

### 12.9 A9: roster swaps (R65)

Under a request flag `roster: 'propose-swaps'`, coach scorer tags become free with a current value of 1. A swap counts as a change, and `rosterRemoves` is added. A brute force over roster swaps matches. The result is never applied without the coach.

### 12.10 U1: UI (worker or Codex, against the reported API)

A run button, the result kinds, the diff, the explanations, and the proof (proven or gap). Accept writes the coach tags (R82) and the lineup. Before Apply, re-suggest the opponents and re-score; if the result is not better, Apply is blocked.

## 13. Cases a plausible build gets wrong

1. Columns over subsets of sizes 1 to 4 only. The bound is invalid and the guard loses its witness.
2. Using `sessionLoad.penaltyPoints` as the own penalty.
3. Appending new entries in evaluation but keeping them in place in the built lineup, or the reverse. Under `'ordered'` this drifts silently.
4. Dropping a free swimmer's split-final entry when they join the roster. Heats move.
5. Reading `incumbent` as an optimum, or reading `columns` at the time limit.
6. HiGHS's default `mip_rel_gap` of 1e-4.
7. A float diver weight, or the gate's looser diver rule inside the MIP.
8. Reusing the single-column rival loss as λ.
9. Opponent tags recomputed between the baseline and the proposal.
10. Robust times taken from undated simulator swims, or from converted estimates.
11. A flat-start leg on legs 2 to 4, or a flying split on leg 1.
12. Adding an `unknown`-membership swimmer.

## 14. Open questions for the user

1. **Robust spread.** Chosen: the slower middle of the 5 most recent dated SCY swims in the record range, needing at least 3. A pair with fewer swims is frozen: never added, never dropped, shown as "not enough swims". Why: it uses only real swims and invents no slowdown. The alternative, valuing those pairs at their best time, makes the solver prefer swimmers with no history.
2. **One swimmer on both the A and B relays of an event** when the preset does not forbid it (NSISC v5 leaves `relaySwimmerOncePerEvent` absent). Chosen: never. Why: no archived NSISC source allows it, NCAA 5-7-1-g forbids it for timed finals, and allowing it makes identical A and B relays.
3. **The current lineup already breaks a hard rule** (for example an 8th event under a cap of 7). Chosen: return the best legal lineup as `current_infeasible`, with its point change shown even when negative, never as "improved". The alternative is to refuse until the coach fixes the current lineup.
4. **Diver weight for a swimmer who both dives and swims.** `scoreMeet` counts them at 1/3 when they swim no relay (`results.ts:1002`). Its own comment says only all-diving swimmers count at 1/3 (`:980`). Chosen: the AutoBuilder uses the strict rule, so it never relies on the 1/3. Which rule is correct for NSISC?
5. **Legs 2 to 4 without a flying split.** Chosen: not built, until the flyover setting (R14) lands. Current relays that use flat starts on those legs are still kept as candidates. The alternative is SwimCloud's aggregate: use the flat-start time and accept the `basis_position` flag.

## 15. Findings about the existing code

1. `results.ts:980` (comment) and `:1002` (code) disagree on who is a diver. `rosterSuggest.ts:726` copies the code's rule.
2. `sessionLoad.ts:130-139` sums `penaltyPoints` over every swimmer of every team. Any display of it as the own team's penalty is wrong.
3. D2 3.11 shows `rules?` as optional and describes the behavior when it is absent. `sessionLoad.ts:21` requires `rules`. The `rules ?`/`!rules` branches at `:75-77` and `:93` cannot run under the type.
4. `optimizerResult.ts:2-3` discards incumbents by design. A gap needs the Model API (section 11).
5. Simulator swims carry no date, so robust mode depends on the history fetch (R50, R68).

## D5 amendment 1 (2026-10-29): budget, solve order, A1 rulings

This amendment replaces D5 6.3 items 3 to 5. It adds 6.4 and 6.5, and it changes `AUTOBUILD_DEFAULT_LIMITS`.

### 6.3 (replacement) Solve sequence

`timeLimitSeconds` is **wall time**. It runs from entry to `autoBuild` until it returns, and it includes column evaluation, every solve and the gate. Measure it with `req.clock` (milliseconds, monotonic; default `performance.now`). Set the deadline to `start + timeLimitSeconds·1000`, and keep a gate reserve `R_g = 1000 ms`. Let `left()` be `deadline − R_g − clock()`. HiGHS overshoots its own limit (13.2 s on a 9.6 s limit), so every solve gets `time_limit = 0.75 · allotment / 1000`. Skip any stage whose allotment is below 200 ms.

1. **Restricted solve first: the safety net.** It uses the K-columns and fixes `o` and `oR` at 0. Its allotment is `0.5 · left()`. The current column is present, so any Optimal result or incumbent is a real lineup. A verified incumbent passes the gate with `method: 'mip-incumbent'`. That is allowed from A1 on. The local search stays in A5.
2. **Relaxed solve.** Its allotment is `left()`.
   - Optimal with no outside term active: the result is proven. If its objective is above the restricted solve's, its solution replaces it.
   - Otherwise: `UB` is the objective, or `dualBound` at the time limit.
3. **Refinement round.** It runs only if the estimate fits. The estimate is (new columns × measured milliseconds per column so far) + 1 s, and it must be below `left()`.
   - Each refined event gains at most 2 of its active outside swimmers, up to `K_max`, or doubles T up to `T_max`.
   - Then repeat steps 1 and 2 on the grown model: restricted first, then relaxed.
   - A round never discards the best real lineup found so far.
4. **Tie-break.** It runs only if `left() ≥ 2000 ms`, with allotment `left()`. On a time limit, keep the lineup from before the tie-break and record the stage.
5. **Gate and guard** (section 8) on the best real lineup. With no real lineup, return `unchanged` with `none_found_within_limits`.

Order of preference for the final lineup: the proven relaxed solution, then the best restricted Optimal result, then the best verified incumbent.

### 6.4 Default limits

`AUTOBUILD_DEFAULT_LIMITS = { candidatesPerEvent: 8, maxCandidatesPerEvent: 10, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 1, timeLimitSeconds: 10 }`

Why each value changed:
- **The order.** On config C (team 58, Men, 22 events, 42 own swimmers), `refineRounds: 0` returned `improved` (43 to 1214) in 2.3 s of wall time. The restricted-first order therefore secures a real lineup early, and the rest of the budget goes to the bound.
- **One round.** One refinement round proved 1251, but only with a 30 s budget. Two rounds used up 19 s and returned nothing. So the default is one round, run only when it fits.
- **`K_max` 10.** It caps a refined event at 1,024 columns, against 4,096 at 12. Growth to `K_max` 12 drove the roughly 5 s of evaluation. (Since A4 the fast evaluator removed that cost. `K_max` 10 still holds because the solver cannot use the extra columns inside 10 s: a sweep with `K_max` 12 found 736 points against 1435, see the state file D5.A4 entry.)

The F4 target of "a 10-team, 20-event meet under 10 s" stays. With these defaults, a positive gap within the limit is acceptable, and the result reports it.

### 6.5 Rulings on the A1 deviations

- **(a) Accepted.** Z2 becomes `z[s] − Σ_e x[s,e] − Σ_e o[s,e] − Σ_e w[s,e] ≤ 0`. Without the `o` and `w` terms, a free swimmer with only outside pairs is forced to `z = 0`. The relaxation would then not be a relaxation, and `UB` would be invalid. Add the case to `boundCoversOptimum`.
- **(b) Accepted.** The witness checks (6.3.6 infeasible means mismatch; 6.3.7 optimum below current means mismatch) apply only when the current lineup is gate-feasible and also fits the strict diver weight (4.4). A lineup that is gate-feasible but breaks the strict rule is guarded normally. If the MIP best is not above it, return `unchanged` with `none_found_within_limits`. The proof then lists `strict_diver_weight` as binding (a new boolean `binding` on the restriction entry, which is additive).
- **(c) Accepted.** The 4.9 tie-break is minimal within the columns actually built. It is a tie-break, not a guarantee, so say so in the proof doc comment. The current column is never pruned, so a zero-change tie is always reachable.
- **(d) Accepted.** This is D5 12.1 as written. A2 removes it.
- **(e) Keep D5's limit: at most 4 decimals (`decScale ≤ 10^4`).** `rosterSuggest.ts:163` multiplies while `decScale ≤ 10000`, so it accepts 5 decimals (scale 10^5), while its error message says "more than 4". That is a `rosterSuggest` finding, not a reason to change D5. The lead should record it, and `rosterSuggest` stays untouched in P6.
- **(f) Accepted, all additive:**
  - `MipSolution.seconds?`: the solver-reported time, diagnostic only. Budgeting uses the clock.
  - `AutoBuildRequest.clock?: () => number`.
  - Proof timing fields are null only for a stage that did not run.
  - Restriction `'fixed_relays'`: A1 only. A2 replaces it with `'fixed_relay_events'`: a relay event stays as entered when any current own relay in it has a leg who is not a decision swimmer (amendment 2, 3.4).

### 8.5 (added acceptance)

6. `defaultLimitsConfigC`: config C through `buildSnapshot` and `adaptSimulatorSnapshot`, `nsisc` v5, own team 58, Men, max-own, `AUTOBUILD_DEFAULT_LIMITS`, the real clock, and the Node `MipSolve`. Expect:
   - kind `improved`;
   - `evaluation.ownPoints` at least the own points of the same request with `refineRounds: 0`, run with `timeLimitSeconds: 60` in the same test;
   - `proof.bestFound ≤ proof.upperBound`;
   - wall time `≤ (timeLimitSeconds + 1) · 1000` ms.
7. `restrictedFirstSafetyNet`: a stub solver returns `Optimal` for the restricted solve and `'Time limit reached'` with no incumbent for the relaxed solve. Expect `improved`, with proof status `unknown` or `gap`.
8. `clockBudget`: a fake clock advances 1 s per evaluated event and 2 s per solve. Expect:
   - every `time_limit` passed is at most `0.75 · allotment`;
   - stages past the deadline are skipped, in the order refinement, then tie-break;
   - the result still holds the restricted lineup.
9. `tieBreakSkippedWhenLate`: with `left() < 2000` ms after the relaxed solve, no tie-break solve is issued, and `proof.solves` shows no `'tie-break'` stage.
10. `incumbentGated`: a stub restricted solve returns `'Time limit reached'` with an incumbent. Expect `method: 'mip-incumbent'`. A tampered incumbent throws `model_mismatch`.

### D5 amendment 1a (2026-10-29, lead rulings on the A1 build)

- **Clock.** The engine stays pure: the purity gate bans `performance.now` in `packages/engine`. `req.clock` is injected by the caller, and the extension passes `performance.now`. With no clock, the budget counts only the solver-reported seconds (`MipSolution.seconds`). The proof's evaluation and gate timings are then null, which is the one other case where a timing may be null.
- **Final lineup.** The highest objective that passes the gate wins. The order in 6.3 (proven relaxed, then restricted Optimal, then verified incumbent) breaks ties only. A verified incumbent passes the same gate (8.3) as an optimum, so returning a lower-scoring Optimal lineup would throw away points.
- **`binding`.** It lives in `proof.searchSpace.restrictionStatus: { restriction, binding }[]`. `restrictions` stays a string array.
- **Proof of a gated incumbent.** A verified incumbent whose objective equals a valid upper bound is proven optimal, with `proof.status` `'proven_optimal'` and `method` still `'mip-incumbent'`. The bound, not the solver status, carries the proof (section 0 item 3). "An incumbent is never an optimum" means the engine never trusts a timed-out solve's status. It does not rule out a certificate. (Codex J9 review raised the case; the lead ruled it correct.)

## D5 amendment 2 (2026-10-29): relay rulings for slice A2

### 3.4 (amend) Restriction `fixed_relay_events` replaces `fixed_relays`

Replace the D5:716 sentence ("A2 removes it") with this rule. A relay event stays fixed when any current own relay in it has a leg who is not a decision swimmer: pinned off, untagged with `unknown` membership, or outside `S_g`.

- In a fixed event, every own relay stays byte-identical.
- Its legs keep their current roles.
- Their entries count in `k_R` and `k_T`, and they set `d = 0`.
- The event gets no columns and no `oR` slot.
- `proof.searchSpace.restrictions` lists `'fixed_relay_events'` once. Add an additive `fixedRelayEvents: { eventKey, gender }[]` beside it.
- A free leg (untagged member) is a decision swimmer, so it does not fix its event.

Why the whole event: R and the letters are counted per event. Mixing fixed relays and solver relays in one event would make both depend on entries the solver cannot move.

Test `fixedRelayEvent`: one event's relay has an exhibition-tagged leg, and another event's relay has only decision legs.
- The first event's own relays are deep-equal to the current ones.
- The second event is built.
- `fixedRelayEvents` names only the first event.

### 3.3 (amend) A current relay column over the limit

The current squads are always in `Q_e`. So every set of at most R pairwise-disjoint current squads is an ordinary column, and that is the repair. The full current column, with more than R squads, follows two rules.

- **Selectable only when it is legal.** Exclude it when `entries.nonScoringRelaysAllowed` is false: its selection would raise `relay_entries_over_limit`, a hard violation. The current lineup is then infeasible (8.3), and the guard returns `current_infeasible` or `improved`. When the rule is absent or true, keep the column. Its extra relays are legal entries, and `scoreMeet` values them exactly.
- **Repeated swimmers.** When current squads share a swimmer, E2 for relays uses multiplicity: `Σ_p mult_p(s)·y[e,p] = x[s,e]`, with `x` a general integer in `0..max mult`. Z1 becomes `x − mult_max·z ≤ 0`, and C2 and C3 count `x` as it is.

Tests:
1. `overLimitCurrentV5`: under `nsisc` v5 with 3 current relays in one event, the result never holds 3 own relays there. The kind is `current_infeasible` or `improved`, and there is no `model_mismatch`.
2. `overLimitCurrentAllowed`: the same fixture with the rule absent can return `unchanged` with the current column.

### 3.2 (amend) Current legs with bad bases

A current squad keeps its entry object, letter and bases, including a flat start on legs 2 to 4, an `event_mismatch` leg, or `no-time`. It may appear in any column. New squads still use only the 3.2 bases.

### 8.3 (amend) Hard and carried violations

8.3 item 3 applies to **new** relay entries only. A `relay_leg` violation on a surviving current relay entry is carried: it falls under the subset rule.

Test `badBasisSurvives`: a current relay with a flat start on leg 3 is kept when it is best. No `model_mismatch` follows, and no new relay has a `relay_leg` violation.

### `proof.searchSpace.events` for relays

- `candidates` is `|Q_e|`, the squad count.
- `outside` is 1 when an outside squad exists (`tauOut !== null`), else 0.
- `columns` is the column count.

State these meanings in the field doc comments. No test is needed beyond a field check in an existing relay test.

### 3.2 (amend) Remove legs with no relay capacity left

Before squad generation, drop from every position's options any decision swimmer with `cap_R − k_R(s) ≤ 0` or `cap_T − k_I(s) − k_R(s) ≤ 0`, where `k_I` and `k_R` count only fixed entries.

This is exact. C2 and C3 already forbid `x[s,e] = 1` for such a swimmer, so no feasible lineup uses a squad that holds them. Compute `tau_out` over the remaining universe; the bound stays valid because the removed squads are infeasible. The current squads stay in `Q_e` even when they hold such a swimmer, so the current state remains representable.

Test `cappedLegsDoNotCrowdQ`: the top 12 squads of an event all hold a swimmer whose relay cap is used up by a fixed relay. A feasible relay exists among the other swimmers. With default limits, the result is `improved` and holds that relay. The same fixture before this rule returned `unchanged` with `none_found_within_limits`.

## Amendment 3 (lead rulings, 2026-10-30, slice A5)

1. **Local search seed.** Section 10 stands. Seed from the verified
   incumbent, else from the current lineup when it is feasible. There is
   no opt-in flag. A test stub that reports a dual bound below a reachable
   objective is an invalid fixture and may be corrected.
2. **Session load outside the decision set under `respect`.** The load
   limit binds decision swimmers only: the own swimmers the AutoBuilder may
   move. Opponents and fixed own swimmers (non-members, non-scorer roles,
   free swimmers on fixed relay events) are outside it. A build can still
   change their race counts, so a fixed own swimmer can go over the limit
   with only a warning. User question A7 asks whether that is acceptable. Own entries can move an opponent between
   sessions, for example into or out of a final (section 8.2). A
   `session_load` violation that names a swimmer outside the decision set
   is never hard and never a `model_mismatch`. If the current lineup does
   not have it, the result lists it as a new warning.
3. **Scale changes.** When refinement changes the scale, every stored
   objective that is compared across solves (the incumbent, `beaten`) is
   rescaled first.
4. **A bounded local search with no clock** (Codex J14). With no
   `req.clock` the engine cannot measure the 2 s allotment (section 13
   "Clock"). The local search therefore also stops at a fixed evaluation
   cap, in every mode, so the stage is always bounded. A cap stop reports
   the same `budget` stop as a clock stop.

## Amendment 4 (lead rulings, 2026-10-30, slice A6)

1. **Goal seek with `prefer` load is refused.** Section 4.7 does not say
   whether the target counts the penalty (user question A8). The refusal is
   `mode_not_built` with subject `goal-seek-prefer`. Goal seek itself is
   built; only this pairing is not.
2. **`closest` has no local-search fallback.** Its margin is a minimum over
   teams, which no column choice derives. A timeout with no incumbent gives
   `unchanged`, `none_found_within_limits`.
3. **Goal seek over a current lineup that breaks a hard rule.** When the
   relaxed MIP is infeasible the result is `target_unreachable`, `proven`:
   no legal lineup reaches the target. It does not also say the current
   lineup is infeasible. User question A3 settles that.
4. **Goal-seek proof fields.** The solver maximizes minus the change count.
   `proof.bestFound` is the positive change count, and `proof.upperBound`
   holds a lower bound on changes. U1 labels them by that meaning.

## Amendment 5 (lead rulings, 2026-10-30, slice A7)

1. **Frozen current entries of free swimmers are held, not fixed.** Section
   5.4 says `x = 1`. The build uses the 4.6 held-entry mechanism (`x = z`)
   instead: the entry stays in the lineup whatever the swimmer does, scores
   at its normal seed only if the swimmer joins, and never forces a roster
   add. Pinned scorers keep `x = 1` through `frozenIn`.
2. **Entries with no usable time.** A pair with no usable normal seed has
   no value in any mode, so it is not frozen and not listed. Max-own drops
   such a current entry as replaced too. User question A9 asks whether to
   keep them.
3. **Column pruning** counts only droppable members against the event cap.
   A frozen or held member cannot be removed, so a column that adds a
   faster swimmer beside it stays reachable. Max-own has no frozen entries
   and is unaffected.
4. **Public surface for U1.**
   - `proof.searchSpace.frozenPairs` is required, and `[]` outside robust.
     Render each as "not enough swims (n)".
   - The restriction `robust_frozen_pairs` has `binding: false`.
   - `robust_no_spread` (subject `robust`) when no decision pair has a
     robust swim, for example a simulator-only model with no dated swims.
   - `limits_invalid` with subjects `objective.recentSwims` and
     `objective.minSwims`; integers with 1 ≤ min ≤ recent ≤ 20.
   - `evaluation.robustOwnPoints` is set in robust mode only. `ownPoints`,
     `results` and `load` use normal seeds.

## Amendment 6 (lead rulings, 2026-10-30, slice A8)

1. **Seeds.** Every explanation fact uses normal seeds, in every mode. A
   robust proposal carries no pins, so the facts describe the lineup the
   coach would enter.
2. **`marginalPoints`** is own points in every mode, including margin,
   closest and goal seek.
3. **Who is explained.** Decision swimmers who are tagged scorers or join
   in the proposal. An entry with no place gets no explanation.
4. **`binding`** replaces the three values of section 9. It is decided in
   this order: `entry_cap`; `session_load` (respect mode only);
   `strict_diver_rule`; `load_penalty` (prefer mode only: the entry adds
   points, and the extra penalty is at least those points; an entry that
   adds no points falls through to `teammates`); then, by the own marginal at the
   skipped event: at or below 0 gives `teammates` (the spec's meaning); above
   0 gives `search_limit` when the mode is max-own, the proof is not
   `proven_optimal`, or the pair was outside the candidates (or frozen),
   else `objective` (the mode's objective prefers the entered event: rival
   points, robust value, or fewer changes). `strict_diver_rule` is the
   AutoBuilder's conservative count (section 4.4, user question A4), never a
   meet rule: `scoreMeet` raises no `scoring_team_size` violation for it,
   and `roster_add.spotsAfter` uses `scoreMeet`'s count.
   A frozen robust pair also reads `search_limit`, but no run length enters
   it: U1 shows a skip whose pair is in `proof.searchSpace.frozenPairs` as
   "not enough swims (n)", never as "a longer run may enter it".
5. **`roster_add.marginalPoints`** removes the swimmer's individual entries
   and every relay they swim.
6. **`otherTeamsAhead`** counts other-team entries, not teams. A tie is
   neither ahead nor behind.
7. **`estimated`** is true when the entry names a converted seed swim, or
   when every swim at the seed value is converted.
8. **Order.** `roster_add` first by swimmer id, then `unusual_event` by
   swimmer id and entry key. `skipped` is in ranking order.
9. **Failure.** A mismatch inside `explain` throws `model_mismatch`, like
   the gate: it means the scoring is inconsistent.
10. **Timing.** `proof.timings.explainMs` (required). It is `null` with no
    clock, or when no proposal was explained. An explain run that finds no
    unusual entries still reports its time. Explanations add about 0.4 s on config C.

## Amendment 7 (architect decision, 2026-10-31): where `autoBuild` runs (U1)

1. **A dedicated `autobuilder.worker`**, owned by the dashboard page (the tab
   or the docked iframe), runs all of `autoBuild`. It loads its own HiGHS and
   calls `solveMipOn` (`worker/optimizerSolve.ts`) directly. `optimizer.worker`
   does not change and keeps serving `rosterSuggest` and opponent re-suggests.
   Reasons: on the dashboard main thread the synchronous evaluation, local
   search, gate and explain freeze the port handler and the docked panel
   (`main.tsx:7`); inside `optimizer.worker` a build blocks every other solve
   for about 6 s, and Cancel (`terminate()`) would reject them too
   (`optimizerClient.ts:260-264`); `optimizer.ts:12` says that worker builds no
   lineup model.
2. **Protocol** in a new `shared/autobuilderProtocol.ts` (type-only engine
   imports; `optimizerProtocol.ts` must import nothing):
   - `auto-build {id, request: Omit<AutoBuildRequest,'clock'>, clock: 'wall'|'none'}`.
     The worker sets the clock (`'wall'` = `performance.now`). A request that
     still holds a `clock` function is refused before `postMessage`.
   - `auto-build-progress {id, solvesDone, elapsedMs, limitMs}`, one per
     `MipSolve` call. No stage names.
   - `auto-build-done {id, result, loadMs, wallMs}`.
   - `auto-build-error {id, source: 'autobuild'|'score'|'internal', code,
     subject, message}`: `code` and `subject` are copied, because an Error
     keeps only name and message across `postMessage`.
   - No cancel message: the client calls `terminate()`, rejects with
     `'cancelled'`, and starts a fresh worker on the next run. Never use the
     kind `plan-lineup` (`probeUnsupported` relies on it).
3. **U1 builds against** `createAutoBuildClient(): { run(req, onProgress):
   Promise<AutoBuildResult>; cancel(): void }`. One run at a time. The UI
   lives in the dashboard. The page panel gets only `auto-build-status
   {status, elapsedMs, limitMs}` (additive `panelProtocol.ts` kind). Each
   result is tagged with its source snapshot; Apply is blocked when the
   snapshot changed, and before Apply U1 re-suggests the opponents through
   `optimizer.worker` and re-scores.
4. **Acceptance for the wiring:**
   1. the worker module in Node with a fake scope, `clock: 'none'`, a
      generous limit and `refineRounds: 0`, equals a direct `autoBuild` with
      `nodeMipSolve`, timing fields aside. This test also settles an open
      observation: one architect run saw a different result from a
      `structuredClone`d request (likely timing, unproven);
   2. a request holding `clock` is refused;
   3. an `AutoBuildError` arrives as `auto-build-error` with the same code
      and subject;
   4. progress arrives in order and `solvesDone` equals the number of
      `MipSolve` calls. (Ruling, U1-a: when local search runs, `proof.solves`
      holds one more record, which is not a `MipSolve` call.)
   5. `cancel()` rejects the run, an `optimizer.worker` `solveLp` in flight
      still resolves, and the next run works;
   6. the worker is in `build.config.mjs`, `extensionBuildFreshness.test.ts`
      and the T-B7 list (`extensionBundleBoundaries.test.ts`); T-B5 and T-B8
      pass; the bundle holds no `@omniswim/swimcloud`;
   7. the `optimizer.worker` protocol tests pass unchanged;
   8. the Chromium harness: the docked iframe runs a build, Cancel ends it,
      and the page panel shows the status.
5. **Risks:** two HiGHS instances (memory; `loadMs` per new worker); a tab and
   a docked iframe can each run a build, so Apply goes through the storage
   layer's last-write rule; wall-clock results vary with CPU load.

## Amendment 8 (lead rulings, 2026-10-30, slice A9)

1. **Opt-in.** `AutoBuildRequest.roster?: 'fixed' | 'propose-swaps'`. Absent
   or `'fixed'` keeps every earlier slice. Any other value is refused as
   `limits_invalid` with subject `roster`. Under `'propose-swaps'`, a
   coach-tagged scorer of a built gender who is not on a fixed own relay is
   swappable: they start on the roster, and a removal counts as one change.
2. **Output.** `AutoBuildProposal.rosterRemoves` is required (empty unless
   swaps are on), sorted by swimmer id. `changeCount` is roster adds plus
   roster removes plus entry changes. `tagsForScoring` drops the scorer tag
   of each removed swimmer. A new explanation kind, `roster_remove
   {swimmerId, spotsAfter, marginalPoints}`, follows every `roster_add`.
   U1-b must handle it.
3. **A removed scorer's entries stay** in the lineup as non-scorer entries.
   A relay that loses them as a leg is rebuilt (R71). Held split entries
   and frozen robust entries still hold in a flagged run.
4. **An entryless swappable scorer** may stay on the roster, as today (R78
   only warns). With no Z2 the solve is indifferent to their `z` while the
   size row has slack, so the gate restores removals (item 5).
5. **Gate, two phases.** First the raw solver assignment is built and
   checked against `mipPoints` and the hard rules, as before. Then, except in
   goal seek, the gate restores removals in swimmer-id order. It accepts a
   restore when the strict team-size count (4.4) holds, the restore adds no
   hard violation that the lineup without it lacks (session load under
   `respect` and the entry caps are checked for swimmers on the roster), and
   the mode's objective does not drop. Only the tag comes back. The entries
   stay as built under the removal, so a relay rebuilt without the swimmer
   stays rebuilt. Goal seek is excluded because it minimizes changes and its
   change count must equal the solver's.
6. **The final candidate is the proposal.** Its score drives the
   evaluation, the explanations and the improved or unchanged call. The
   proof re-bases `bestFound` and `gap` on it. `proven_optimal` holds only
   when that score equals the bound. A score above the solver's bound means
   the model and `scoreMeet` disagree, and throws `model_mismatch`.
7. **The synthetic anchor swimmer** gets an id unused by any model swimmer,
   swim, split, tag or lineup entry: `'\u0000anchor'`, extended with
   `'\u0000'` until unused.
8. **User question A10** (what Accept writes for a removal) stays open. U1
   asks at Accept time, with "tag them non-scorer" preselected.

## Amendment 9 (lead rulings, 2026-10-30): the column prune

1. **Rule.** Under a numeric `removed-from-consideration` per-event cap, a
   column is pruned only when more than `cap` of its members have no current
   entry in the event and can be dropped (not frozen, not held). At most
   `cap` members score, so one of them is over the cap. The column without
   that member has the same points, no more races, and one change fewer.
   The old rule also counted members with a current entry. It pruned
   columns that avoid the change of dropping that entry, and goal seek could
   then report one change too many with a `proven_optimal` status.
2. **Exclusions.** A diving event is never pruned when the team size is
   finite. A dive entry that scores nothing still changes the strict diver
   weight (4.4), so the column that keeps it can be the only feasible one. A
   split event is never pruned under load (as before).
3. **Result.** The prune loses no optimal lineup, so the fewest-changes
   tie-break (4.9) is exact within the space. Under a numeric cap, proposals
   can differ from before: when G beats F, the proposal keeps F's entry,
   because dropping it is a second change that buys nothing.
4. **Real meets.** The shipped NSISC v5 preset has no numeric removal cap,
   so the prune does not run there, and config C results do not change.
