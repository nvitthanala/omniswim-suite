/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Accept is safe against a change that lands while it works, and its write is all or nothing (Codex review of U1-b, findings 1 and 2).
 * The re-score awaits real solver calls, so these tests hold one of them open on a promise and change the world while it waits.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { AutoBuildObjective, AutoBuildProposal, AutoBuildResult, AutoBuildScore, LpSolve, ScorerTag } from '@omniswim/engine';
import { snapshotKey } from '../apps/extension/src/dashboard/autoBuilderRequest';
import { AutoBuildRunError } from '../apps/extension/src/dashboard/autobuilderClient';
import type { AutoBuildWireRequest } from '../apps/extension/src/shared/autobuilderProtocol';
import type { TaggedResult } from '../apps/extension/src/dashboard/autoBuilderResult';
import { acceptProposal, defaultRemoveChoices } from '../apps/extension/src/dashboard/autoBuilderAccept';
import type { AcceptDeps } from '../apps/extension/src/dashboard/autoBuilderAccept';
import type { PutManyOp, StorageRepo } from '../apps/extension/src/storage';
import { saveScorerOwnTeam, saveScorerRulePreset, toSwimCloudId } from '../apps/extension/src/storage';
import type { SimSnapshot } from '../apps/extension/src/shared/bridgeSchema';
import { configCWorld, nodeScore, realSolveLp, RULE_REF, runWorld } from './helpers/autoBuilderFixtures';
import type { ConfigCWorld } from './helpers/autoBuilderFixtures';

/** A solver whose first call waits for `release()`. `entered` settles when that call has started. */
function gatedSolver(): { solveLp: LpSolve; entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let first = true;
  const solveLp: LpSolve = async (lp, options) => {
    if (first) {
      first = false;
      enter();
      await gate;
    }
    return realSolveLp(lp, options);
  };
  return { solveLp, entered, release };
}

const baseDeps = (w: ConfigCWorld, over: Partial<AcceptDeps>): AcceptDeps => ({
  repo: w.repo, solveLp: realSolveLp, score: nodeScore, currentSnapshot: w.snapshot, now: () => '2026-10-31T12:00:00.000Z', newId: () => 'lineup-1', ...over,
});

const tagKey = (w: ConfigCWorld, swimmerId: string): [string, string, string] => [w.meetKey, toSwimCloudId(w.ownTeamId), toSwimCloudId(swimmerId)];

async function stored(w: ConfigCWorld): Promise<{ lineups: number; tags: string }> {
  const tags = await w.repo.list('tags', { index: 'byMeet', value: w.meetKey });
  return { lineups: (await w.repo.list('lineups')).length, tags: JSON.stringify(tags.map((t) => [t.swimmerId, t.role, t.rev]).sort()) };
}

describe('Accept: a change during the re-score', () => {
  it('the simulator snapshot changes while the opponents are re-suggested: blocked, nothing written', async () => {
    const w = await configCWorld();
    try {
      const tagged = await runWorld(w);
      if (tagged.result.kind !== 'improved') throw new Error('expected improved');
      const before = await stored(w);
      let live: SimSnapshot = w.snapshot;
      const gate = gatedSolver();
      const pending = acceptProposal(tagged, defaultRemoveChoices(tagged.result.proposal), baseDeps(w, { solveLp: gate.solveLp, currentSnapshot: () => live }));
      await gate.entered;
      live = { ...w.snapshot, settings: { ...w.snapshot.settings, startDate: '2099-01-01' } };
      gate.release();
      const out = await pending;
      expect(out).toStrictEqual({ kind: 'blocked', reason: 'The SwimCloud simulator changed after this run, so the proposal may no longer fit. Run the AutoBuilder again.' });
      expect(await stored(w)).toStrictEqual(before);
    } finally {
      w.close();
    }
  }, 120_000);

  it('a scorer tag changes while the opponents are re-suggested: blocked, nothing written', async () => {
    const w = await configCWorld();
    try {
      const tagged = await runWorld(w);
      if (tagged.result.kind !== 'improved') throw new Error('expected improved');
      const gate = gatedSolver();
      const pending = acceptProposal(tagged, new Map(), baseDeps(w, { solveLp: gate.solveLp }));
      await gate.entered;
      const key = tagKey(w, w.pinned[0] as string);
      const row = await w.repo.get('tags', key);
      if (!row.found) throw new Error('the pinned tag is missing');
      await w.repo.put('tags', { meetKey: w.meetKey, teamId: key[1] as never, swimmerId: key[2] as never, role: 'non-scorer' }, row.value.rev);
      const afterEdit = await stored(w);
      gate.release();
      const out = await pending;
      expect(out).toStrictEqual({ kind: 'blocked', reason: 'Your scorer tags changed after this run. Run the AutoBuilder again.' });
      expect(await stored(w)).toStrictEqual(afterEdit);
      expect(afterEdit.lineups).toBe(0);
    } finally {
      w.close();
    }
  }, 120_000);
});

