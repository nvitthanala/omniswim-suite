/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The optimizer worker protocol (plans/2026-10-25/D5-AUTOBUILDER.md, sections 11 and 12.5). The worker module runs here with a
 * stubbed worker scope and a real HiGHS (the `highs` loader is replaced by one that loads the wasm in Node), so the dispatch, the
 * guards and the solver calls are the shipped code. The client runs against a fake `Worker`.
 *
 * `solve-lp` is pinned byte for byte: the request the client sends and the reply the worker gives (but for the two timings) match
 * the literals below, which were captured from the code before the `solve-mip` change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptimizerResponse } from '../apps/extension/src/shared/optimizerProtocol';
import { OPTIMIZER_UNAVAILABLE } from '../apps/extension/src/shared/optimizerProtocol';

const LP = 'Maximize\n obj: 3 x + 2 y\nSubject To\n c0: x + y <= 4\n c1: x + 3 y <= 6\nBounds\n x <= 3\nEnd';
const MIP = 'Maximize\n obj: 5 x + 4 y\nSubject To\n c0: 6 x + 4 y <= 24\n c1: x + 2 y <= 6\nBounds\n 0 <= x <= 10\n 0 <= y <= 10\nGeneral\n x y\nEnd';
const BINARY_MIP = 'Maximize\n obj: 4 a + 3 b + 2 c\nSubject To\n c0: a + b + c <= 2\nBinary\n a b c\nEnd';
const BAD_LP = 'Maximize\n obj: 3 x +\nSubject To\n c0: x <= \nEnd';
const INFEASIBLE ='Maximize\n obj: x\nSubject To\n c0: x >= 5\n c1: x <= 2\nBounds\n 0 <= x <= 10\nEnd';

/** A knapsack-like binary model with several packing rows from a fixed generator: hard enough for a 20 ms limit, still deterministic. */
function hardMip(): string {
  let seed = 12345;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const n = 140;
  const vars = Array.from({ length: n }, (_, i) => `v${i}`);
  const lines = ['Maximize', ` obj: ${vars.map((v) => `+ ${20 + next(80)} ${v}`).join(' ')}`, 'Subject To'];
  for (let r = 0; r < 12; r++) lines.push(` c${r}: ${vars.map((v) => `+ ${10 + next(60)} ${v}`).join(' ')} <= ${n * 11}`);
  lines.push('Binary', ` ${vars.join(' ')}`, 'End');
  return lines.join('\n');
}

interface Created {
  readonly models: { disposed: boolean }[];
}

