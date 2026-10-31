/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * autobuilder.worker and its dashboard client (plans/2026-10-25/D5-AUTOBUILDER.md, amendment 7 item 4, tests 1 to 5).
 *
 * The worker module runs here with a fake worker scope and a real HiGHS (the `highs` loader is replaced by one that loads the wasm
 * in Node), so the dispatch, the protocol and the solver calls are the shipped code. The fake scope is faithful in one more way:
 * it runs `structuredClone` on every message in both directions, as `postMessage` does, so a request or a result that is not
 * plain data fails here as it would in Chromium. The client runs against a fake `Worker` that hosts the real worker module.
 *
 * Every world is the recorded simulator fixture config C (men, Henderson State and two opponents), built like
 * tests/engineAutoBuildFallback.test.ts builds it. No time or point value is typed here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoBuildError, ScoreMeetError, autoBuild, autoBuildObjective, builtinRulePreset, requireComplete } from '@omniswim/engine';
import type { AutoBuildLimits, AutoBuildRequest, AutoBuildResult, ConversionSettings, RulePreset, ScorerTag } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { AutoBuildErrorMessage, AutoBuildProgress, AutoBuildWireRequest, AutoBuildWorkerResponse } from '../apps/extension/src/shared/autobuilderProtocol';
import { AUTOBUILD_CANCELLED, AutoBuildRunError, createAutoBuildClient } from '../apps/extension/src/dashboard/autobuilderClient';
import { createOptimizerClient } from '../apps/extension/src/dashboard/optimizerClient';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { nodeMipSolve } from './helpers/nodeMipSolve';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
/** Generous: the engine never reaches the limit, so the result does not depend on how fast the machine is. */
const LIMITS: AutoBuildLimits = { candidatesPerEvent: 6, maxCandidatesPerEvent: 6, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 0, timeLimitSeconds: 120 };

function configC(): AutoBuildWireRequest {
  const { snapshot } = buildSnapshot('C');
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: 'worker-config-C', snapshotId: 'test' });
  if (adapted.kind !== 'ready') throw new Error(`config C did not adapt: ${adapted.kind}`);
  const { model, lineup } = adapted.adapted;
  const own = String(model.teams.find((t) => String(t.teamId) === '58')?.teamId ?? (model.teams[0] as { teamId: string }).teamId);
  const mine = model.swimmers.filter((s) => s.teamId === own && s.gender === 'Men').map((s) => s.swimmerId).sort();
  const pinned = mine.slice(0, 3);
  const entered = new Map<string, Set<string>>();
  for (const e of lineup.entries) {
    if (e.teamId === own) continue;
    const ids = entered.get(e.teamId) ?? new Set<string>();
    for (const id of e.kind === 'individual' ? [e.swimmerId] : e.legs.map((l) => l.swimmerId)) ids.add(id);
    entered.set(e.teamId, ids);
  }
  const tags: ScorerTag[] = [
    ...pinned.map((swimmerId) => ({ teamId: own, swimmerId, role: 'scorer' as const })),
    ...[...entered].flatMap(([teamId, ids]) => [...ids].sort().map((swimmerId) => ({ teamId, swimmerId, role: 'scorer' as const }))),
  ];
  return {
    model,
    lineup,
    rules: requireComplete(builtinRulePreset('nsisc', 5) as RulePreset),
    sourcing: SOURCING,
    tags,
    ownTeamId: own as never,
    genders: ['Men'],
    objective: { kind: 'max-own' },
    load: null,
    limits: LIMITS,
  };
}

/** Timing fields differ from run to run: the solver's seconds in `solves[].ms`, and the clock's `timings`. */
function withoutTiming(result: AutoBuildResult): unknown {
  const copy = structuredClone(result) as unknown as { proof: { solves: { ms: unknown }[]; timings: unknown } };
  copy.proof.solves.forEach((s) => (s.ms = null));
  copy.proof.timings = null;
  return copy;
}

// ---- the worker module in Node ----------------------------------------------------------------------

type Listener = (message: unknown) => void;

interface Booted {
  /** Deliver a message to the worker as `postMessage` would: a structured clone. */
  send(message: unknown): void;
  /** Deliver the message as it is, with no clone (a function in it survives). */
  sendRaw(message: unknown): void;
  /** Every message the worker posted, cloned as `postMessage` clones. */
  readonly posted: unknown[];
  /** `fn` sees each message the worker posts, after the clone. */
  onPost(fn: Listener): void;
  /** Resolve with the messages of run `id` up to and including its `auto-build-done` or `auto-build-error`. */
  finished(id: number): Promise<AutoBuildWorkerResponse[]>;
}