describe('Accept: all or nothing', () => {
  it('a tag that goes stale after Accept read it makes the batch write nothing, the lineup included', async () => {
    const w = await configCWorld();
    try {
      const tagged = await runWorld(w);
      if (tagged.result.kind !== 'improved') throw new Error('expected improved');
      expect(tagged.result.proposal.rosterAdds.length).toBeGreaterThan(0);
      let raced = 0;
      // A coach edit lands between Accept reading the tag revs and the batch write.
      const racing: StorageRepo = {
        ...w.repo,
        async putMany(ops: readonly PutManyOp[]) {
          const victim = ops.find((op) => op.op === 'put' && op.store === 'tags');
          if (victim === undefined || victim.op !== 'put' || victim.store !== 'tags') throw new Error('no tag op in the batch');
          await w.repo.put('tags', victim.record, victim.expectedRev);
          raced += 1;
          return w.repo.putMany(ops);
        },
      };
      const before = await stored(w);
      const out = await acceptProposal(tagged, defaultRemoveChoices(tagged.result.proposal), baseDeps(w, { repo: racing }));
      expect(raced).toBe(1);
      expect(out).toStrictEqual({ kind: 'blocked', reason: 'Your scorer tags changed while Accept was saving. Nothing was saved. Run the AutoBuilder again.' });
      const after = await stored(w);
      expect(after.lineups).toBe(0);
      expect(await w.repo.get('lineups', 'lineup-1')).toStrictEqual({ found: false });
      // Only the racing edit is there; every other tag op was rolled back with the lineup.
      expect(after.tags).not.toBe(before.tags);
      expect((JSON.parse(after.tags) as unknown[]).length).toBe((JSON.parse(before.tags) as unknown[]).length + 1);
    } finally {
      w.close();
    }
  }, 120_000);

  it('saves the lineup and every tag change in one batch', async () => {
    const w = await configCWorld();
    try {
      const tagged = await runWorld(w);
      if (tagged.result.kind !== 'improved') throw new Error('expected improved');
      const batches: number[] = [];
      const counting: StorageRepo = { ...w.repo, putMany: (ops) => { batches.push(ops.length); return w.repo.putMany(ops); } };
      const out = await acceptProposal(tagged, defaultRemoveChoices(tagged.result.proposal), baseDeps(w, { repo: counting }));
      if (out.kind !== 'accepted') throw new Error(`blocked: ${out.reason}`);
      expect(batches).toStrictEqual([1 + out.tagsWritten.length]);
      expect((await stored(w)).lineups).toBe(1);
    } finally {
      w.close();
    }
  }, 120_000);
});