/** Load the worker module against a real HiGHS. `posted` collects every message the worker posts. */
async function loadWorker(): Promise<{ send(message: unknown): Promise<OptimizerResponse>; created: Created; posted: unknown[] }> {
  vi.resetModules();
  const real = await vi.importActual<typeof import('highs')>('highs');
  const highs = await real.default({});
  const created: Created = { models: [] };
  const wrapped = new Proxy(highs, {
    get(target, prop, receiver) {
      if (prop === 'createModel') {
        return (...args: Parameters<typeof target.createModel>) => {
          const model = target.createModel(...args);
          created.models.push(model);
          return model;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  vi.doMock('highs', () => ({ default: async () => wrapped }));
  const posted: unknown[] = [];
  const scope = { postMessage: (m: unknown) => void posted.push(m), onmessage: null as ((e: { data: unknown }) => void) | null, location: { href: 'file:///dist/optimizer.worker.js' } };
  vi.stubGlobal('self', scope);
  await import('../apps/extension/src/worker/optimizer');
  const send = (message: unknown): Promise<OptimizerResponse> =>
    new Promise((resolve) => {
      const before = posted.length;
      (scope.onmessage as (e: { data: unknown }) => void)({ data: message });
      const poll = (): void => {
        if (posted.length > before) resolve(posted[before] as OptimizerResponse);
        else setTimeout(poll, 2);
      };
      poll();
    });
  return { send, created, posted };
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('highs');
});

/** Everything but the two timings, which differ from run to run. */
const stable = (r: OptimizerResponse): unknown => {
  const { loadMs: _l, solveMs: _s, ...rest } = r as unknown as Record<string, unknown>;
  return rest;
};

describe('optimizer worker: solve-lp stays byte-identical', () => {
  it('replies to an LP and a MIP exactly as before the solve-mip change (field order included)', async () => {
    const w = await loadWorker();
    const lp = await w.send({ kind: 'solve-lp', id: 7, lp: LP });
    const mip = await w.send({ kind: 'solve-lp', id: 7, lp: MIP });
    expect(JSON.stringify(stable(lp))).toBe('{"kind":"solved","id":7,"status":"Optimal","objective":11,"columns":{"x":3,"y":1}}');
    expect(JSON.stringify(stable(mip))).toBe('{"kind":"solved","id":7,"status":"Optimal","objective":20,"columns":{"x":4,"y":0}}');
    // The key order of the whole reply, timings included.
    expect(Object.keys(lp)).toEqual(['kind', 'id', 'status', 'objective', 'columns', 'loadMs', 'solveMs']);
  });

  it('solve-lp at a time limit returns no columns, and passes options through', async () => {
    const w = await loadWorker();
    const r = (await w.send({ kind: 'solve-lp', id: 1, lp: MIP, options: { time_limit: 0 } })) as { status: string; columns: object };
    expect(r.status).toBe('Time limit reached');
    expect(r.columns).toEqual({});
  });

  it('the client sends the exact solve-lp request JSON, with and without options', async () => {
    const sent: string[] = [];
    class FakeWorker {
      listeners: ((e: { data: unknown }) => void)[] = [];
      addEventListener(type: string, fn: (e: { data: unknown }) => void): void {
        if (type === 'message') this.listeners.push(fn);
      }
      postMessage(m: unknown): void {
        sent.push(JSON.stringify(m));
        const { id } = m as { id: number };
        queueMicrotask(() => this.listeners.forEach((fn) => fn({ data: { kind: 'solved', id, status: 'Optimal', objective: 0, columns: {}, loadMs: 0, solveMs: 0 } })));
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const { createOptimizerClient } = await import('../apps/extension/src/dashboard/optimizerClient');
    const client = createOptimizerClient();
    await client.solveLp('LP-A');
    await client.solveLp('LP-B', { time_limit: 3, output_flag: false });
    expect(sent).toEqual(['{"kind":"solve-lp","id":1,"lp":"LP-A"}', '{"kind":"solve-lp","id":2,"lp":"LP-B","options":{"time_limit":3,"output_flag":false}}']);
    client.terminate();
  });
});

describe('optimizer worker: solve-mip', () => {
  it('an Optimal MIP returns its columns, the dual bound and the solver time, and no incumbent', async () => {
    const w = await loadWorker();
    const r = (await w.send({ kind: 'solve-mip', id: 3, lp: BINARY_MIP })) as unknown as Record<string, unknown>;
    expect(r.kind).toBe('solved-mip');
    expect(r.id).toBe(3);
    expect(r.status).toBe('Optimal');
    expect(r.objective).toBe(7);
    expect(r.columns).toEqual({ a: 1, b: 1, c: 0 });
    expect(r.incumbent).toBeNull();
    expect(r.dualBound).toBe(7);
    expect(typeof r.seconds).toBe('number');
    expect(Object.keys(r)).toEqual(['kind', 'id', 'status', 'objective', 'columns', 'incumbent', 'dualBound', 'seconds', 'loadMs', 'solveMs']);
    expect(w.created.models.map((m) => m.disposed)).toEqual([true]);
  });

  it('honors the time limit: a hard MIP stops near it, with status "Time limit reached", columns {} and a finite dual bound', async () => {
    const w = await loadWorker();
    const t0 = performance.now();
    const r = (await w.send({ kind: 'solve-mip', id: 4, lp: hardMip(), options: { time_limit: 0.05, random_seed: 0 } })) as {
      status: string;
      columns: Record<string, number>;
      objective: number;
      incumbent: { objective: number; columns: Record<string, number> } | null;
      dualBound: number | null;
      seconds: number;
    };
    const wall = performance.now() - t0;
    expect(r.status).toBe('Time limit reached');
    expect(r.columns).toEqual({});
    expect(r.objective).toBe(0);
    expect(r.seconds).toBeLessThan(2);
    expect(wall).toBeLessThan(5000);
    expect(r.dualBound).not.toBeNull();
    // A feasible solution at the limit comes back as an incumbent: every value of it is whole and the objective is one the model can reach.
    expect(r.incumbent).not.toBeNull();
    const inc = r.incumbent as { objective: number; columns: Record<string, number> };
    expect(Object.keys(inc.columns).length).toBe(140);
    expect(Object.values(inc.columns).every((v) => Math.abs(v - Math.round(v)) < 1e-6)).toBe(true);
    expect(inc.objective).toBeLessThanOrEqual(r.dualBound as number);
    expect(w.created.models.every((m) => m.disposed)).toBe(true);
  });

  it('a limit of 0 s gives no incumbent and no columns (never a fabricated one)', async () => {
    const w = await loadWorker();
    const r = (await w.send({ kind: 'solve-mip', id: 5, lp: MIP, options: { time_limit: 0 } })) as { status: string; columns: object; incumbent: unknown };
    expect(r.status).toBe('Time limit reached');
    expect(r.columns).toEqual({});
    expect(r.incumbent).toBeNull();
  });

  it('an infeasible MIP returns the status Infeasible with no columns and no incumbent', async () => {
    const w = await loadWorker();
    const r = (await w.send({ kind: 'solve-mip', id: 6, lp: INFEASIBLE })) as { status: string; columns: object; incumbent: unknown };
    expect(r.status).toBe('Infeasible');
    expect(r.columns).toEqual({});
    expect(r.incumbent).toBeNull();
  });

  it('an LP with a syntax error gives an error reply with the request id, and the model is disposed', async () => {
    const w = await loadWorker();
    const r = (await w.send({ kind: 'solve-mip', id: 9, lp: BAD_LP })) as { kind: string; id?: number; error: string };
    expect(r.kind).toBe('error');
    expect(r.id).toBe(9);
    expect(r.error).toMatch(/^solve failed: /);
    expect(w.created.models.every((m) => m.disposed)).toBe(true);
    expect(w.created.models.length).toBe(1);
  });

  it('text with no model in it reads as an empty model: status "Empty", no columns, as highs.solve says', async () => {
    const w = await loadWorker();
    const r = (await w.send({ kind: 'solve-mip', id: 11, lp: 'this is not an LP model' })) as { status: string; columns: object; incumbent: unknown };
    expect(r.status).toBe('Empty');
    expect(r.columns).toEqual({});
    expect(r.incumbent).toBeNull();
  });

  it('an unknown option name is an error reply, not a silent default', async () => {
    const w = await loadWorker();
    const r = (await w.send({ kind: 'solve-mip', id: 10, lp: MIP, options: { no_such_option: 1 } })) as { kind: string; id?: number };
    expect(r.kind).toBe('error');
    expect(r.id).toBe(10);
    expect(w.created.models.every((m) => m.disposed)).toBe(true);
  });
});

describe('optimizer worker: guards', () => {
  const refused = [
    ['a request type the worker does not implement', { kind: 'plan-lineup' }],
    ['no kind', { id: 1, lp: MIP }],
    ['solve-mip with no lp', { kind: 'solve-mip', id: 1 }],
    ['solve-mip with a non-text lp', { kind: 'solve-mip', id: 1, lp: 5 }],
    ['solve-mip with a non-numeric id', { kind: 'solve-mip', id: '1', lp: MIP }],
    ['solve-mip with options as an array', { kind: 'solve-mip', id: 1, lp: MIP, options: ['time_limit'] }],
    ['solve-mip with options as null', { kind: 'solve-mip', id: 1, lp: MIP, options: null }],
    ['solve-mip with an object option value', { kind: 'solve-mip', id: 1, lp: MIP, options: { time_limit: { s: 1 } } }],
    ['solve-lp with no lp', { kind: 'solve-lp', id: 1 }],
    ['a null message', null],
    ['a string message', 'solve-mip'],
  ] as const;
  for (const [label, message] of refused) {
    it(`refuses ${label}`, async () => {
      const w = await loadWorker();
      const r = (await w.send(message)) as { kind: string; id?: number; error: string };
      expect(r).toEqual({ kind: 'error', error: OPTIMIZER_UNAVAILABLE });
      expect(w.created.models.length).toBe(0);
    });
  }
});

describe('optimizer client: solveMip', () => {
  class FakeWorker {
    static sent: string[] = [];
    static reply: (id: number) => unknown = () => null;
    listeners: ((e: { data: unknown }) => void)[] = [];
    addEventListener(type: string, fn: (e: { data: unknown }) => void): void {
      if (type === 'message') this.listeners.push(fn);
    }
    postMessage(m: unknown): void {
      FakeWorker.sent.push(JSON.stringify(m));
      const { id } = m as { id: number };
      queueMicrotask(() => this.listeners.forEach((fn) => fn({ data: FakeWorker.reply(id) })));
    }
    terminate(): void {}
  }
  const mipReply = (id: number): unknown => ({ kind: 'solved-mip', id, status: 'Optimal', objective: 3, columns: { a: 1 }, incumbent: null, dualBound: 3, seconds: 0.1, loadMs: 1, solveMs: 2 });

  beforeEach(() => {
    FakeWorker.sent = [];
    vi.stubGlobal('Worker', FakeWorker);
  });

  it('sends a solve-mip request and resolves with the reply', async () => {
    FakeWorker.reply = mipReply;
    const { createOptimizerClient } = await import('../apps/extension/src/dashboard/optimizerClient');
    const client = createOptimizerClient();
    const r = await client.solveMip('MIP-A', { time_limit: 2 });
    expect(r.status).toBe('Optimal');
    expect(r.columns).toEqual({ a: 1 });
    await client.solveMip('MIP-B');
    expect(FakeWorker.sent).toEqual(['{"kind":"solve-mip","id":1,"lp":"MIP-A","options":{"time_limit":2}}', '{"kind":"solve-mip","id":2,"lp":"MIP-B"}']);
    client.terminate();
  });

  it('rejects a reply of the wrong kind for the request instead of reading it as a result', async () => {
    FakeWorker.reply = (id) => ({ kind: 'solved', id, status: 'Optimal', objective: 0, columns: {}, loadMs: 0, solveMs: 0 });
    const { createOptimizerClient } = await import('../apps/extension/src/dashboard/optimizerClient');
    const client = createOptimizerClient();
    await expect(client.solveMip('MIP')).rejects.toThrow(/solve-mip|solved-mip/);
    FakeWorker.reply = mipReply;
    await expect(client.solveLp('LP')).rejects.toThrow(/solved/);
    client.terminate();
  });

  it('rejects with the worker error text for the request id', async () => {
    FakeWorker.reply = (id) => ({ kind: 'error', id, error: 'solve failed: boom' });
    const { createOptimizerClient } = await import('../apps/extension/src/dashboard/optimizerClient');
    const client = createOptimizerClient();
    await expect(client.solveMip('MIP')).rejects.toThrow('solve failed: boom');
    client.terminate();
  });
});

describe('optimizer worker: solver module details', () => {
  it('the numeric status table gives the highs.solve names, and an unknown code is named, never read as an optimum', async () => {
    const { statusText } = await import('../apps/extension/src/worker/optimizerSolve');
    const names = [
      'Not Set', 'Load error', 'Model error', 'Presolve error', 'Solve error', 'Postsolve error', 'Empty', 'Optimal', 'Infeasible',
      'Primal infeasible or unbounded', 'Unbounded', 'Bound on objective reached', 'Target for objective reached', 'Time limit reached',
      'Iteration limit reached', 'Unknown', 'Solution-count limit reached', 'Interrupted',
    ];
    names.forEach((name, code) => expect(statusText(code), `code ${code}`).toBe(name));
    expect(statusText(18)).toBe('HiGHS model status 18');
    expect(statusText(-1)).toBe('HiGHS model status -1');
    expect(statusText(99)).not.toBe('Optimal');
  });

  it('an incumbent comes only from a time-limited run: a solution-count limit, even with a solution in hand, returns none', async () => {
    const real = await vi.importActual<typeof import('highs')>('highs');
    const highs = await real.default({});
    const { solveMipOn } = await import('../apps/extension/src/worker/optimizerSolve');
    const r = solveMipOn(highs, { kind: 'solve-mip', id: 1, lp: hardMip(), options: { mip_max_improving_sols: 1 } }, 0);
    expect(r.status).toBe('Solution-count limit reached');
    expect(r.columns).toEqual({});
    expect(r.objective).toBe(0);
    expect(r.incumbent).toBeNull();
  });

  it('solves are quiet by default for both kinds, and a caller option can turn the solver output on', async () => {
    const real = await vi.importActual<typeof import('highs')>('highs');
    const lines: string[] = [];
    const highs = await real.default({ print: (s: string) => lines.push(s), printErr: (s: string) => lines.push(s) } as never);
    const { solveMipOn, solveLpOn } = await import('../apps/extension/src/worker/optimizerSolve');
    const count = (go: () => void): number => {
      const before = lines.length;
      go();
      return lines.length - before;
    };
    const mipQuiet = count(() => solveMipOn(highs, { kind: 'solve-mip', id: 1, lp: BINARY_MIP }, 0));
    const mipLoud = count(() => solveMipOn(highs, { kind: 'solve-mip', id: 1, lp: BINARY_MIP, options: { output_flag: true } }, 0));
    const lpQuiet = count(() => solveLpOn(highs, { kind: 'solve-lp', id: 1, lp: BINARY_MIP }, 0));
    const lpLoud = count(() => solveLpOn(highs, { kind: 'solve-lp', id: 1, lp: BINARY_MIP, options: { output_flag: true } }, 0));
    expect(mipLoud).toBeGreaterThan(10);
    expect(lpLoud).toBeGreaterThan(10);
    expect(mipQuiet).toBeLessThan(5);
    expect(lpQuiet).toBeLessThan(5);
  });
});

describe('optimizer worker: replies that must stay as before, and a non-finite dual bound', () => {
  it('a failing solve-lp gives the same error reply as before the solve-mip change, and an unsupported request still gets the no-id error', async () => {
    const w = await loadWorker();
    const bad = await w.send({ kind: 'solve-lp', id: 5, lp: BAD_LP });
    expect(Object.keys(bad)).toEqual(['kind', 'id', 'error']);
    expect(bad).toMatchObject({ kind: 'error', id: 5 });
    expect((bad as { error: string }).error).toMatch(/^solve failed: Unable to read LP model/);
    const option = await w.send({ kind: 'solve-lp', id: 6, lp: MIP, options: { nonsense_option: 1 } });
    expect(JSON.stringify(option)).toBe('{"kind":"error","id":6,"error":"solve failed: Unable to set option \'nonsense_option\'. HiGHS error -1"}');
    for (const message of [{ kind: 'plan-lineup' }, null, { kind: 'solve-lp', id: 'x', lp: MIP }, { kind: 'solve-lp', id: 8, lp: 5 }]) {
      const r = await w.send(message);
      expect(JSON.stringify(r)).toBe(`{"kind":"error","error":${JSON.stringify(OPTIMIZER_UNAVAILABLE)}}`);
    }
  });

  it('an infinite or missing dual bound is reported as null, never as a number', async () => {
    const { solveMipOn } = await import('../apps/extension/src/worker/optimizerSolve');
    const stub = (bound: number | 'throws') =>
      ({
        createModel: () => ({
          readModel: () => undefined,
          options: { set: () => undefined },
          run: () => undefined,
          getModelStatus: () => 13,
          info: {
            get: (name: string) => {
              if (name === 'primal_solution_status') return 2;
              if (bound === 'throws') throw new Error('not reported');
              return bound;
            },
          },
          getRunTime: () => 0.1,
          getObjectiveValue: () => 5,
          getSolution: () => ({ colValue: [1] }),
          getColName: () => 'x',
          dispose: () => undefined,
        }),
      }) as never;
    for (const bound of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 'throws'] as const) {
      const r = solveMipOn(stub(bound), { kind: 'solve-mip', id: 1, lp: 'x' }, 0);
      expect(r.dualBound, String(bound)).toBeNull();
      expect(r.incumbent).toEqual({ objective: 5, columns: { x: 1 } });
    }
    expect(solveMipOn(stub(12), { kind: 'solve-mip', id: 1, lp: 'x' }, 0).dualBound).toBe(12);
  });
});
