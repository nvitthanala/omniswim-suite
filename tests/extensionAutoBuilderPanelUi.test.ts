// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The stateful AutoBuilder panel (U1-b), rendered in happy-dom against a fake AutoBuild client and a real store.
 * The fake client records the request and answers when the test says so; the store holds config C with the coach choices a run
 * needs (tests/helpers/autoBuilderFixtures.ts). What is pinned: the controls and the request they build, Run, progress, Cancel,
 * the status messages the page panel gets, a refusal with its code and subject, the missing-choice message, a stale snapshot, and Accept.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AutoBuildResult } from '@omniswim/engine';
import { AutoBuilderPanel } from '../apps/extension/src/dashboard/autoBuilderPanel';
import { AutoBuildRunError, AUTOBUILD_CANCELLED } from '../apps/extension/src/dashboard/autobuilderClient';
import type { AutoBuildClient, AutoBuildRun } from '../apps/extension/src/dashboard/autobuilderClient';
import type { AutoBuildWireRequest } from '../apps/extension/src/shared/autobuilderProtocol';
import type { AutoBuildStatusMessage } from '../apps/extension/src/shared/panelProtocol';
import { configCWorld, realSolveLp, runWorld } from './helpers/autoBuilderFixtures';
import type { ConfigCWorld } from './helpers/autoBuilderFixtures';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client the test drives: `runTimed` waits for `finish`, `fail` or `cancel`. */
class FakeClient implements AutoBuildClient {
  requests: AutoBuildWireRequest[] = [];
  cancels = 0;
  private progress: (p: { solvesDone: number; elapsedMs: number; limitMs: number }) => void = () => undefined;
  private settle: { resolve(r: AutoBuildRun): void; reject(e: Error): void } | undefined;

  runTimed(req: AutoBuildWireRequest, onProgress: (p: { solvesDone: number; elapsedMs: number; limitMs: number }) => void): Promise<AutoBuildRun> {
    this.requests.push(req);
    this.progress = onProgress;
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }
  async run(req: AutoBuildWireRequest, onProgress: (p: { solvesDone: number; elapsedMs: number; limitMs: number }) => void): Promise<AutoBuildResult> {
    return (await this.runTimed(req, onProgress)).result;
  }
  cancel(): void {
    this.cancels += 1;
    this.settle?.reject(new Error(AUTOBUILD_CANCELLED));
  }
  report(solvesDone: number): void {
    this.progress({ solvesDone, elapsedMs: 0, limitMs: 0 });
  }
  finish(run: AutoBuildRun): void {
    this.settle?.resolve(run);
  }
  fail(error: Error): void {
    this.settle?.reject(error);
  }
}

let world: ConfigCWorld;
let tagged: Awaited<ReturnType<typeof runWorld>>;
let root: Root | undefined;
let host: HTMLElement | undefined;

beforeAll(async () => {
  world = await configCWorld();
  tagged = await runWorld(world);
}, 120_000);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

interface Mounted {
  readonly client: FakeClient;
  readonly statuses: AutoBuildStatusMessage[];
  readonly q: (testId: string) => HTMLElement | null;
  readonly rerender: (snapshot: typeof world.snapshot) => Promise<void>;
  readonly text: () => string;
}

async function mount(over: { snapshot?: typeof world.snapshot; repo?: typeof world.repo; clock?: { t: number } } = {}): Promise<Mounted> {
  const client = new FakeClient();
  const statuses: AutoBuildStatusMessage[] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const clock = over.clock ?? { t: 0 };
  const element = (snapshot: typeof world.snapshot): React.ReactElement =>
    React.createElement(AutoBuilderPanel, { snapshot, repoForMeet: async () => over.repo ?? world.repo, solveLp: realSolveLp, onStatus: (m) => statuses.push(m), client, now: () => clock.t });
  await act(async () => root?.render(element(over.snapshot ?? world.snapshot)));
  return {
    client,
    statuses,
    q: (id) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null,
    rerender: async (snapshot) => {
      await act(async () => root?.render(element(snapshot)));
    },
    text: () => (host?.textContent ?? '').replace(/\s+/g, ' '),
  };
}

