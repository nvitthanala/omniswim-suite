/**
 * R4: the optimizers run off the main thread.
 *
 * What these tests pin:
 *  - `runOptimizeJob` is the single place a job becomes an optimizer call, and
 *    it returns exactly what the synchronous entry point returns.
 *  - The worker path (real `scoringWorker` handler, structured-clone copies on
 *    both legs) returns the same result as the synchronous call.
 *  - A cancelled run applies nothing and never mutates the workspace.
 *  - Progress reaches the caller and does not change the result.
 *
 * Optimizer plan ids are random UUIDs, so results are compared after the ids
 * are renamed by first appearance. Everything else must be deep-equal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gender, type Workspace } from '../../packages/core/src/types';
import {
  OptimizeCancelledError,
  isOptimizeCancelled,
  requestOptimize,
} from '../../packages/core/src/lib/optimizeClient';
import { runOptimizeJob, type OptimizeJob } from '../../packages/core/src/lib/optimizeJob';
import { optimizeRosterAllTeams, optimizeRosterForTeam } from '../../packages/core/src/lib/rosterOptimizer';
import { buildArbitrageCardsResult, optimizeWithArbitrage } from '../../packages/core/src/lib/rosterArbitrage';
import { OPTIMIZER_INPUT_FIELDS } from '../packages/manager/src/components/optimizeRunView';
import { HOME_TEAM, RIVAL_TEAM, buildMeetWorkspace, resolvedScoringSettings } from '../../tests/optimizerStepFixtures';
import { installFakeOptimizeWorker, type FakeWorkerHarness } from '../../tests/helpers/fakeOptimizeWorker';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Plain-data view of a result with random plan ids renamed by first appearance. */
function stable<T>(value: T): unknown {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value).replace(UUID, id => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
    return ids.get(id)!;
  });
  return JSON.parse(text);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

// A gain exists, so a result is `improved` and the comparison is not an equality of two no-ops.
const gainWorkspace = () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });

const workspace = gainWorkspace();
const settings = resolvedScoringSettings(workspace);

const JOBS: Array<{ label: string; job: OptimizeJob; sync: (ws: Workspace) => unknown }> = [
  {
    label: 'allTeams (all stages)',
    job: { kind: 'allTeams', removeSeniors: false, settings, stage: 'all' },
    sync: ws => optimizeRosterAllTeams(ws, Gender.MEN, false, settings, 'all'),
  },
  {
    label: 'allTeams (drop seniors, scorers only)',
    job: { kind: 'allTeams', removeSeniors: true, settings, stage: 'scorers' },
    sync: ws => optimizeRosterAllTeams(ws, Gender.MEN, true, settings, 'scorers'),
  },
  {
    label: 'teamLegacy',
    job: { kind: 'teamLegacy', team: HOME_TEAM, removeSeniors: false, settings },
    sync: ws => optimizeRosterForTeam(ws, Gender.MEN, HOME_TEAM, false, settings),
  },
  {
    label: 'teamArbitrage (individual first)',
    job: { kind: 'teamArbitrage', team: HOME_TEAM, removeSeniors: false, settings, mode: 'individual_first' },
    sync: ws => optimizeWithArbitrage(ws, Gender.MEN, HOME_TEAM, false, settings, 'individual_first'),
  },
  {
    label: 'teamArbitrage (relay first)',
    job: { kind: 'teamArbitrage', team: HOME_TEAM, removeSeniors: false, settings, mode: 'relay_first' },
    sync: ws => optimizeWithArbitrage(ws, Gender.MEN, HOME_TEAM, false, settings, 'relay_first'),
  },
  {
    label: 'scan',
    job: { kind: 'scan', team: HOME_TEAM, settings },
    sync: ws => buildArbitrageCardsResult(ws, Gender.MEN, HOME_TEAM, settings),
  },
];

// A job kind the runner does not know: the one deterministic way to make an optimizer call throw.
const BOGUS_JOB = { kind: 'bogus' } as unknown as OptimizeJob;

describe('fixture is not vacuous', () => {
  it('the all-teams run improves the field and reports progress for two teams', () => {
    const progress: unknown[] = [];
    const result = runOptimizeJob(workspace, Gender.MEN, JOBS[0]!.job as Extract<OptimizeJob, { kind: 'allTeams' }>, p =>
      progress.push(p)
    );
    expect(result.outcome).toBe('improved');
    expect(result.projectedTotal).toBeGreaterThan(result.previousTotal);
    expect(progress).toEqual([
      { current: 1, total: 2, team: HOME_TEAM },
      { current: 2, total: 2, team: RIVAL_TEAM },
    ]);
  });
});