describe('Accept: a write that lands between the final check and the batch', () => {
  const competitors: readonly (readonly [string, (w: ConfigCWorld) => Promise<unknown>])[] = [
    ['the own team', (w) => saveScorerOwnTeam(w.repo, w.meetKey, toSwimCloudId('48'))],
    ['the rule preset', (w) => saveScorerRulePreset(w.repo, w.meetKey, RULE_REF)],
    ['a tag the proposal does not touch', (w) => w.repo.put('tags', { meetKey: w.meetKey, teamId: toSwimCloudId('48'), swimmerId: toSwimCloudId('148001'), role: 'scorer' }, 'new')],
  ];

  it.each(competitors)('%s changes after the last input check: blocked, nothing saved', async (_name, compete) => {
    const w = await configCWorld();
    try {
      const tagged = await runWorld(w);
      if (tagged.result.kind !== 'improved') throw new Error('expected improved');
      let raced = 0;
      // The repo wrapper commits the competing write right before the batch starts, after every input check has passed.
      const racing: StorageRepo = {
        ...w.repo,
        async putMany(ops: readonly PutManyOp[], options) {
          await compete(w);
          raced += 1;
          return w.repo.putMany(ops, options);
        },
      };
      const out = await acceptProposal(tagged, defaultRemoveChoices(tagged.result.proposal), baseDeps(w, { repo: racing }));
      expect(raced).toBe(1);
      expect(out).toStrictEqual({ kind: 'blocked', reason: 'Something changed while checking. Nothing was saved. Run Accept again.' });
      expect((await w.repo.list('lineups')).length).toBe(0);
      expect(await w.repo.get('lineups', 'lineup-1')).toStrictEqual({ found: false });
    } finally {
      w.close();
    }
  }, 120_000);
});

// ---- the re-score is the engine's objective, not own points (D5 amendment 10) -------------------------------

