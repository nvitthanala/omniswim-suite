// @vitest-environment happy-dom
/**
 * The Lineup step's one-click "Optimize all teams" runs in the scoring worker.
 *
 * The fake Worker (tests/helpers/fakeOptimizeWorker.ts) runs the REAL worker
 * handler in manual mode, so each test decides when the worker computes and
 * when its replies reach the page. Pinned here:
 *  - nothing is computed or applied on the main thread: the click posts one
 *    `allTeams` job and the lineup is untouched until the reply lands;
 *  - progress reads "Optimizing N of M teams" with a Cancel;
 *  - the applied patch and the toast gain equal the synchronous engine's;
 *  - Cancel, and any change to what the run read, applies nothing and keeps an
 *    earlier Undo armed.
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type Workspace } from '@omniswim/core/types';
import { mergeScoringSettings } from '../../packages/core/src/lib/scoringDefaults';
import TeamRosterHeader from '../packages/manager/src/components/TeamRosterHeader';
import { useAllTeamsApply } from '../packages/manager/src/components/useAllTeamsApply';
import {
  buildBatchApplyPatch,
  computeBatchOptimizationResult,
} from '../packages/manager/src/components/batchOptimizerView';
import { HOME_TEAM, buildMeetWorkspace, resolvedScoringSettings } from '../../tests/optimizerStepFixtures';
import { installFakeOptimizeWorker, type FakeWorkerHarness } from '../../tests/helpers/fakeOptimizeWorker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function stable<T>(value: T): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value).replace(UUID, id => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
      return ids.get(id)!;
    })
  );
}

const CANCELLED = 'Optimization cancelled. Nothing was changed.';
const CHANGED = 'changed while the optimizer ran';

let container: HTMLDivElement;
let root: Root;
let harness: FakeWorkerHarness;
let live: Workspace;
let updates: Array<Partial<Workspace>>;
let setGender: (g: Gender) => void;
let setWs: (fn: (prev: Workspace) => Workspace) => void;

const buttons = () => Array.from(document.querySelectorAll('button'));
const findButton = (text: RegExp) =>
  buttons().find(b => text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''));
const click = async (text: RegExp) => {
  const button = findButton(text);
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const finishWorker = async (index = 0) => {
  const worker = harness.workers[index]!;
  worker.runHandler();
  await act(async () => {
    worker.flush();
    await Promise.resolve();
  });
  await tick();
};
const text = () => document.body.textContent ?? '';

const baseWs = () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });

/** The Lineup header with the hook wired the way TeamRosterPanel wires it. */
function Harness({ initial, editable = true }: { initial: Workspace; editable?: boolean }) {
  const [ws, setWsState] = useState<Workspace>(initial);
  const [gender, setGenderState] = useState<Gender>(Gender.MEN);
  live = ws;
  setGender = setGenderState;
  setWs = fn => setWsState(fn);
  const allTeams = useAllTeamsApply({
    workspace: ws,
    gender,
    settings: resolvedScoringSettings(initial),
    editable,
    onWorkspaceUpdate: patch => {
      updates.push(patch);
      setWsState(prev => ({ ...prev, ...patch }));
    },
  });
  return createElement(TeamRosterHeader, {
    selectedTeam: HOME_TEAM,
    genderLabel: "Men's",
    editable,
    onResetTeam: () => undefined,
    maxIndividualScorersPerTeam: 3,
    selectedActual: undefined,
    selectedBaseline: undefined,
    selectedProjected: 0,
    useDropdown: false,
    teams: [HOME_TEAM],
    onSelectTeam: () => undefined,
    onOptimizeAllTeams: allTeams.run,
    allTeamsBusy: allTeams.busy,
    allTeamsRun: allTeams.progress,
    onCancelAllTeams: allTeams.cancel,
  });
}

beforeEach(async () => {
  harness = await installFakeOptimizeWorker({ auto: false });
  updates = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  harness.restore();
});

const mount = (initial: Workspace, props: { editable?: boolean } = {}) =>
  act(async () => root.render(createElement(ToastProvider, null, createElement(Harness, { initial, ...props }))));