/** A fresh copy of the worker module with its own engine and HiGHS, as a real worker holds. */
async function boot(): Promise<Booted> {
  vi.resetModules();
  const real = await vi.importActual<typeof import('highs')>('highs');
  const highs = await real.default({});
  vi.doMock('highs', () => ({ default: async () => highs }));
  const posted: unknown[] = [];
  const listeners: Listener[] = [];
  const scope = {
    postMessage: (m: unknown) => {
      const cloned = structuredClone(m);
      posted.push(cloned);
      for (const fn of listeners) fn(cloned);
    },
    onmessage: null as ((e: { data: unknown }) => void) | null,
    location: { href: 'file:///dist/autobuilder.worker.js' },
  };
  vi.stubGlobal('self', scope);
  await import('../apps/extension/src/worker/autobuilder');
  const finished = (id: number): Promise<AutoBuildWorkerResponse[]> =>
    new Promise((resolve) => {
      const mine: AutoBuildWorkerResponse[] = [];
      listeners.push((m) => {
        const r = m as AutoBuildWorkerResponse;
        if (r.id !== id) return;
        mine.push(r);
        if (r.kind !== 'auto-build-progress') resolve(mine);
      });
    });
  return {
    send: (m) => (scope.onmessage as (e: { data: unknown }) => void)({ data: structuredClone(m) }),
    sendRaw: (m) => (scope.onmessage as (e: { data: unknown }) => void)({ data: m }),
    posted,
    onPost: (fn) => void listeners.push(fn),
    finished,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('highs');
});

/** The one `auto-build-done`, or a failure that prints what the run sent instead. */
function doneOf(messages: readonly AutoBuildWorkerResponse[]): Extract<AutoBuildWorkerResponse, { kind: 'auto-build-done' }> {
  const last = messages[messages.length - 1];
  if (last?.kind !== 'auto-build-done') throw new Error(`the run did not finish: ${JSON.stringify(last)}`);
  return last;
}

describe('autobuilder.worker: the result of the worker is the result of autoBuild (acceptance 1)', () => {
  it('with clock none, a generous limit and refineRounds 0, the result equals a direct autoBuild, timing aside', async () => {
    const request = configC();
    const direct = await autoBuild(request as AutoBuildRequest, nodeMipSolve());
    expect(direct.kind).toBe('improved');
    const w = await boot();
    const done = w.finished(1);
    // `send` clones the request and the worker's replies are cloned, so both legs are what a real postMessage delivers.
    w.send({ kind: 'auto-build', id: 1, request, clock: 'none' });
    const reply = doneOf(await done);
    expect(withoutTiming(reply.result)).toStrictEqual(withoutTiming(direct));
    // The same request, run a second time on the same worker, gives the same result again.
    const again = w.finished(2);
    w.send({ kind: 'auto-build', id: 2, request, clock: 'none' });
    expect(withoutTiming(doneOf(await again).result)).toStrictEqual(withoutTiming(direct));
    // With clock 'none' the engine reports no clock timing, and the worker's `loadMs` and `wallMs` are numbers.
    const { evaluateMs, gateMs, explainMs } = reply.result.proof.timings;
    expect([evaluateMs, gateMs, explainMs]).toStrictEqual([null, null, null]);
    expect(typeof reply.loadMs).toBe('number');
    expect(typeof reply.wallMs).toBe('number');
  }, 180_000);

  it('a structured clone of the request gives the result of the request itself (the open observation of amendment 7)', async () => {
    const request = configC();
    const clone = structuredClone(request);
    const a = await autoBuild(request as AutoBuildRequest, nodeMipSolve());
    const b = await autoBuild(clone as AutoBuildRequest, nodeMipSolve());
    expect(withoutTiming(b)).toStrictEqual(withoutTiming(a));
  }, 180_000);
});

