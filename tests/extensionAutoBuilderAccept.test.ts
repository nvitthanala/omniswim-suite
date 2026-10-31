/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Accept is safe against a change that lands while it works, and its write is all or nothing (Codex review of U1-b, findings 1 and 2).
 * The re-score awaits real solver calls, so these tests hold one of them open on a promise and change the world while it waits.
 */
import { describe, expect, it } from 'vitest';
import type { LpSolve } from '@omniswim/engine';
import { acceptProposal, defaultRemoveChoices } from '../apps/extension/src/dashboard/autoBuilderAccept';
import type { AcceptDeps } from '../apps/extension/src/dashboard/autoBuilderAccept';
import type { PutManyOp, StorageRepo } from '../apps/extension/src/storage';
import { saveScorerOwnTeam, saveScorerRulePreset, toSwimCloudId } from '../apps/extension/src/storage';
import type { SimSnapshot } from '../apps/extension/src/shared/bridgeSchema';
import { configCWorld, realSolveLp, RULE_REF, runWorld } from './helpers/autoBuilderFixtures';
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
  repo: w.repo, solveLp: realSolveLp, currentSnapshot: w.snapshot, now: () => '2026-10-31T12:00:00.000Z', newId: () => 'lineup-1', ...over,
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
