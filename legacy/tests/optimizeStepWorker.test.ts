// @vitest-environment happy-dom
/**
 * R4: the Optimize step runs its optimizers in the scoring worker.
 *
 * The fake Worker (tests/helpers/fakeOptimizeWorker.ts) runs the real worker
 * handler in manual mode, so each test decides when the worker computes and
 * when its replies reach the step. Pinned here:
 *  - progress and a Cancel show while a run is in flight, and the run buttons wait;
 *  - a cancelled run, or one the coach moved away from, changes nothing;
 *  - the worker result is applied on the main thread exactly as the
 *    synchronous result is (same patch, same Undo);
 *  - a lineup edit made while the worker ran blocks the apply.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type Workspace } from '@omniswim/core/types';
import { optimizeWithArbitrage } from '../../packages/core/src/lib/rosterArbitrage';
import RosterOptimizeStep from '../packages/manager/src/components/RosterOptimizeStep';
import BatchOptimizerPanel from '../packages/manager/src/components/BatchOptimizerPanel';
import { HOME_TEAM, buildMeetWorkspace, resolvedScoringSettings } from '../../tests/optimizerStepFixtures';
import { installFakeOptimizeWorker, type FakeWorkerHarness } from '../../tests/helpers/fakeOptimizeWorker';

vi.mock('motion/react', async () => (await import('../../tests/motionStub')).motionStub);

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

const gainWorkspace = () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });

let container: HTMLDivElement;
let root: Root;
let harness: FakeWorkerHarness;

beforeEach(async () => {
  harness = await installFakeOptimizeWorker({ auto: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  harness.restore();
});

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
/** Let the worker compute, then hand every reply to the client. */
const finishWorker = async (index = 0) => {
  const worker = harness.workers[index]!;
  worker.runHandler();
  await act(async () => {
    worker.flush();
    await Promise.resolve();
  });
  await tick();
};
const statusText = () => document.querySelector('[role="status"]')?.textContent ?? '';

describe('the step runs a team optimizer in the worker', () => {
  let live: Workspace;
  let updates: Array<Partial<Workspace>>;
  let selectedTeam: string;
  let teams: string[];
  let settingsOf: Workspace;

  function draw() {
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(RosterOptimizeStep, {
          workspace: live,
          gender: Gender.MEN,
          scoringSettings: resolvedScoringSettings(settingsOf),
          whatIfMode: true,
          removeSeniors: false,
          selectedTeam,
          teams,
          onUpdate: (patch: Partial<Workspace>) => {
            updates.push(patch);
            live = { ...live, ...patch };
            draw();
          },
        })
      )
    );
  }
  const render = async (ws: Workspace) => {
    live = ws;
    settingsOf = ws;
    updates = [];
    selectedTeam = HOME_TEAM;
    teams = [HOME_TEAM];
    await act(async () => draw());
  };

  it('shows progress and Cancel while it runs, and Cancel changes nothing', async () => {
    const ws = gainWorkspace();
    await render(ws);
    await click(/^Optimize team$/);

    expect(harness.workers).toHaveLength(1);
    expect(statusText()).toContain(`Optimizing ${HOME_TEAM}`);
    expect((findButton(/^Optimize team$/) as HTMLButtonElement).disabled).toBe(true);
    expect(findButton(/Cancel run/)).toBeTruthy();

    await click(/Cancel run/);
    expect(harness.workers[0]!.terminated).toBe(true);
    expect(statusText()).not.toContain('Optimizing');
    expect(document.body.textContent).toContain('Optimization cancelled. Nothing was changed.');
    expect(document.body.textContent).not.toContain('Optimization failed');
    expect((findButton(/^Optimize team$/) as HTMLButtonElement).disabled).toBe(false);

    // Even a reply that was already on its way applies nothing.
    harness.workers[0]!.runHandler();
    await act(async () => {
      harness.workers[0]!.onmessage?.({ data: harness.workers[0]!.outbox.shift() });
    });
    await tick();
    expect(updates).toHaveLength(0);
    expect(live).toBe(ws);
    expect(document.body.textContent).not.toContain('Undo this optimize');
  });

  it('applies the worker result on the main thread exactly as the synchronous result', async () => {
    const ws = gainWorkspace();
    await render(ws);
    await click(/^Optimize team$/);
    await finishWorker();

    expect(updates).toHaveLength(1);
    const sync = optimizeWithArbitrage(
      ws,
      Gender.MEN,
      HOME_TEAM,
      false,
      resolvedScoringSettings(ws),
      'individual_first'
    );
    expect(sync.outcome).toBe('improved');
    expect(stable(updates[0])).toEqual(
      stable({
        scorerRosterOverrides: sync.overrides,
        meetEntryPlans: sync.meetEntryPlans,
        activeEntryIds: sync.activeEntryIds,
      })
    );
    // The summary and Undo are the main-thread ones.
    expect(findButton(/Undo this optimize/)).toBeTruthy();
    expect(statusText()).not.toContain('Optimizing');
  });

  it('does not apply a result when the lineup was edited while the worker ran', async () => {
    const ws = gainWorkspace();
    await render(ws);
    await click(/^Optimize team$/);

    // The coach edits a lineup array elsewhere while the worker computes.
    live = { ...live, meetEntryPlans: [...(live.meetEntryPlans ?? [])] };
    await act(async () => draw());
    await finishWorker();

    expect(updates).toHaveLength(0);
    expect(document.body.textContent).toContain('changed while the optimizer ran');
    expect(findButton(/Undo this optimize/)).toBeUndefined();
  });

  for (const field of ['deletedSwimmers', 'athleteAliases', 'recruits', 'athleteHistory'] as const) {
    it(`drops the result when ${field} changes while the worker runs`, async () => {
      const ws = gainWorkspace();
      await render(ws);
      await click(/^Optimize team$/);

      live = { ...live, [field]: [...(live[field] ?? [])] } as Workspace;
      await act(async () => draw());
      await finishWorker();

      expect(updates).toHaveLength(0);
      expect(document.body.textContent).toContain('changed while the optimizer ran');
      expect(findButton(/Undo this optimize/)).toBeUndefined();
    });
  }

  it('still applies when only an autosave replaced the workspace object', async () => {
    const ws = gainWorkspace();
    await render(ws);
    await click(/^Optimize team$/);

    // Same field references, new outer object, and a field the job never reads.
    live = { ...live, createdAt: live.createdAt + 1 };
    await act(async () => draw());
    await finishWorker();

    expect(updates).toHaveLength(1);
  });

  it('drops the result when the Strategy changes while the worker runs', async () => {
    const ws = gainWorkspace();
    await render(ws);
    await click(/^Optimize team$/);

    const select = document.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'relay_first');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('relay_first');
    await finishWorker();

    expect(updates).toHaveLength(0);
    expect(document.body.textContent).toContain('changed while the optimizer ran');
  });

  it('Quick optimize ignores a Strategy change, since it does not use the Strategy', async () => {
    const ws = gainWorkspace();
    await render(ws);
    await click(/^More options$/);
    await click(/Quick optimize \(greedy\)/);
    expect(harness.workers).toHaveLength(1);

    const select = document.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'relay_first');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await finishWorker();

    expect(updates).toHaveLength(1);
  });

  it('stops the run when the team changes, and applies nothing', async () => {
    const ws = gainWorkspace();
    await render(ws);
    teams = [HOME_TEAM, 'Other'];
    await act(async () => draw());
    await click(/^Optimize team$/);
    expect(harness.workers).toHaveLength(1);

    selectedTeam = 'Other';
    await act(async () => draw());
    expect(harness.workers[0]!.terminated).toBe(true);
    await finishWorker();
    expect(updates).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Optimization failed');
  });

  it('a scan runs in the worker and shows its cards', async () => {
    const ws = gainWorkspace();
    await render(ws);
    await click(/Find point opportunities/);
    expect(statusText()).toContain(`Scanning ${HOME_TEAM}`);
    expect(JSON.stringify(harness.workers[0]!.inbox[0])).toContain('"kind":"scan"');
    await finishWorker();
    expect(statusText()).not.toContain('Scanning');
    expect(document.body.textContent).not.toContain('Find point opportunities');
  });
});