describe('autobuilder.worker: progress and errors (acceptance 3 and 4)', () => {
  it('posts one progress message per MipSolve call, in order, and solvesDone ends at proof.solves.length', async () => {
    const w = await boot();
    const done = w.finished(5);
    w.send({ kind: 'auto-build', id: 5, request: configC(), clock: 'none' });
    const messages = await done;
    const progress = messages.filter((m): m is AutoBuildProgress => m.kind === 'auto-build-progress');
    const { result } = doneOf(messages);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.map((p) => p.solvesDone)).toStrictEqual(progress.map((_, i) => i + 1));
    expect(progress[progress.length - 1]?.solvesDone).toBe(result.proof.solves.length);
    expect(progress.every((p) => p.limitMs === 120_000)).toBe(true);
    const elapsed = progress.map((p) => p.elapsedMs);
    expect(elapsed).toStrictEqual([...elapsed].sort((a, b) => a - b));
    // Progress comes before the reply, and every message names the run.
    expect(messages.slice(0, -1).every((m) => m.kind === 'auto-build-progress')).toBe(true);
    expect(w.posted.every((m) => (m as { id: number }).id === 5)).toBe(true);
  }, 180_000);

  it('an AutoBuildError arrives as auto-build-error with the same code, subject and message', async () => {
    const request = { ...configC(), ownTeamId: 'no-such-team' as never };
    let thrown: unknown;
    try {
      await autoBuild(request as AutoBuildRequest, nodeMipSolve());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AutoBuildError);
    const expected = thrown as AutoBuildError;
    const w = await boot();
    const done = w.finished(8);
    w.send({ kind: 'auto-build', id: 8, request, clock: 'none' });
    const messages = await done;
    expect(messages).toStrictEqual([
      { kind: 'auto-build-error', id: 8, source: 'autobuild', code: expected.code, subject: expected.subject, message: expected.message } satisfies AutoBuildErrorMessage,
    ]);
  }, 60_000);

  it('a ScoreMeetError arrives with source score, and any other failure with source internal', async () => {
    const noTags = { ...configC(), tags: [] };
    let thrown: unknown;
    try {
      await autoBuild(noTags as AutoBuildRequest, nodeMipSolve());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ScoreMeetError);
    const expected = thrown as ScoreMeetError;
    const w = await boot();
    const scored = w.finished(9);
    w.send({ kind: 'auto-build', id: 9, request: noTags, clock: 'none' });
    expect(await scored).toStrictEqual([{ kind: 'auto-build-error', id: 9, source: 'score', code: expected.code, subject: expected.subject, message: expected.message }]);
    // A request with no `limits` is not an engine error: the worker reports it as internal and stays alive.
    const broken = w.finished(10);
    w.send({ kind: 'auto-build', id: 10, request: { ...configC(), limits: undefined }, clock: 'none' });
    const [reply] = await broken;
    expect(reply).toMatchObject({ kind: 'auto-build-error', id: 10, source: 'internal', code: 'internal', subject: null });
    // A message that is no auto-build request, with an id, gets an internal error. One with no id gets nothing.
    const unsupported = w.finished(11);
    w.send({ kind: 'plan-lineup', id: 11 });
    expect((await unsupported)[0]).toMatchObject({ kind: 'auto-build-error', id: 11, source: 'internal' });
    const before = w.posted.length;
    w.send({ kind: 'plan-lineup' });
    expect(w.posted.length).toBe(before);
  }, 60_000);
});

// ---- the client against fake workers ----------------------------------------------------------------

/** A `Worker` that hosts the real autobuilder.worker module, with a clone on each leg. `terminate()` ends delivery in both directions. */
class HostedWorker {
  static created: HostedWorker[] = [];
  terminated = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  private readonly booting: Promise<Booted>;

