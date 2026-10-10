// @vitest-environment happy-dom
/**
 * UI review fixes 4 and 5 for the Optimize step.
 *  4. An All-teams apply made before a team is picked has an Undo, and picking a
 *     team does not throw that Undo away.
 *  5. The All-teams dialog drops its result when anything that produced it
 *     changes, and refuses to apply a result computed against a lineup that has
 *     since moved.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type Workspace } from '@omniswim/core/types';
import RosterOptimizeStep from '../packages/manager/src/components/RosterOptimizeStep';
import BatchOptimizerPanel from '../packages/manager/src/components/BatchOptimizerPanel';
import { HOME_TEAM, buildMeetWorkspace, resolvedScoringSettings } from './optimizerStepFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gainWorkspace = () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });

describe('fix 4: All-teams Undo exists with no team picked and survives picking one', () => {
  // Like the app, the workspace prop follows every update; Undo checks the lineup is still what
  // the run left. `live` is the current workspace, and `follow` redraws the step when it changes.
  let live: Workspace;
  let liveTeam = '';
  function stepElement(ws: Workspace, selectedTeam: string, onUpdate: (p: Partial<Workspace>) => void) {
    live = live ?? ws;
    liveTeam = selectedTeam;
    return createElement(ToastProvider, null,
      createElement(RosterOptimizeStep, {
        workspace: live, gender: Gender.MEN, scoringSettings: resolvedScoringSettings(ws),
        whatIfMode: true, removeSeniors: false, selectedTeam, teams: [HOME_TEAM],
        onUpdate: (p: Partial<Workspace>) => {
          onUpdate(p);
          live = { ...live, ...p };
          root.render(stepElement(ws, liveTeam, onUpdate));
        },
      }));
  }
  beforeEach(() => { live = undefined as unknown as Workspace; });

  it('applies in the no-team state, shows Undo, and Undo restores the pre-run state', async () => {
    const ws = gainWorkspace();
    const updates: Array<Partial<Workspace>> = [];
    await act(async () => root.render(stepElement(ws, '', p => updates.push(p))));
    await click(/^All teams…$/);
    await click(/Run optimizer/);
    await settle();
    await click(/Apply to workspace/);
    expect(updates).toHaveLength(1);
    expect(updates[0].meetEntryPlans?.length).toBeGreaterThan(0);

    expect(findButton(/Undo this optimize/), 'Undo in the no-team state').toBeTruthy();
    await click(/Undo this optimize/);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({
      scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
      meetEntryPlans: ws.meetEntryPlans ?? [],
      activeEntryIds: ws.activeEntryIds ?? [],
    });
  });

  it('keeps the All-teams Undo when a team is picked afterwards', async () => {
    const ws = gainWorkspace();
    const updates: Array<Partial<Workspace>> = [];
    await act(async () => root.render(stepElement(ws, '', p => updates.push(p))));
    await click(/^All teams…$/);
    await click(/Run optimizer/);
    await settle();
    await click(/Apply to workspace/);
    expect(findButton(/Undo this optimize/)).toBeTruthy();

    await act(async () => root.render(stepElement(ws, HOME_TEAM, p => updates.push(p))));
    expect(findButton(/Undo this optimize/), 'Undo after picking a team').toBeTruthy();
    await click(/Undo this optimize/);
    expect(updates).toHaveLength(2);
  });

  it('still clears a per-team Undo when the team changes', async () => {
    const ws = gainWorkspace();
    const updates: Array<Partial<Workspace>> = [];
    const render = (team: string, teams: string[]) =>
      act(async () => root.render(createElement(ToastProvider, null,
        createElement(RosterOptimizeStep, {
          workspace: ws, gender: Gender.MEN, scoringSettings: resolvedScoringSettings(ws),
          whatIfMode: true, removeSeniors: false, selectedTeam: team, teams, onUpdate: p => updates.push(p),
        }))));
    await render(HOME_TEAM, [HOME_TEAM, 'Other']);
    await click(/Quick optimize \(greedy\)/);
    expect(findButton(/Undo this optimize/)).toBeTruthy();
    await render('Other', [HOME_TEAM, 'Other']);
    expect(findButton(/Undo this optimize/)).toBeUndefined();
  });
});

describe('fix 5: the All-teams dialog result cannot outlive its inputs', () => {
  type PanelProps = Parameters<typeof BatchOptimizerPanel>[0];
  function panel(ws: Workspace, overrides: Partial<PanelProps> & { onApply: PanelProps['onApply'] }) {
    return createElement(ToastProvider, null,
      createElement(BatchOptimizerPanel, {
        workspace: ws, gender: Gender.MEN, scoringSettings: resolvedScoringSettings(ws),
        removeSeniors: false, onClose: () => {}, ...overrides,
      }));
  }
  const renderPanel = (ws: Workspace, o: Partial<PanelProps> & { onApply: PanelProps['onApply'] }) =>
    act(async () => root.render(panel(ws, o)));
  const runIt = async () => { await click(/Run optimizer/); await settle(); };

  it('Run Full, switch to Scorers Only, then Apply has nothing to apply', async () => {
    const onApply = vi.fn();
    await renderPanel(gainWorkspace(), { onApply });
    await runIt();
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(false);
    await click(/Scorers Only/);
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);
    await click(/Apply to workspace/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('drops the result when Drop seniors changes', async () => {
    const onApply = vi.fn();
    const ws = gainWorkspace();
    await renderPanel(ws, { onApply, removeSeniors: false });
    await runIt();
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(false);
    await renderPanel(ws, { onApply, removeSeniors: true });
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops the result when the gender changes', async () => {
    const onApply = vi.fn();
    const ws = gainWorkspace();
    await renderPanel(ws, { onApply });
    await runIt();
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(false);
    await renderPanel(ws, { onApply, gender: Gender.WOMEN });
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops the result when the scoring rules change, but not when an equal copy arrives', async () => {
    const onApply = vi.fn();
    const ws = gainWorkspace();
    await renderPanel(ws, { onApply });
    await runIt();
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(false);
    // Fresh object, same content (resolvedScoringSettings builds a new one each call).
    await renderPanel(ws, { onApply, scoringSettings: resolvedScoringSettings(ws) });
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(false);
    await renderPanel(ws, { onApply, scoringSettings: { ...resolvedScoringSettings(ws), relayMultiplier: 7 } });
    expect((findButton(/Apply to workspace/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses to apply after the lineup arrays moved since the run, and says to run again', async () => {
    const onApply = vi.fn();
    const ws = gainWorkspace();
    await renderPanel(ws, { onApply });
    await runIt();
    // The coach edits a lineup elsewhere: same scoring inputs, new plans array.
    const moved: Workspace = { ...ws, meetEntryPlans: [...(ws.meetEntryPlans ?? [])] };
    await renderPanel(moved, { onApply });
    await click(/Apply to workspace/);
    expect(onApply).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Lineup changed, run again');
  });

  it('applies when the lineup arrays are untouched since the run', async () => {
    const onApply = vi.fn();
    const ws = gainWorkspace();
    await renderPanel(ws, { onApply });
    await runIt();
    // A re-render with an unrelated workspace field changing keeps the three arrays.
    await renderPanel({ ...ws, name: 'renamed' } as Workspace, { onApply });
    await click(/Apply to workspace/);
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
