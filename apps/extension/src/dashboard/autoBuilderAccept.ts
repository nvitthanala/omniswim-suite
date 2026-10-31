/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Accept for an AutoBuilder proposal (plans/2026-10-25/D5-AUTOBUILDER.md 12.10, amendments 7 and 8; user questions G1 and A10).
 *
 * Accept never writes an entry into the SwimCloud simulator (D4: the extension writes settings, not entries). It does three things:
 * 1. blocks, with a reason, when the result is stale or the proposal is not better after a fresh re-score;
 * 2. saves the coach scorer tags and the proposed lineup in the extension (the 'tags' and 'lineups' stores);
 * 3. returns the entry changes as a list the coach makes in SwimCloud.
 *
 * The blocks, in order: no proposal; the simulator snapshot changed since the run; the stored tags, team or rules changed since the run;
 * opponents could not be re-suggested; the fresh score could not be computed; the re-scored proposal is not above the re-scored current
 * lineup. The last check uses the objective's metric (own points, a margin, or the closest margin) and, in goal seek, also the target.
 * A `current_infeasible` alternative skips the last check: it exists to leave a lineup that breaks a rule, not to score more.
 */
import { scoreMeet } from '@omniswim/engine';
import type { AutoBuildObjective, AutoBuildProposal, LpSolve, Results, ScorerTag } from '@omniswim/engine';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { readScorerOwnTeam, readScorerRulePreset, resolveRulePreset, ChangeRevMovedError, StaleWriteError, toSwimCloudId } from '../storage';
import type { LineupRecord, PutManyOp, StorageRepo, TagRecord } from '../storage';
import { readCoachTags, snapshotKey } from './autoBuilderRequest';
import { changeLines, modeLabel, plain, proposalOf, signed } from './autoBuilderResult';
import type { ChangeLine, TaggedResult } from './autoBuilderResult';
import { suggestedTags, suggestOpponentRosters } from './suggestedRosters';

/** What Accept writes for a swimmer the proposal takes off the scoring roster (user question A10). */
export type RemoveChoice = 'non-scorer' | 'delete';

/** "Tag them non-scorer" is preselected (amendment 8 item 8). */
export const DEFAULT_REMOVE_CHOICE: RemoveChoice = 'non-scorer';

/** One choice per removed swimmer, all preselected. */
export function defaultRemoveChoices(proposal: AutoBuildProposal): ReadonlyMap<string, RemoveChoice> {
  return new Map(proposal.rosterRemoves.map((r) => [String(r.swimmerId), DEFAULT_REMOVE_CHOICE] as const));
}

/** The synchronous block: no proposal, or a snapshot that is no longer the run's. `null` means this check passes. */
export function acceptBlock(tagged: TaggedResult, currentSnapshot: SimSnapshot): string | null {
  if (proposalOf(tagged.result) === null) return 'There is no proposal to accept.';
  if (snapshotKey(currentSnapshot) !== tagged.snapshotKey) return 'The SwimCloud simulator changed after this run, so the proposal may no longer fit. Run the AutoBuilder again.';
  return null;
}

/** The value of the objective on a scored meet, in points. Margin modes subtract the rival's points. */
export function metricValue(objective: AutoBuildObjective, results: Results, own: string): number {
  const points = (teamId: string): number => (results.teams.find((t) => String(t.teamId) === teamId) as { points: number } | undefined)?.points ?? 0;
  const ownPoints = points(own);
  const rival = objective.kind === 'goal-seek' ? (objective.target.kind === 'margin' ? objective.target.rival : null) : objective.kind === 'margin' ? objective.rival : null;
  if (rival === null) return ownPoints;
  if (rival.kind === 'team') return ownPoints - points(String(rival.teamId));
  const others = results.teams.filter((t) => String(t.teamId) !== own).map((t) => t.points);
  return ownPoints - (others.length === 0 ? 0 : Math.max(...others));
}

export interface Verified {
  readonly ok: true;
  readonly current: number;
  readonly proposal: number;
}
export interface Refused {
  readonly ok: false;
  readonly reason: string;
}

export interface AcceptDeps {
  readonly repo: StorageRepo;
  /** The solver of `optimizer.worker`, for the opponent re-suggest. */
  readonly solveLp: LpSolve;
  /**
   * The snapshot the page holds now. Pass a getter: Accept awaits for seconds, and it reads this again right before it writes.
   * A plain value is the snapshot at the call, and cannot show a change that happens during Accept.
   */
  readonly currentSnapshot: SimSnapshot | (() => SimSnapshot);
  readonly now: () => string;
  readonly newId: () => string;
}