describe('Accept: the re-score uses the objective of the run', () => {
  let base: TaggedResult;
  let proposal: AutoBuildProposal;
  beforeAll(async () => {
    const w = await configCWorld();
    try {
      base = await runWorld(w);
      if (base.result.kind !== 'improved') throw new Error('expected improved');
      proposal = base.result.proposal;
    } finally {
      w.close();
    }
  }, 120_000);

  type Call = { req: AutoBuildWireRequest; lineup: unknown; tags: readonly ScorerTag[]; scaleD: number | undefined };
  /** A score call that answers `before` for the current lineup and `after` for the proposal, and records its arguments. */
  const stub = (before: Partial<AutoBuildScore>, after: Partial<AutoBuildScore>): { score: AcceptDeps['score']; calls: Call[] } => {
    const calls: Call[] = [];
    return {
      calls,
      score: async (req, lineup, tags, scaleD) => {
        calls.push({ req, lineup, tags, scaleD });
        return (calls.length === 1 ? before : after) as AutoBuildScore;
      },
    };
  };
  const as = (objective: AutoBuildObjective, scaleD?: number): TaggedResult => ({
    ...base,
    request: { ...base.request, objective },
    result: { ...(base.result as Extract<AutoBuildResult, { kind: 'improved' }>), proposal: { ...proposal, ...(scaleD === undefined ? {} : { scaleD }) } },
  });
  const accept = async (tagged: TaggedResult, score: AcceptDeps['score']): Promise<{ out: Awaited<ReturnType<typeof acceptProposal>>; lineups: number }> => {
    const w = await configCWorld();
    try {
      // A fresh world per case (Accept writes). Its snapshot is the same fixture, but not the same bytes as the one the run saw.
      const out = await acceptProposal({ ...tagged, snapshotKey: snapshotKey(w.snapshot) }, new Map(), baseDeps(w, { score }));
      return { out, lineups: (await w.repo.list('lineups')).length };
    } finally {
      w.close();
    }
  };
  const ROBUST: AutoBuildObjective = { kind: 'robust', recentSwims: 5, minSwims: 3 };

  it('robust: own points tie but the robust objective wins, so Accept is allowed (own points alone would block it)', async () => {
    const s = stub({ objective: 100, ownPoints: 50, meetsTarget: null }, { objective: 101.5, ownPoints: 50, meetsTarget: null });
    const { out, lineups } = await accept(as(ROBUST, 12), s.score);
    if (out.kind !== 'accepted') throw new Error(`blocked: ${out.reason}`);
    expect(out.verified).toStrictEqual({ ok: true, current: 100, proposal: 101.5 });
    expect(lineups).toBe(1);
    // The current lineup is scored without a scale; the proposal with its own scaleD and its own tags (roster adds are scorers there).
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]?.lineup).toStrictEqual(base.request.lineup);
    expect(s.calls[0]?.scaleD).toBeUndefined();
    expect(s.calls[1]?.lineup).toStrictEqual(proposal.lineup);
    expect(s.calls[1]?.scaleD).toBe(12);
    expect(proposal.rosterAdds.length).toBeGreaterThan(0);
    for (const add of proposal.rosterAdds) expect(s.calls[1]?.tags).toContainEqual(expect.objectContaining({ swimmerId: add.swimmerId, role: 'scorer' }));
    expect(s.calls[0]?.req.tags).toStrictEqual(s.calls[0]?.tags);
    expect(s.calls[0]?.req.objective).toStrictEqual(ROBUST);
  }, 120_000);

  it('robust: more own points but a robust objective that does not rise is blocked', async () => {
    const s = stub({ objective: 100, ownPoints: 50, meetsTarget: null }, { objective: 100, ownPoints: 60, meetsTarget: null });
    const { out, lineups } = await accept(as(ROBUST), s.score);
    expect(out).toMatchObject({ kind: 'blocked' });
    if (out.kind === 'blocked') expect(out.reason).toMatch(/proposal scores 100 against 100 for your current lineup \(0\)\. It is not above the current lineup/);
    expect(lineups).toBe(0);
  }, 120_000);

  it('margin: the rival metric decides, not own points', async () => {
    const margin: AutoBuildObjective = { kind: 'margin', rival: { kind: 'closest' } };
    const up = await accept(as(margin), stub({ objective: 10, ownPoints: 50, meetsTarget: null }, { objective: 11, ownPoints: 40, meetsTarget: null }).score);
    expect(up.out.kind).toBe('accepted');
    const down = await accept(as(margin), stub({ objective: 10, ownPoints: 50, meetsTarget: null }, { objective: 9, ownPoints: 70, meetsTarget: null }).score);
    expect(down.out).toMatchObject({ kind: 'blocked' });
    expect(down.lineups).toBe(0);
  }, 180_000);

  it('goal seek: allowed only when the score says meetsTarget, whatever the objective does', async () => {
    const goal: AutoBuildObjective = { kind: 'goal-seek', target: { kind: 'total', points: 1000 } };
    const met = await accept(as(goal), stub({ objective: 500, ownPoints: 500, meetsTarget: false }, { objective: 500, ownPoints: 500, meetsTarget: true }).score);
    expect(met.out.kind).toBe('accepted');
    for (const meetsTarget of [false, null] as const) {
      const missed = await accept(as(goal), stub({ objective: 500, ownPoints: 500, meetsTarget: false }, { objective: 900, ownPoints: 900, meetsTarget }).score);
      expect(missed.out).toMatchObject({ kind: 'blocked' });
      if (missed.out.kind === 'blocked') expect(missed.out.reason).toMatch(/which does not reach the target of 1000\. It is not accepted/);
      expect(missed.lineups).toBe(0);
    }
  }, 240_000);

  it('a score call that fails blocks Accept with its code, subject and message, and writes nothing', async () => {
    const failing: AcceptDeps['score'] = async () => {
      throw new AutoBuildRunError('autobuild', 'robust_no_spread', 'robust', 'no pair has a spread');
    };
    const { out, lineups } = await accept(as(ROBUST), failing);
    expect(out).toStrictEqual({ kind: 'blocked', reason: 'The fresh score could not be computed (robust_no_spread, robust): no pair has a spread' });
    expect(lineups).toBe(0);
  }, 120_000);

  it('the real engine score agrees with the run: the proposal scores its own evaluation, and tags it was run under', async () => {
    const score = await nodeScore({ ...base.request, tags: base.request.tags }, proposal.lineup, proposal.tagsForScoring, proposal.scaleD);
    expect(score.objective).toBe(proposal.evaluation.objective);
    expect(score.ownPoints).toBe(proposal.evaluation.ownPoints);
    expect(score.meetsTarget).toBeNull();
  });
});