  constructor(readonly url: string) {
    HostedWorker.created.push(this);
    this.booting = boot().then((b) => {
      b.onPost((m) => {
        if (this.terminated) return;
        for (const fn of this.listeners.get('message') ?? []) fn({ data: m });
      });
      return b;
    });
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  postMessage(message: unknown): void {
    const copy = structuredClone(message);
    void this.booting.then((b) => {
      if (!this.terminated) b.sendRaw(copy);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** The optimizer worker, by hand: it answers when the test says so. */
class ManualOptimizerWorker {
  static created: ManualOptimizerWorker[] = [];
  terminated = false;
  inbox: { kind: string; id: number }[] = [];
  private readonly listeners: ((event: unknown) => void)[] = [];
  constructor() {
    ManualOptimizerWorker.created.push(this);
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (type === 'message') this.listeners.push(fn);
  }
  postMessage(message: { kind: string; id: number }): void {
    this.inbox.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.listeners.forEach((fn) => fn({ data }));
  }
}

function stubWorkers(): { autoUrls: string[] } {
  HostedWorker.created = [];
  ManualOptimizerWorker.created = [];
  const autoUrls: string[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      constructor(url: string) {
        if (url === 'autobuilder.worker.js') {
          autoUrls.push(url);
          return new HostedWorker(url);
        }
        if (url === 'optimizer.worker.js') return new ManualOptimizerWorker();
        throw new Error(`unexpected worker ${url}`);
      }
    },
  );
  return { autoUrls };
}

describe('createAutoBuildClient (acceptance 2 and 5)', () => {
  it('refuses a request that still holds a clock, before any worker starts or any message is posted', async () => {
    const { autoUrls } = stubWorkers();
    const client = createAutoBuildClient();
    const request = { ...configC(), clock: () => 1 } as unknown as AutoBuildWireRequest;
    await expect(client.run(request, () => undefined)).rejects.toThrow(/clock/);
    expect(autoUrls).toStrictEqual([]);
    // The refusal took no run slot: a valid request is accepted next (it ends in an engine error, quickly, which is all this needs).
    const next = client.run({ ...configC(), ownTeamId: 'no-such-team' as never }, () => undefined, { clock: 'none' });
    await expect(next).rejects.toBeInstanceOf(AutoBuildRunError);
    expect(autoUrls.length).toBe(1);
  }, 60_000);

  it('the worker itself refuses a message whose request holds a clock', async () => {
    const w = await boot();
    const done = w.finished(3);
    w.sendRaw({ kind: 'auto-build', id: 3, request: { ...configC(), clock: () => 1 }, clock: 'none' });
    const [reply] = await done;
    expect(reply).toMatchObject({ kind: 'auto-build-error', id: 3, source: 'internal', subject: 'clock' });
  }, 60_000);

  it('rejects with AutoBuildRunError carrying source, code and subject of an engine error', async () => {
    stubWorkers();
    const client = createAutoBuildClient();
    const error = await client.run({ ...configC(), ownTeamId: 'no-such-team' as never }, () => undefined, { clock: 'none' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AutoBuildRunError);
    const e = error as AutoBuildRunError;
    expect(e.source).toBe('autobuild');
    expect(e.code).toBe('own_team_unknown');
    expect(e.subject).toBe('no-such-team');
  }, 60_000);

  it('allows one run at a time', async () => {
    stubWorkers();
    const client = createAutoBuildClient();
    const first = client.run(configC(), () => client.cancel(), { clock: 'none' });
    await expect(client.run(configC(), () => undefined)).rejects.toThrow(/already running/);
    await expect(first).rejects.toThrow(AUTOBUILD_CANCELLED);
  }, 120_000);

  it('cancel() rejects the run, leaves an optimizer.worker solveLp in flight alone, and the next run works on a fresh worker', async () => {
    const { autoUrls } = stubWorkers();
    const optimizer = createOptimizerClient();
    const solving = optimizer.solveLp('Maximize\n obj: x\nSubject To\n c0: x <= 1\nEnd');
    const optimizerWorker = ManualOptimizerWorker.created[0] as ManualOptimizerWorker;
    expect(optimizerWorker.inbox.map((m) => m.kind)).toStrictEqual(['solve-lp']);

    const client = createAutoBuildClient();
    const seen: number[] = [];
    const cancelled = client.run(configC(), (p) => {
      seen.push(p.solvesDone);
      if (p.solvesDone === 1) client.cancel();
    });
    await expect(cancelled).rejects.toThrow(AUTOBUILD_CANCELLED);
    const first = HostedWorker.created[0] as HostedWorker;
    expect(first.terminated).toBe(true);
    expect(optimizerWorker.terminated).toBe(false);

    // The solve in flight on optimizer.worker still resolves.
    optimizerWorker.reply({ kind: 'solved', id: optimizerWorker.inbox[0]?.id, status: 'Optimal', objective: 1, columns: { x: 1 }, loadMs: 0, solveMs: 0 });
    await expect(solving).resolves.toMatchObject({ status: 'Optimal', objective: 1 });

    // Nothing from the cancelled worker reaches a later run: it keeps running in this thread, but its replies are dropped.
    const before = seen.length;
    const second: number[] = [];
    const run = await client.runTimed(configC(), (p) => second.push(p.solvesDone));
    expect(autoUrls.length).toBe(2);
    expect(HostedWorker.created[1]).not.toBe(first);
    expect(seen.length).toBe(before);
    expect(run.result.kind).toBe('improved');
    expect(second[second.length - 1]).toBe(run.result.proof.solves.length);
    // The default clock is wall: the engine's own timings are filled.
    expect(run.result.proof.timings.evaluateMs).not.toBeNull();
    expect(run.loadMs).toBeGreaterThanOrEqual(0);
    expect(run.wallMs).toBeGreaterThan(0);
  }, 240_000);
});

// ---- score: autoBuildObjective in the worker (D5 amendment 10) -------------------------------------------

describe('autobuilder.worker: the score message', () => {
  it('answers a score with autoBuildObjective: the proposal scores its own evaluation, the current lineup its own', async () => {
    const request = configC();
    const direct = await autoBuild(request as AutoBuildRequest, nodeMipSolve());
    if (direct.kind !== 'improved') throw new Error(`expected improved, got ${direct.kind}`);
    const { proposal } = direct;
    const w = await boot();

    const proposalReply = w.finished(21);
    w.send({ kind: 'score', id: 21, request, lineup: proposal.lineup, tags: proposal.tagsForScoring, scaleD: proposal.scaleD });
    const scored = (await proposalReply)[0];
    if (scored?.kind !== 'score-done') throw new Error(`no score: ${JSON.stringify(scored)}`);
    expect(scored.score).toStrictEqual(structuredClone(autoBuildObjective(request, proposal.lineup, proposal.tagsForScoring, proposal.scaleD)));
    expect(scored.score.objective).toBe(proposal.evaluation.objective);
    expect(scored.score.meetsTarget).toBeNull();

    const currentReply = w.finished(22);
    w.send({ kind: 'score', id: 22, request, lineup: request.lineup, tags: request.tags });
    const current = (await currentReply)[0];
    if (current?.kind !== 'score-done') throw new Error(`no score: ${JSON.stringify(current)}`);
    expect(current.score.objective).toBe(direct.current.objective);
    expect(current.score.objective).toBeLessThan(scored.score.objective);
    // A score never starts a run: no progress message, no HiGHS solve.
    expect(w.posted.filter((m) => (m as { kind: string }).kind === 'auto-build-progress')).toStrictEqual([]);
  }, 180_000);

  it('a refusal of the engine comes back as an auto-build-error with its code and subject; a malformed score gets an internal error', async () => {
    const request = configC();
    const w = await boot();
    const refused = w.finished(23);
    w.send({ kind: 'score', id: 23, request: { ...request, ownTeamId: 'no-such-team' as never }, lineup: request.lineup, tags: request.tags });
    expect((await refused)[0]).toMatchObject({ kind: 'auto-build-error', id: 23, source: 'autobuild', code: 'own_team_unknown', subject: 'no-such-team' });
    const malformed = w.finished(24);
    w.send({ kind: 'score', id: 24, request, lineup: request.lineup, tags: 'not a list' });
    expect((await malformed)[0]).toMatchObject({ kind: 'auto-build-error', id: 24, source: 'internal' });
  }, 60_000);
});

describe('createAutoBuildClient.score', () => {
  it('resolves with the worker score, rejects with AutoBuildRunError for a refusal, and a cancel of the run rejects a score waiting on the worker', async () => {
    stubWorkers();
    const client = createAutoBuildClient();
    const request = configC();
    const score = await client.score(request, request.lineup, request.tags);
    expect(score).toStrictEqual(structuredClone(autoBuildObjective(request, request.lineup, request.tags)));

    const refused = await client.score({ ...request, ownTeamId: 'no-such-team' as never }, request.lineup, request.tags).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AutoBuildRunError);
    expect((refused as AutoBuildRunError).code).toBe('own_team_unknown');

    // A run is in flight on the same worker; cancelling it ends the worker, and the score that waits on it is rejected, not left hanging.
    const run = client.run(request, () => undefined, { clock: 'none' });
    const waiting = client.score(request, request.lineup, request.tags);
    client.cancel();
    await expect(run).rejects.toThrow(AUTOBUILD_CANCELLED);
    await expect(waiting).rejects.toThrow(AUTOBUILD_CANCELLED);
  }, 120_000);
});