describe('the All-teams dialog runs in the worker', () => {
  type PanelProps = Parameters<typeof BatchOptimizerPanel>[0];
  const ws = gainWorkspace();
  const draw = (o: Partial<PanelProps> & { onApply: PanelProps['onApply'] }) =>
    act(async () =>
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(BatchOptimizerPanel, {
            workspace: ws,
            gender: Gender.MEN,
            scoringSettings: resolvedScoringSettings(ws),
            removeSeniors: false,
            onClose: () => {},
            ...o,
          })
        )
      )
    );

  it('counts teams as the worker reaches them, then offers the result', async () => {
    const onApply = vi.fn();
    await draw({ onApply });
    await click(/Run optimizer/);
    const worker = harness.workers[0]!;
    expect(document.body.textContent).toContain('Optimizing...');

    worker.runHandler();
    await act(async () => {
      worker.deliverNext(); // "started"
      worker.deliverNext();
    });
    expect(document.body.textContent).toContain('Optimizing 1 of 2 teams');
    await act(async () => {
      worker.deliverNext();
    });
    expect(document.body.textContent).toContain('Optimizing 2 of 2 teams');
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      worker.flush();
      await Promise.resolve();
    });
    await tick();
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(false);
    await click(/Apply to workspace/);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('does not apply the old result while a re-run is in flight', async () => {
    const onApply = vi.fn();
    await draw({ onApply });
    await click(/Run optimizer/);
    await finishWorker(0);
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(false);

    await click(/Run optimizer/);
    expect(harness.workers).toHaveLength(2);
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);
    await click(/Apply to workspace/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('drops the result when a field beyond the lineup arrays changes while it runs', async () => {
    const onApply = vi.fn();
    await draw({ onApply });
    await click(/Run optimizer/);
    // The coach links two spellings of a swimmer while the worker computes.
    await draw({ onApply, workspace: { ...ws, athleteAliases: [] } as Workspace });
    await finishWorker(0);

    expect(document.body.textContent).toContain('Lineup changed, run again.');
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);
    await click(/Apply to workspace/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Cancel run leaves nothing to apply', async () => {
    const onApply = vi.fn();
    await draw({ onApply });
    await click(/Run optimizer/);
    const worker = harness.workers[0]!;
    worker.runHandler();
    await act(async () => {
      worker.deliverNext();
    });
    await click(/Cancel run/);
    expect(worker.terminated).toBe(true);
    expect(findButton(/Run optimizer/)).toBeTruthy();
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);
    await click(/Apply to workspace/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('closing the dialog stops the run', async () => {
    const onApply = vi.fn();
    await draw({ onApply });
    await click(/Run optimizer/);
    const worker = harness.workers[0]!;
    await act(async () => root.render(createElement('div')));
    expect(worker.terminated).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });
});