describe('Optimize all teams runs in the worker', () => {
  it('posts one allTeams job at the click and changes nothing until the reply lands', async () => {
    const ws = baseWs();
    await mount(ws);
    await click(/Optimize all teams/);

    // Not synchronous: the work is a posted request, and the lineup has not moved.
    expect(harness.workers).toHaveLength(1);
    const request = harness.workers[0]!.inbox[0] as {
      op: string;
      gender: string;
      job: { kind: string; stage: string; removeSeniors: boolean };
    };
    expect(request.op).toBe('optimize');
    expect(request.job).toMatchObject({ kind: 'allTeams', stage: 'all', removeSeniors: false });
    expect(updates).toHaveLength(0);
    expect(live).toBe(ws);
    expect((findButton(/^Optimizing…$/) as HTMLButtonElement).disabled).toBe(true);
    expect(findButton(/Cancel run/)).toBeTruthy();

    await finishWorker();
    expect(updates).toHaveLength(1);
    expect(findButton(/Cancel run/)).toBeUndefined();
    expect(findButton(/^Optimize all teams$/)).toBeTruthy();
  });

  it('shows "Optimizing N of M teams" as the worker reaches each team', async () => {
    await mount(baseWs());
    await click(/Optimize all teams/);
    const worker = harness.workers[0]!;
    worker.runHandler();
    await act(async () => {
      worker.deliverNext(); // "started"
      worker.deliverNext();
    });
    expect(text()).toContain('Optimizing 1 of 2 teams');
    await act(async () => {
      worker.deliverNext();
    });
    expect(text()).toContain('Optimizing 2 of 2 teams');
    expect(updates).toHaveLength(0);
    await finishWorker();
    expect(updates).toHaveLength(1);
  });

  it('applies the same patch and gain as the synchronous engine', async () => {
    const ws = baseWs();
    await mount(ws);
    await click(/Optimize all teams/);
    await finishWorker();

    const merged = mergeScoringSettings(resolvedScoringSettings(ws), { conference: ws.conference });
    const sync = computeBatchOptimizationResult(ws, Gender.MEN, merged, 'all', false);
    expect(sync.outcome).toBe('improved');
    const syncPatch = buildBatchApplyPatch(sync)!;
    expect(updates).toHaveLength(1);
    expect(stable(updates[0])).toEqual(stable(syncPatch));
    const gain = sync.optimizer.projectedTotal - sync.optimizer.previousTotal;
    expect(text()).toContain(`All teams: +${gain.toFixed(1)} pts across the field.`);
    expect(findButton(/Undo/)).toBeTruthy();
  });

  it('writes nothing and arms no Undo when the run changes nothing', async () => {
    // The meet is held and no team can gain: the engine answers `unchanged`.
    const ws = buildMeetWorkspace();
    const merged = mergeScoringSettings(resolvedScoringSettings(ws), { conference: ws.conference });
    expect(computeBatchOptimizationResult(ws, Gender.MEN, merged, 'all', false).outcome).toBe('unchanged');
    await mount(ws);
    await click(/Optimize all teams/);
    await finishWorker();

    expect(harness.workers).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(live).toBe(ws);
    expect(findButton(/Undo/)).toBeUndefined();
    expect(text()).toContain('No lineup change improved the field');
  });

  it('ignores a second click while the run is in flight', async () => {
    await mount(baseWs());
    await click(/Optimize all teams/);
    await click(/Optimizing…/);
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.terminated).toBe(false);
    await finishWorker();
    expect(updates).toHaveLength(1);
  });
});

describe('Cancel and stale results apply nothing', () => {
  it('Cancel run stops the worker, says nothing changed, and a late reply applies nothing', async () => {
    const ws = baseWs();
    await mount(ws);
    await click(/Optimize all teams/);
    const worker = harness.workers[0]!;
    worker.runHandler();
    await act(async () => {
      worker.deliverNext();
    });
    await click(/Cancel run/);

    expect(worker.terminated).toBe(true);
    expect(text()).toContain(CANCELLED);
    expect(findButton(/Cancel run/)).toBeUndefined();
    expect((findButton(/^Optimize all teams$/) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      worker.onmessage?.({ data: worker.outbox.shift() });
    });
    await tick();
    expect(updates).toHaveLength(0);
    expect(live).toBe(ws);
    expect(findButton(/Undo/)).toBeUndefined();
  });

  it('drops the result when a lineup array was edited while the worker ran', async () => {
    await mount(baseWs());
    await click(/Optimize all teams/);
    await act(async () => setWs(prev => ({ ...prev, meetEntryPlans: [...(prev.meetEntryPlans ?? [])] })));
    await finishWorker();

    expect(updates).toHaveLength(0);
    expect(text()).toContain(CHANGED);
    expect(findButton(/Undo/)).toBeUndefined();
  });

  for (const field of ['athleteAliases', 'deletedSwimmers', 'recruits', 'athleteHistory'] as const) {
    it(`drops the result when ${field} changed while the worker ran`, async () => {
      await mount(baseWs());
      await click(/Optimize all teams/);
      await act(async () => setWs(prev => ({ ...prev, [field]: [...(prev[field] ?? [])] }) as Workspace));
      await finishWorker();

      expect(updates).toHaveLength(0);
      expect(text()).toContain(CHANGED);
    });
  }

  it('does not drop the result for a field the optimizer does not read', async () => {
    await mount(baseWs());
    await click(/Optimize all teams/);
    // Autosave replaces the workspace object without touching anything the run read.
    await act(async () => setWs(prev => ({ ...prev, raceAnalyses: [...(prev.raceAnalyses ?? [])] })));
    await finishWorker();
    expect(updates).toHaveLength(1);
  });

  it('stops the run when the gender changes', async () => {
    await mount(baseWs());
    await click(/Optimize all teams/);
    const worker = harness.workers[0]!;
    await act(async () => setGender(Gender.WOMEN));
    expect(worker.terminated).toBe(true);
    expect(updates).toHaveLength(0);
    expect(findButton(/Cancel run/)).toBeUndefined();
  });

  it('stops the run when the view goes read-only', async () => {
    const ws = baseWs();
    await act(async () => root.render(createElement(ToastProvider, null, createElement(Harness, { initial: ws }))));
    await click(/Optimize all teams/);
    const worker = harness.workers[0]!;
    await act(async () =>
      root.render(createElement(ToastProvider, null, createElement(Harness, { initial: ws, editable: false })))
    );
    expect(worker.terminated).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('stops the run when the Lineup step goes away', async () => {
    await mount(baseWs());
    await click(/Optimize all teams/);
    const worker = harness.workers[0]!;
    await act(async () => root.render(createElement('div')));
    expect(worker.terminated).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('keeps the earlier Undo armed when a later run is cancelled', async () => {
    await mount(baseWs());
    await click(/Optimize all teams/);
    await finishWorker(0);
    expect(findButton(/Undo/)).toBeTruthy();

    await click(/Optimize all teams/);
    expect(harness.workers).toHaveLength(2);
    await click(/Cancel run/);
    expect(text()).toContain(CANCELLED);
    expect(findButton(/Undo/)).toBeTruthy();
  });
});