/** Set a controlled input or select the way a user does, so React sees it. */
async function change(el: HTMLElement | null, value: string): Promise<void> {
  const target = el as HTMLInputElement | HTMLSelectElement;
  const proto = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value);
    target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(el: HTMLElement | null): Promise<void> {
  await act(async () => el?.click());
}
const settle = async (): Promise<void> => {
  // Let the store reads and the opponent re-suggest finish: they are real async work.
  for (let i = 0; i < 40; i += 1) await act(async () => new Promise((r) => setTimeout(r, 25)));
};
const waitFor = async (check: () => boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the panel');
    await act(async () => new Promise((r) => setTimeout(r, 25)));
  }
};

describe('AutoBuilderPanel controls', () => {
  it('offers the five goals, shows the fields of the chosen goal, and builds the request from them', async () => {
    const m = await mount();
    const mode = m.q('ab-mode') as HTMLSelectElement;
    expect([...mode.options].map((o) => o.value)).toStrictEqual(['max-own', 'margin', 'closest', 'robust', 'goal-seek']);
    expect(m.q('ab-rival')).toBeNull();
    // Margin needs a rival: Run stays off until one is chosen.
    await change(mode, 'margin');
    expect((m.q('ab-run') as HTMLButtonElement).disabled).toBe(true);
    await change(m.q('ab-rival'), '48');
    expect((m.q('ab-run') as HTMLButtonElement).disabled).toBe(false);
    // Goal seek shows its target fields.
    await change(mode, 'goal-seek');
    expect(m.q('ab-goal-points')).not.toBeNull();
    await change(m.q('ab-goal-points'), '1500');
    await click(m.q('ab-swaps'));
    await change(m.q('ab-limit'), '20');
    await click(m.q('ab-run'));
    await waitFor(() => m.client.requests.length === 1);
    const req = m.client.requests[0] as AutoBuildWireRequest;
    expect(req.objective).toStrictEqual({ kind: 'goal-seek', target: { kind: 'total', points: 1500 } });
    expect(req.roster).toBe('propose-swaps');
    expect(req.limits.timeLimitSeconds).toBe(20);
    m.client.cancel();
    await settle();
  }, 60_000);

  it('refuses a time limit outside 1 to 120 seconds', async () => {
    const m = await mount();
    await change(m.q('ab-limit'), '0');
    expect((m.q('ab-run') as HTMLButtonElement).disabled).toBe(true);
    expect(m.text()).toContain('The time limit must be from 1 to 120 seconds.');
    await change(m.q('ab-limit'), '121');
    expect((m.q('ab-run') as HTMLButtonElement).disabled).toBe(true);
    await change(m.q('ab-limit'), '120');
    expect((m.q('ab-run') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('AutoBuilderPanel run, progress, cancel and status', () => {
  it('shows solves done and elapsed against the limit, tells the page panel, and ends cancelled on Cancel', async () => {
    const clock = { t: 1000 };
    const m = await mount({ clock });
    expect((m.q('ab-cancel') as HTMLButtonElement).disabled).toBe(true);
    await click(m.q('ab-run'));
    await waitFor(() => m.client.requests.length === 1);
    clock.t = 4200;
    m.client.report(2);
    await waitFor(() => /Running: 2 solves done, 3\.2 s of 10 s/.test(m.text()));
    expect(m.q('ab-status')?.getAttribute('data-phase')).toBe('running');
    expect((m.q('ab-run') as HTMLButtonElement).disabled).toBe(true);
    expect((m.q('ab-cancel') as HTMLButtonElement).disabled).toBe(false);
    expect(m.statuses.at(-1)).toMatchObject({ kind: 'auto-build-status', status: 'running', limitMs: 10000 });
    await click(m.q('ab-cancel'));
    await waitFor(() => m.q('ab-status')?.getAttribute('data-phase') === 'cancelled');
    expect(m.text()).toContain('Cancelled. Nothing was changed.');
    expect(m.client.cancels).toBe(1);
    expect(m.statuses.at(-1)).toMatchObject({ status: 'cancelled', limitMs: 10000 });
    expect(m.q('ab-result')).toBeNull();
    // After a cancel the controls are free again.
    expect((m.q('ab-run') as HTMLButtonElement).disabled).toBe(false);
    expect((m.q('ab-cancel') as HTMLButtonElement).disabled).toBe(true);
  }, 60_000);

  it('shows the result when the run ends, and says done', async () => {
    const m = await mount();
    await click(m.q('ab-run'));
    await waitFor(() => m.client.requests.length === 1);
    m.client.finish({ result: tagged.result, loadMs: 120, wallMs: 4100 });
    await waitFor(() => m.q('ab-result') !== null);
    expect(m.q('ab-headline')?.textContent).toBe('Better lineup found');
    expect(m.q('ab-result')?.getAttribute('data-result-kind')).toBe('improved');
    expect(m.statuses.at(-1)).toMatchObject({ status: 'done' });
    expect(m.text()).toContain('HiGHS load 0.1 s, run 4.1 s');
  }, 60_000);

  it('shows a refusal with its code and subject, and reports failed', async () => {
    const m = await mount();
    await change(m.q('ab-mode'), 'goal-seek');
    await change(m.q('ab-goal-points'), '1500');
    await click(m.q('ab-run'));
    await waitFor(() => m.client.requests.length === 1);
    m.client.fail(new AutoBuildRunError('autobuild', 'mode_not_built', 'goal-seek-prefer', 'goal seek with prefer is not built'));
    await waitFor(() => m.q('ab-status')?.getAttribute('data-phase') === 'refused');
    expect(m.q('ab-status')?.textContent).toBe('This mode and load setting are not built together. (mode_not_built: goal-seek-prefer)');
    expect(m.statuses.at(-1)).toMatchObject({ status: 'failed' });
  }, 60_000);

  it('says what is missing when the coach has not chosen a team or rules, and sends no request', async () => {
    const empty = await configCWorld();
    try {
      const other = { ...world.snapshot, settings: { ...world.snapshot.settings, startDate: '2002-02-02' } };
      const m = await mount({ snapshot: other, repo: empty.repo });
      await click(m.q('ab-run'));
      await waitFor(() => m.q('ab-status')?.getAttribute('data-phase') === 'missing');
      expect(m.text()).toMatch(/Cannot run yet:.*Choose your team in the page panel\..*scoring rules/);
      expect(m.client.requests).toHaveLength(0);
      expect(m.statuses).toHaveLength(0);
    } finally {
      empty.close();
    }
  }, 60_000);
});

describe('AutoBuilderPanel Accept', () => {
  it('blocks Accept when the simulator changed after the run, and lets it through when it did not', async () => {
    const m = await mount();
    await click(m.q('ab-run'));
    await waitFor(() => m.client.requests.length === 1);
    m.client.finish({ result: tagged.result, loadMs: 0, wallMs: 1 });
    await waitFor(() => m.q('ab-accept-button') !== null);
    expect((m.q('ab-accept-button') as HTMLButtonElement).disabled).toBe(false);
    // The page posts a new snapshot: the result is tagged with the old one.
    // Hold on: the tag is the snapshot the run STARTED with, which here is `world.snapshot`, so a different one is stale.
    await m.rerender({ ...world.snapshot, settings: { ...world.snapshot.settings, maxScorersPerTeam: world.snapshot.settings.maxScorersPerTeam + 1 } });
    expect((m.q('ab-accept-button') as HTMLButtonElement).disabled).toBe(true);
    expect(m.q('ab-block')?.textContent).toMatch(/Accept is blocked\. The SwimCloud simulator changed after this run/);
    expect(m.q('ab-stale')?.textContent).toBe('This result is from an earlier simulator state.');
    await m.rerender(world.snapshot);
    expect((m.q('ab-accept-button') as HTMLButtonElement).disabled).toBe(false);
  }, 60_000);

  it('Accept saves the lineup, shows the SwimCloud to-do list and disables itself', async () => {
    const w = await configCWorld();
    try {
      const m = await mount({ repo: w.repo, snapshot: w.snapshot });
      await click(m.q('ab-run'));
      await waitFor(() => m.client.requests.length === 1);
      const own = await runWorld(w);
      m.client.finish({ result: own.result, loadMs: 0, wallMs: 1 });
      await waitFor(() => m.q('ab-accept-button') !== null);
      await click(m.q('ab-accept-button'));
      await waitFor(() => m.q('ab-accepted') !== null || m.q('ab-block') !== null);
      expect(m.q('ab-block')).toBeNull();
      expect(m.q('ab-accepted')?.textContent).toMatch(/Saved\. The lineup is stored as "AutoBuilder: max own points/);
      expect(m.q('ab-todo')?.querySelectorAll('li').length).toBeGreaterThan(0);
      expect((m.q('ab-accept-button') as HTMLButtonElement).disabled).toBe(true);
      expect((await w.repo.list('lineups')).length).toBe(1);
    } finally {
      w.close();
    }
  }, 120_000);
});
