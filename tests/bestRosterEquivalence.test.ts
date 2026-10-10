// @vitest-environment happy-dom
/**
 * Phase 4 behaviour gate: the Lineup step's "Best roster" and "All teams"
 * buttons (TeamRosterPanel.runOptimizer) were removed because the Optimize step
 * already runs the same optimizer. This file is the proof that no result was
 * lost.
 *
 * tests/fixtures/bestRosterGolden.json is what those two buttons produced at
 * commit fdeaf50a, captured by rendering the real TeamRosterPanel and clicking
 * them, on the fixtures in tests/optimizerStepFixtures.ts. The Optimize step's
 * "Quick optimize (greedy)" (the old "Classic", RosterOptimizeStep.applyLegacy)
 * and its "All teams" dialog must reproduce those values: same scorer
 * overrides, same planned entries, same active ids, same totals. The optimizer
 * mints a random UUID for every plan it adds, so ids are compared by position
 * (see tests/optimizerNormalize.ts).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type Workspace } from '@omniswim/core/types';
import {
  BUILT_IN_SCORING_PRESETS,
  GENERIC_TOP16_SETTINGS,
  NSISC_PRESET_SETTINGS,
  mergeScoringSettings,
} from '@omniswim/core/lib/scoringDefaults';
import { optimizeRosterAllTeams, optimizeRosterForTeam } from '@omniswim/core/lib/rosterOptimizer';
import RosterOptimizeStep from '../packages/manager/src/components/RosterOptimizeStep';
import golden from './fixtures/bestRosterGolden.json';
import { normalizeOptimizerState } from './optimizerNormalize';
import {
  HOME_TEAM,
  buildMeetWorkspace,
  buildRosterOnlyWorkspace,
  resolvedScoringSettings,
} from './optimizerStepFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CaseName = keyof typeof golden.cases;
const CASES: Array<[CaseName, () => Workspace, boolean]> = [
  ['meet-held', () => buildMeetWorkspace(), false],
  ['meet-gain', () => buildMeetWorkspace({ unheldEvent: true }), false],
  ['meet-gain-drop-seniors', () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] }), true],
  ['roster-only', () => buildRosterOnlyWorkspace(), false],
];

/** "Projected 307.0 pts (was 293.0). Apply?" -> the two totals the old confirm showed. */
function totalsFromConfirm(message: string): { projected: number; previous: number } {
  const m = /Projected ([\d.]+) pts \(was ([\d.]+)\)/.exec(message);
  if (!m) throw new Error(`unparseable golden confirm message: ${message}`);
  return { projected: Number(m[1]), previous: Number(m[2]) };
}

describe('Best roster is the Optimize step Quick optimize, on the same fixtures', () => {
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

  const buttonByText = (text: RegExp) => {
    const button = Array.from(container.querySelectorAll('button')).find(b => text.test(b.textContent ?? ''));
    expect(button, `button ${text}`).toBeTruthy();
    return button as HTMLButtonElement;
  };
  const click = async (button: HTMLButtonElement) => {
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });

  async function renderStep(ws: Workspace, removeSeniors: boolean) {
    const patches: Array<Partial<Workspace>> = [];
    await act(async () => {
      root.render(
        createElement(ToastProvider, null,
          createElement(RosterOptimizeStep, {
            workspace: ws,
            gender: Gender.MEN,
            scoringSettings: resolvedScoringSettings(ws),
            whatIfMode: true,
            removeSeniors,
            selectedTeam: HOME_TEAM,
            teams: [HOME_TEAM],
            onUpdate: (patch: Partial<Workspace>) => patches.push(patch),
          })
        )
      );
    });
    return patches;
  }

  /** What the workspace holds after the run: the patch if one was applied, else its own state. */
  const resultingState = (ws: Workspace, patches: Array<Partial<Workspace>>) =>
    normalizeOptimizerState(patches.length ? { ...ws, ...patches[patches.length - 1] } : ws);

  it.each(CASES)('team: %s', async (name, build, removeSeniors) => {
    const ws = build();
    const expected = golden.cases[name].team;
    const patches = await renderStep(ws, removeSeniors);
    await click(buttonByText(/^Quick optimize \(greedy\)$/));

    expect(resultingState(ws, patches)).toEqual(expected.applied);

    const { projected, previous } = totalsFromConfirm(expected.confirmMsg);
    if (projected > previous) {
      // The old confirm said "Projected 307.0 (was 293.0)"; the step says "+14.0 pts → 307.0".
      expect(patches).toHaveLength(1);
      expect(container.textContent).toContain(`+${(projected - previous).toFixed(1)} pts → ${projected.toFixed(1)}`);
    } else {
      // Nothing beat the lineup: the old button wrote the same state back; the step writes nothing.
      expect(patches).toHaveLength(0);
      expect(container.textContent).toContain(`nothing changed (${previous.toFixed(1)} pts)`);
    }
  });

  it.each(CASES)('all teams: %s', async (name, build, removeSeniors) => {
    const ws = build();
    const expected = golden.cases[name].allTeams;
    const patches = await renderStep(ws, removeSeniors);
    await click(buttonByText(/^All teams…$/));
    await click(buttonByText(/Run optimizer/));
    await settle();

    const { projected, previous } = totalsFromConfirm(expected.confirmMsg);
    const apply = buttonByText(/Apply to workspace/);
    if (projected > previous) {
      expect(apply.disabled).toBe(false);
      await click(apply);
      expect(patches).toHaveLength(1);
      expect(container.textContent).toContain(`+${(projected - previous).toFixed(1)} pts`);
    } else {
      expect(apply.disabled).toBe(true);
    }
    expect(resultingState(ws, patches)).toEqual(expected.applied);
  });
});