describe('runOptimizeJob equals the synchronous entry points', () => {
  for (const { label, job, sync } of JOBS) {
    it(`${label}: same result, workspace untouched`, () => {
      const frozen = deepFreeze(structuredClone(workspace));
      const before = JSON.stringify(frozen);
      const viaJob = runOptimizeJob(frozen, Gender.MEN, job);
      const direct = sync(frozen);
      expect(stable(viaJob)).toEqual(stable(direct));
      expect(JSON.stringify(frozen)).toBe(before);
    });
  }
});

describe('requestOptimize without a Worker (in-thread fallback)', () => {
  for (const { label, job, sync } of JOBS) {
    it(`${label}: structured-clone round trip equals the synchronous result`, async () => {
      const result = await requestOptimize(structuredClone(workspace), Gender.MEN, job);
      expect(stable(structuredClone(result))).toEqual(stable(sync(workspace)));
    });
  }

  it('rejects at once for a signal that is already aborted, and runs nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const frozen = deepFreeze(structuredClone(workspace));
    const progress = vi.fn();
    const err = await requestOptimize(frozen, Gender.MEN, JOBS[0]!.job, {
      signal: controller.signal,
      onProgress: progress,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OptimizeCancelledError);
    expect(isOptimizeCancelled(err)).toBe(true);
    expect((err as Error).name).toBe('AbortError');
    expect(progress).not.toHaveBeenCalled();
  });

  it('discards a result that finished after abort', async () => {
    const controller = new AbortController();
    const frozen = deepFreeze(structuredClone(workspace));
    const err = await requestOptimize(frozen, Gender.MEN, JOBS[0]!.job, {
      signal: controller.signal,
      // Abort from inside the run: the in-thread run cannot stop, but its result must not escape.
      onProgress: p => {
        if (p.current === 1) controller.abort();
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OptimizeCancelledError);
  });

  it('forwards progress and the result is the same with or without a listener', async () => {
    const seen: number[] = [];
    const withListener = await requestOptimize(workspace, Gender.MEN, JOBS[0]!.job, {
      onProgress: p => seen.push(p.current),
    });
    const without = await requestOptimize(workspace, Gender.MEN, JOBS[0]!.job);
    expect(seen).toEqual([1, 2]);
    expect(stable(withListener)).toEqual(stable(without));
  });

  it('surfaces an optimizer error as a rejection', async () => {
    await expect(requestOptimize(workspace, Gender.MEN, BOGUS_JOB)).rejects.toThrow('Unknown optimize job');
  });
});

describe('fields outside OPTIMIZER_INPUT_FIELDS do not change a result', () => {
  // The step drops a result when a field the job reads changed. These fields are not on that
  // list, so changing them must not change what any job returns. If one starts to, add it there.
  const OFF_LIST: Array<[string, unknown]> = [
    ['createdAt', 12345],
    ['loadedPsych', { pdfFilename: 'other.pdf' }],
    ['raceAnalyses', [{ id: 'r' }]],
    ['historySources', [{ type: 'x', label: 'y', importedAt: 1 }]],
    ['relayLegCredits', [{ swimmerName: 'x' }]],
  ];
  for (const [field, value] of OFF_LIST) {
    it(`${field}`, () => {
      expect(OPTIMIZER_INPUT_FIELDS as readonly string[]).not.toContain(field);
      const changed = { ...workspace, [field]: value } as Workspace;
      for (const { job } of JOBS) {
        expect(stable(runOptimizeJob(changed, Gender.MEN, job))).toEqual(
          stable(runOptimizeJob(workspace, Gender.MEN, job))
        );
      }
    });
  }
});

describe('requestOptimize through the worker op', () => {
  let harness: FakeWorkerHarness;
  afterEach(() => harness?.restore());

  for (const { label, job, sync } of JOBS) {
    it(`${label}: worker result equals the synchronous result`, async () => {
      harness = await installFakeOptimizeWorker({ auto: true });
      const frozen = deepFreeze(structuredClone(workspace));
      const result = await requestOptimize(frozen, Gender.MEN, job);
      expect(harness.workers).toHaveLength(1);
      expect(harness.workers[0]!.terminated).toBe(true);
      expect(stable(result)).toEqual(stable(sync(workspace)));
    });
  }

  it('reports one progress message per team, in order, before the result', async () => {
    harness = await installFakeOptimizeWorker({ auto: true });
    const seen: Array<{ current: number; total: number; team: string }> = [];
    await requestOptimize(workspace, Gender.MEN, JOBS[0]!.job, { onProgress: p => seen.push(p) });
    expect(seen).toEqual([
      { current: 1, total: 2, team: HOME_TEAM },
      { current: 2, total: 2, team: RIVAL_TEAM },
    ]);
    const kinds = (harness.workers[0]!.delivered as Array<{ type: string }>).map(m => m.type);
    expect(kinds).toEqual(['started', 'progress', 'progress', 'result']);
  });

  it('a pre-aborted signal never creates a worker', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestOptimize(workspace, Gender.MEN, JOBS[0]!.job, { signal: controller.signal })
    ).rejects.toBeInstanceOf(OptimizeCancelledError);
    expect(harness.workers).toHaveLength(0);
  });

  it('abort terminates the worker, rejects, and ignores every later message', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = requestOptimize(workspace, Gender.MEN, JOBS[0]!.job, {
      signal: controller.signal,
      onProgress: progress,
    });
    const settled = pending.then(
      () => 'resolved',
      (e: unknown) => e
    );
    const worker = harness.workers[0]!;
    expect(worker.inbox).toHaveLength(1);

    // The worker computes and replies, then the coach cancels before the replies are read.
    worker.runHandler();
    expect(worker.outbox.length).toBeGreaterThan(1);
    expect(worker.deliverNext()).toBe(true); // "started"
    expect(worker.deliverNext()).toBe(true); // first progress message arrives
    expect(progress).toHaveBeenCalledTimes(1);
    controller.abort();

    expect(await settled).toBeInstanceOf(OptimizeCancelledError);
    expect(worker.terminated).toBe(true);
    // A late reply from the dead worker must not call back or resolve anything.
    const late = worker.outbox.shift();
    worker.onmessage?.({ data: late });
    worker.onmessage?.({ data: worker.outbox.shift() });
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('a worker that fails to start falls back to an in-thread run with the same result', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    const pending = requestOptimize(workspace, Gender.MEN, JOBS[2]!.job);
    harness.workers[0]!.onerror?.({ message: 'Failed to load module script' });
    const result = await pending;
    expect(harness.workers[0]!.terminated).toBe(true);
    expect(stable(result)).toEqual(stable(JOBS[2]!.sync(workspace)));
  });

  it('a worker error after it started is a rejection, not a silent retry', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    const pending = requestOptimize(workspace, Gender.MEN, JOBS[0]!.job);
    const worker = harness.workers[0]!;
    worker.runHandler();
    worker.deliverNext();
    worker.onerror?.({ message: 'boom' });
    await expect(pending).rejects.toThrow('boom');
  });

  it('the same holds for a single-team job, which reports no progress', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    const pending = requestOptimize(workspace, Gender.MEN, JOBS[2]!.job);
    const worker = harness.workers[0]!;
    worker.runHandler();
    // Only "started" has arrived: a single-team job posts nothing else until it finishes.
    expect((worker.outbox as Array<{ type: string }>).map(m => m.type)).toEqual(['started', 'result']);
    worker.deliverNext();
    worker.onerror?.({ message: 'crash mid-run' });
    await expect(pending).rejects.toThrow('crash mid-run');
    expect(harness.workers).toHaveLength(1);
  });

  it('a worker error after start terminates once and detaches the abort listener', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = requestOptimize(workspace, Gender.MEN, JOBS[2]!.job, { signal: controller.signal });
    const settled = pending.then(() => 'resolved', (e: unknown) => e);
    const worker = harness.workers[0]!;
    worker.runHandler();
    worker.deliverNext(); // "started"
    worker.onerror?.({ message: 'boom' });
    expect(((await settled) as Error).message).toBe('boom');
    expect(worker.terminateCalls).toBe(1);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(worker.onmessage).toBeNull();
    // Aborting afterwards does nothing: no second terminate, no second rejection.
    controller.abort();
    expect(worker.terminateCalls).toBe(1);
  });

  it('a reply the page cannot read (messageerror) rejects, terminates and detaches', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = requestOptimize(workspace, Gender.MEN, JOBS[0]!.job, { signal: controller.signal });
    const settled = pending.then(() => 'resolved', (e: unknown) => e);
    const worker = harness.workers[0]!;
    worker.runHandler();
    worker.deliverNext();
    expect(worker.onmessageerror).toBeTypeOf('function');
    worker.onmessageerror?.();
    expect(((await settled) as Error).message).toContain('could not be read');
    expect(worker.terminateCalls).toBe(1);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(worker.terminateCalls).toBe(1);
  });

  it('a DataCloneError on postMessage terminates the worker and falls back in-thread', async () => {
    harness = await installFakeOptimizeWorker({ auto: false });
    harness.postError = new DOMException('could not be cloned', 'DataCloneError');
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await requestOptimize(workspace, Gender.MEN, JOBS[2]!.job, { signal: controller.signal });
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.terminateCalls).toBe(1);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(stable(result)).toEqual(stable(JOBS[2]!.sync(workspace)));
  });

  it('an error reply becomes a rejection with the worker message', async () => {
    harness = await installFakeOptimizeWorker({ auto: true });
    await expect(requestOptimize(workspace, Gender.MEN, BOGUS_JOB)).rejects.toThrow('Unknown optimize job');
    expect(harness.workers[0]!.terminated).toBe(true);
  });
});