const snapshotNow = (deps: AcceptDeps): SimSnapshot => (typeof deps.currentSnapshot === 'function' ? deps.currentSnapshot() : deps.currentSnapshot);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Did the stored tags, own team or rules change since the run? A reason, or `null`. */
async function inputsChanged(tagged: TaggedResult, repo: StorageRepo): Promise<string | null> {
  const { inputs } = tagged;
  const coachTags = await readCoachTags(repo, inputs.meetKey);
  if (!same(coachTags, inputs.coachTags)) return 'Your scorer tags changed after this run. Run the AutoBuilder again.';
  const own = await readScorerOwnTeam(repo, inputs.meetKey);
  if (own === undefined || String(own) !== inputs.ownTeamId) return 'Your team changed after this run. Run the AutoBuilder again.';
  const ref = await readScorerRulePreset(repo, inputs.meetKey);
  if (ref === undefined || !same(ref, inputs.ruleRef)) return 'The scoring rules changed after this run. Run the AutoBuilder again.';
  const rules = await resolveRulePreset(repo, ref);
  if (!rules.found || !same(rules.value, inputs.rulePreset)) return 'The scoring rules changed after this run. Run the AutoBuilder again.';
  return null;
}

/** The code of an engine error, when there is one. */
const codeOf = (cause: unknown): string => (typeof (cause as { code?: unknown })?.code === 'string' ? ` (${(cause as { code: string }).code})` : '');

/**
 * Re-suggest the opponents through `optimizer.worker`, then score the current lineup and the proposal under the fresh opponent tags.
 * The proposal must be above the current lineup on the objective's metric.
 */
