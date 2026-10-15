/**
 * A fake `Worker` that runs the REAL scoringWorker message handler, in this
 * thread, with structured-clone copies on both legs of every message.
 *
 * Vitest has no Worker, so without this the worker branch of
 * `optimizeClient.ts` and the `optimize` op in `scoringWorker.ts` get no
 * coverage at all. The harness loads `scoringWorker.ts` against a stubbed
 * `self` (after `vi.resetModules()`, so the handler holds its own copy of the
 * core modules, as a real worker would) and routes `postMessage` to it.
 *
 * Modes:
 *  - `auto: true`  each posted request runs on the next timer tick and every
 *                  reply is delivered straight away.
 *  - `auto: false` the test drives it: `runHandler()` computes and fills the
 *                  outbox, `deliverNext()` / `flush()` hand replies to the client.
 */
import { vi } from 'vitest';

type MessageHandler = ((event: { data: unknown }) => void) | null;
type ErrorHandler = ((event: { message: string }) => void) | null;

export class FakeWorker {
  onmessage: MessageHandler = null;
  onerror: ErrorHandler = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  /** How many times the client called `terminate()`. */
  terminateCalls = 0;
  /** Requests the client posted, cloned. */
  inbox: unknown[] = [];
  /** Replies the handler produced and the client has not seen yet. */
  outbox: unknown[] = [];
  /** Replies delivered to the client, in order. */
  delivered: unknown[] = [];

  constructor(
    readonly url: unknown,
    readonly options: unknown,
    private readonly harness: FakeWorkerHarness
  ) {
    harness.workers.push(this);
  }

  postMessage(message: unknown): void {
    if (this.harness.postError) throw this.harness.postError;
    if (this.terminated) return;
    this.inbox.push(structuredClone(message));
    if (this.harness.auto) {
      setTimeout(() => {
        if (this.terminated) return;
        this.runHandler();
        this.flush();
      }, 0);
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.terminated = true;
  }

  /** Run every request in the inbox through the real worker handler. */
  runHandler(): void {
    const requests = this.inbox.splice(0);
    for (const data of requests) {
      this.harness.active = this;
      try {
        this.harness.ctx.onmessage?.({ data });
      } finally {
        this.harness.active = null;
      }
    }
  }

  /** Deliver one reply to the client. Returns false when none is waiting or the worker is gone. */
  deliverNext(): boolean {
    if (this.terminated || this.outbox.length === 0) return false;
    const data = this.outbox.shift();
    this.delivered.push(data);
    this.onmessage?.({ data });
    return true;
  }

  flush(): void {
    while (this.deliverNext()) {
      /* drain */
    }
  }
}

export type FakeWorkerHarness = {
  workers: FakeWorker[];
  auto: boolean;
  /** When set, `postMessage` throws it, as a structured-clone failure does. */
  postError: Error | null;
  active: FakeWorker | null;
  ctx: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  /** Put every global back. Call from `afterEach`. */
  restore: () => void;
};

/**
 * Install the fake Worker and load the real worker handler against it.
 * `window` is stubbed only when the test environment has none (node).
 */
export async function installFakeOptimizeWorker(
  options: { auto?: boolean } = {}
): Promise<FakeWorkerHarness> {
  const harness: FakeWorkerHarness = {
    workers: [],
    auto: options.auto ?? true,
    postError: null,
    active: null,
    ctx: {
      onmessage: null,
      postMessage(message: unknown) {
        // The worker answers whichever instance is running its handler.
        harness.active?.outbox.push(structuredClone(message));
      },
    },
    restore: () => {
      vi.unstubAllGlobals();
    },
  };

  class BoundFakeWorker extends FakeWorker {
    constructor(url: unknown, opts: unknown) {
      super(url, opts, harness);
    }
  }

  vi.resetModules();
  vi.stubGlobal('self', harness.ctx);
  await import('../../packages/core/src/workers/scoringWorker');
  // The worker module reads `self` once, at import. Leaving it stubbed breaks `new URL` under happy-dom.
  vi.unstubAllGlobals();
  if (typeof window === 'undefined') vi.stubGlobal('window', {});
  vi.stubGlobal('Worker', BoundFakeWorker);
  return harness;
}