describe('the two call shapes the old and new buttons used return one result', () => {
  // Best roster merged the settings first; the Optimize step hands the Manager's
  // already-merged settings straight in. The optimizer merges again either way.
  it.each(CASES)('%s', (_name, build, removeSeniors) => {
    const ws = build();
    const raw = resolvedScoringSettings(ws);
    const team = (settings: typeof raw) =>
      normalizeOptimizerState(optimizeRosterForTeam(ws, Gender.MEN, HOME_TEAM, removeSeniors, settings, 'all') as never);
    const all = (settings: typeof raw) =>
      normalizeOptimizerState(optimizeRosterAllTeams(ws, Gender.MEN, removeSeniors, settings, 'all') as never);
    const premerged = mergeScoringSettings(raw);
    expect(team(raw)).toEqual(team(premerged));
    expect(all(raw)).toEqual(all(premerged));
    // And it is deterministic, so a golden comparison cannot flake.
    expect(team(raw)).toEqual(team(raw));
  });

  it('the fixtures include a run that really improves, or the comparison proves nothing', () => {
    const gainCase = golden.cases['meet-gain'].team;
    const { projected, previous } = totalsFromConfirm(gainCase.confirmMsg);
    expect(projected).toBeGreaterThan(previous);
    expect(gainCase.applied.plans.length).toBeGreaterThan(0);
  });
});

describe('the extra merge the old button did is a no-op for any settings the Manager can hold', () => {
  // Best roster handed the optimizer mergeScoringSettings(settings); the Optimize
  // step hands it `settings`. The optimizer merges once more with the workspace
  // conference, so the two agree exactly when merge is idempotent on its own output.
  const conferences: Array<string | undefined> = [undefined, 'NSISC', 'GLVC'];
  const bases = [
    ['generic top 16', GENERIC_TOP16_SETTINGS],
    ['NSISC preset', NSISC_PRESET_SETTINGS],
    ['PDF place points', { ...GENERIC_TOP16_SETTINGS, usePdfPlacePoints: true }],
    ['explicit points pool', { ...GENERIC_TOP16_SETTINGS, scorerEligibilityMode: 'points_pool' as const }],
    ['explicit roster', { ...GENERIC_TOP16_SETTINGS, scorerEligibilityMode: 'roster' as const }],
    ...BUILT_IN_SCORING_PRESETS.flatMap(preset =>
      preset.settings ? [[`preset ${preset.id}`, preset.settings] as const] : []
    ),
  ] as const;

  it.each(bases)('%s', (_label, base) => {
    for (const conference of conferences) {
      const resolved = mergeScoringSettings(base, { conference });
      expect(mergeScoringSettings(mergeScoringSettings(resolved), { conference })).toEqual(
        mergeScoringSettings(resolved, { conference })
      );
    }
  });

  it('covers more than a couple of settings, or the loop proves nothing', () => {
    expect(bases.length).toBeGreaterThan(8);
  });
});