export async function verifyProposal(tagged: TaggedResult, proposal: AutoBuildProposal, deps: AcceptDeps): Promise<Verified | Refused> {
  const { inputs, request } = tagged;
  let suggestions;
  try {
    suggestions = await suggestOpponentRosters(snapshotNow(deps), inputs.meetKey, inputs.ownTeamId, inputs.coachTags, inputs.rulePreset, deps.solveLp);
  } catch (cause) {
    return { ok: false, reason: `Could not re-suggest the opponent rosters: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const bad = suggestions.find((s) => s.result.kind !== 'suggested');
  if (bad !== undefined) {
    const why = bad.result.kind === 'error' ? `error ${bad.result.code}` : bad.result.kind === 'absent' ? bad.result.reason : 'no roster';
    return { ok: false, reason: `Could not re-suggest the roster of team ${bad.teamId} (${bad.gender}): ${why}. Accept needs a fresh opponent roster to re-score.` };
  }
  const fresh = suggestedTags(suggestions);
  const coachOnly = (tags: readonly ScorerTag[]): ScorerTag[] => tags.filter((t) => t.source !== 'suggested');
  let before: Results;
  let after: Results;
  try {
    before = scoreMeet(request.model, request.lineup, [...coachOnly(request.tags), ...fresh], request.rules, request.sourcing);
    after = scoreMeet(request.model, proposal.lineup, [...coachOnly(proposal.tagsForScoring), ...fresh], request.rules, request.sourcing);
  } catch (cause) {
    return { ok: false, reason: `The fresh score could not be computed${codeOf(cause)}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const current = metricValue(request.objective, before, inputs.ownTeamId);
  const proposed = metricValue(request.objective, after, inputs.ownTeamId);
  if (tagged.result.kind === 'current_infeasible') return { ok: true, current, proposal: proposed };
  if (request.objective.kind === 'goal-seek' && proposed < request.objective.target.points) {
    return { ok: false, reason: `With fresh opponent rosters the proposal scores ${plain(proposed)}, below the target of ${plain(request.objective.target.points)}. It is not accepted.` };
  }
  if (!(proposed > current)) {
    return { ok: false, reason: `With fresh opponent rosters the proposal scores ${plain(proposed)} against ${plain(current)} for your current lineup (${signed(proposed - current)}). It is not above the current lineup, so it is not accepted. Run the AutoBuilder again.` };
  }
  return { ok: true, current, proposal: proposed };
}

export type AcceptOutcome =
  | { readonly kind: 'blocked'; readonly reason: string }
  | {
      readonly kind: 'accepted';
      readonly lineupId: string;
      readonly lineupName: string;
      /** The re-scored values the check compared. */
      readonly verified: Verified;
      readonly tagsWritten: readonly TagWrite[];
      /** What the coach does in SwimCloud. */
      readonly changes: readonly ChangeLine[];
    };

export interface TagWrite {
  readonly swimmerId: string;
  readonly teamId: string;
  readonly action: 'scorer' | 'non-scorer' | 'deleted';
}

/** The put op for one tag at the rev read now, or a create. */
async function tagPut(repo: StorageRepo, row: Omit<TagRecord, 'rev' | 'updatedAt'>): Promise<PutManyOp> {
  const current = await repo.get('tags', [row.meetKey, row.teamId, row.swimmerId]);
  return { op: 'put', store: 'tags', record: row, expectedRev: current.found ? current.value.rev : 'new' };
}

/**
 * The tag ops a proposal implies (R82): a scorer tag for each roster add, and for each roster remove the choice of user question A10
 * (`non-scorer` by default, or delete the tag). Each op carries the rev read now, so `putMany` refuses the whole batch if a tag changed
 * after this read. Tags the proposal does not touch are not in the list.
 */
export async function planRosterTags(repo: StorageRepo, meetKey: string, proposal: AutoBuildProposal, choices: ReadonlyMap<string, RemoveChoice>): Promise<{ readonly ops: readonly PutManyOp[]; readonly writes: readonly TagWrite[] }> {
  const ops: PutManyOp[] = [];
  const writes: TagWrite[] = [];
  for (const add of proposal.rosterAdds) {
    const teamId = toSwimCloudId(String(add.teamId));
    const swimmerId = toSwimCloudId(String(add.swimmerId));
    ops.push(await tagPut(repo, { meetKey, teamId, swimmerId, role: 'scorer' }));
    writes.push({ swimmerId, teamId, action: 'scorer' });
  }
  for (const remove of proposal.rosterRemoves) {
    const teamId = toSwimCloudId(String(remove.teamId));
    const swimmerId = toSwimCloudId(String(remove.swimmerId));
    const choice = choices.get(String(remove.swimmerId)) ?? DEFAULT_REMOVE_CHOICE;
    if (choice === 'non-scorer') {
      ops.push(await tagPut(repo, { meetKey, teamId, swimmerId, role: 'non-scorer' }));
      writes.push({ swimmerId, teamId, action: 'non-scorer' });
    } else {
      const current = await repo.get('tags', [meetKey, teamId, swimmerId]);
      if (current.found) ops.push({ op: 'delete', store: 'tags', key: [meetKey, teamId, swimmerId], expectedRev: current.value.rev });
      writes.push({ swimmerId, teamId, action: 'deleted' });
    }
  }
  return { ops, writes };
}

/** Write the tags of `planRosterTags` in one all-or-nothing batch. */
export async function writeRosterTags(repo: StorageRepo, meetKey: string, proposal: AutoBuildProposal, choices: ReadonlyMap<string, RemoveChoice>): Promise<readonly TagWrite[]> {
  const { ops, writes } = await planRosterTags(repo, meetKey, proposal, choices);
  await repo.putMany(ops);
  return writes;
}

/**
 * Check, then write. The checks run twice: before the slow re-score, and again after it, right before the write. The write is one
 * all-or-nothing `putMany` of the new lineup and every tag change, so it saves all of it or none. Nothing here touches the simulator.
 */
export async function acceptProposal(tagged: TaggedResult, choices: ReadonlyMap<string, RemoveChoice>, deps: AcceptDeps): Promise<AcceptOutcome> {
  const proposal = proposalOf(tagged.result);
  const sync = acceptBlock(tagged, snapshotNow(deps));
  if (sync !== null || proposal === null) return { kind: 'blocked', reason: sync ?? 'There is no proposal to accept.' };
  const changed = await inputsChanged(tagged, deps.repo);
  if (changed !== null) return { kind: 'blocked', reason: changed };
  const verified = await verifyProposal(tagged, proposal, deps);
  if (!verified.ok) return { kind: 'blocked', reason: verified.reason };

  const { inputs } = tagged;
  const lineupId = deps.newId();
  const lineupName = `AutoBuilder: ${modeLabel(tagged.request.objective, inputs.names)} (${deps.now().slice(0, 10)})`;
  const record: Omit<LineupRecord, 'rev' | 'updatedAt'> = {
    lineupId,
    meetKey: inputs.meetKey,
    name: lineupName,
    kind: 'lineup',
    payloadVersion: 1,
    payload: proposal.lineup,
    origin: { kind: 'local' },
    createdAt: deps.now(),
    builtUnder: {
      rulePreset: inputs.ruleRef,
      ...(inputs.ruleRev === undefined ? {} : { rulePresetRev: inputs.ruleRev }),
      rulePresetValues: inputs.rulePreset,
      ...(inputs.sessionRef === undefined || inputs.sessionPreset === undefined ? {} : { sessionPreset: inputs.sessionRef, sessionPresetValues: inputs.sessionPreset }),
    },
  };
  // The tag revs are read here, so a tag that changes after this read makes putMany refuse the whole batch.
  const { ops: tagOps, writes: tagsWritten } = await planRosterTags(deps.repo, inputs.meetKey, proposal, choices);

  // The recheck, last: the re-score above took real time. Read the database's changeRev first, then the inputs, so any write that lands
  // after this point, in any store, moves the changeRev and putMany refuses the batch. The snapshot check is synchronous.
  const changeRev = await deps.repo.changeRev();
  const changedAfter = await inputsChanged(tagged, deps.repo);
  if (changedAfter !== null) return { kind: 'blocked', reason: changedAfter };
  const sinceRun = acceptBlock(tagged, snapshotNow(deps));
  if (sinceRun !== null) return { kind: 'blocked', reason: sinceRun };

  try {
    await deps.repo.putMany([{ op: 'put', store: 'lineups', record, expectedRev: 'new' }, ...tagOps], { expectedChangeRev: changeRev });
  } catch (cause) {
    if (cause instanceof ChangeRevMovedError) return { kind: 'blocked', reason: 'Something changed while checking. Nothing was saved. Run Accept again.' };
    if (cause instanceof StaleWriteError) return { kind: 'blocked', reason: 'Your scorer tags changed while Accept was saving. Nothing was saved. Run the AutoBuilder again.' };
    throw new Error(`Nothing was saved: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { kind: 'accepted', lineupId, lineupName, verified, tagsWritten, changes: changeLines(proposal, tagged.request.lineup, inputs.names) };
}
