// @vitest-environment happy-dom
/**
 * Phase 5: Matrix has three steps (Meet, Standings, Analyze).
 *
 * - The old Score step is folded into Meet: the scoring summary, the suggested
 *   preset banner, "Edit scoring rules" and the official team scores.
 * - Every scoring field is reachable from Meet through "Edit scoring rules".
 * - The step a workspace opens on, and a stored 'load' or 'score' value.
 * - Standings wording: "Team standings", "Chart:" and "List:" toggles, "vs prelims".
 * - The no-workspace empty state offers "New workspace".
 */
import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoringRulesOpenerProvider, ToastProvider } from '@omniswim/ui';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { Gender, type TeamScore, type Workspace } from '@omniswim/core/types';
import OpsModule from '../packages/matrix/src/components/OpsModule';
import MatrixApp from '../packages/matrix/src/MatrixApp';
import ScoringSettingsModal from '../packages/matrix/src/components/ScoringSettingsModal';
import { ScoringSettingsFields } from '../packages/matrix/src/components/ScoringSettingsFields';
import ProjectedActualScore from '../packages/matrix/src/components/ProjectedActualScore';
import { TeamCardMatrixControls } from '../packages/matrix/src/components/TeamCardMatrixList';
import { TeamCardChartToggle } from '../packages/matrix/src/components/TeamCardParts';
import { MeetOpsStandingsStep } from '../packages/matrix/src/components/MeetOpsStandingsStep';
import {
  MeetOpsScoringSection,
  officialScoreRows,
} from '../packages/matrix/src/components/MeetOpsScoringSection';
import {
  matrixStepStorageKey,
  normalizeStoredMatrixStep,
  resolveInitialMatrixStep,
} from '../packages/matrix/src/components/matrixStepState';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

const suite = vi.hoisted(() => ({
  activeWorkspace: null as unknown,
  workspaces: [] as unknown[],
  createWorkspace: vi.fn(async () => ({})),
}));
vi.mock('@omniswim/core/store/SuiteWorkspaceProvider', () => ({
  useSuiteWorkspace: () => ({
    activeWorkspace: suite.activeWorkspace,
    activeGender: 'Men',
    workspaces: suite.workspaces,
    updateWorkspace: vi.fn(),
    createWorkspace: suite.createWorkspace,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function workspace(id: string, withMeet: boolean): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    createdAt: 1,
    menResults: [],
    womenResults: [],
    recruits: [],
    ...(withMeet ? { loadedMeet: { pdfFilename: 'meet.pdf', uploadedAt: 1 } } : {}),
  } as unknown as Workspace;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Matrix steps', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sessionStorage.clear();
    suite.activeWorkspace = null;
    suite.workspaces = [];
    suite.createWorkspace.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled'); }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderOps(ws: Workspace, wrap: (node: ReactElement) => ReactElement = node => node) {
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            ToastProvider,
            null,
            wrap(createElement(OpsModule, { workspace: ws, gender: Gender.MEN, onUpdate: vi.fn() }))
          )
        )
      );
    });
    await settle();
  }

  const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
  const selectedTab = () => tabs().find(tab => tab.getAttribute('aria-selected') === 'true');
  const button = (name: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === name
    );

  it('has exactly three tabs: Meet, Standings, Analyze', async () => {
    await renderOps(workspace('three-tabs', true));
    const labels = tabs().map(tab => tab.textContent ?? '');
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/Meet/);
    expect(labels[1]).toMatch(/Standings/);
    expect(labels[2]).toMatch(/Analyze/);
    expect(labels.join(' ')).not.toMatch(/Score\b|Load\b/);
  });

  it('gives Analyze its own icon', async () => {
    await renderOps(workspace('icons', true));
    const iconClass = (tab: HTMLElement) =>
      Array.from(tab.querySelector('svg')?.classList ?? []).find(name => name.startsWith('lucide-')) ?? '';
    const icons = tabs().map(iconClass);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(3);
  });

  it('opens on Standings when a meet is loaded and on Meet when none is', async () => {
    await renderOps(workspace('has-meet', true));
    expect(selectedTab()?.textContent).toMatch(/Standings/);
    act(() => root.unmount());
    root = createRoot(container);
    await renderOps(workspace('no-meet', false));
    expect(selectedTab()?.textContent).toMatch(/Meet/);
  });

  it('opens a stored "score" or "load" step on Meet and writes the current id back', async () => {
    for (const stored of ['score', 'load']) {
      const ws = workspace(`stored-${stored}`, true);
      sessionStorage.setItem(matrixStepStorageKey(ws.id), stored);
      act(() => root.unmount());
      root = createRoot(container);
      await renderOps(ws);
      expect(selectedTab()?.textContent).toMatch(/Meet/);
      expect(sessionStorage.getItem(matrixStepStorageKey(ws.id))).toBe('meet');
    }
  });

  it('keeps a stored Analyze step', async () => {
    const ws = workspace('stored-analyze', true);
    sessionStorage.setItem(matrixStepStorageKey(ws.id), 'analyze');
    await renderOps(ws);
    expect(selectedTab()?.textContent).toMatch(/Analyze/);
  });

  it('reaches every scoring field from the Meet step through Edit scoring rules', async () => {
    // The fields the rules dialog holds, taken from the form itself.
    const settings = mergeScoringSettings({});
    const reference = document.createElement('div');
    document.body.appendChild(reference);
    const referenceRoot = createRoot(reference);
    await act(async () => {
      referenceRoot.render(createElement(ScoringSettingsFields, { settings, onChange: vi.fn(), scoringView: 'merged', onScoringViewChange: vi.fn() }));
    });
    await settle();
    const fieldLabels = Array.from(reference.querySelectorAll('[aria-label]')).map(el => el.getAttribute('aria-label') as string);
    act(() => referenceRoot.unmount());
    reference.remove();
    expect(fieldLabels).toContain('Scorer eligibility');
    expect(fieldLabels).toContain('Scoring view');
    expect(fieldLabels.length).toBeGreaterThan(10);

    // The same dialog, opened from the Meet step the way the shell opens it.
    const ws = workspace('meet-scoring', true);
    sessionStorage.setItem(matrixStepStorageKey(ws.id), 'meet');
    function Shell({ children }: { children: ReactElement }) {
      const [open, setOpen] = useState(false);
      return createElement(
        ScoringRulesOpenerProvider,
        { onOpen: () => setOpen(true) },
        children,
        open
          ? createElement(ScoringSettingsModal, {
              settings,
              onSave: vi.fn(),
              onClose: () => setOpen(false),
              scoringView: 'merged',
              onScoringViewChange: vi.fn(),
            })
          : null
      );
    }
    await renderOps(ws, node => createElement(Shell, null, node));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const edit = button('Edit scoring rules');
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    const reachable = new Set(Array.from(dialog.querySelectorAll('[aria-label]')).map(el => el.getAttribute('aria-label')));
    expect(fieldLabels.filter(label => !reachable.has(label))).toEqual([]);
  });

  it('shows the suggested-preset banner and scoring summary on the Meet step', async () => {
    const ws = { ...workspace('meet-banner', true), conference: 'NSISC' } as Workspace;
    sessionStorage.setItem(matrixStepStorageKey(ws.id), 'meet');
    await renderOps(ws);
    expect(container.textContent).toContain('Scoring rules');
    expect(container.textContent).toMatch(/SUGGESTED PRESET|Suggested preset/i);
    expect(container.textContent).toContain('Meet files');
  });

  it('the no-workspace empty state offers New workspace', async () => {
    await act(async () => { root.render(createElement(MatrixApp)); });
    const create = button('New workspace');
    expect(create).toBeTruthy();
    await act(async () => create!.click());
    expect(suite.createWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe('Matrix step state', () => {
  it('maps old step ids to the Meet step', () => {
    expect(normalizeStoredMatrixStep('score')).toBe('meet');
    expect(normalizeStoredMatrixStep('load')).toBe('meet');
    expect(normalizeStoredMatrixStep('meet')).toBe('meet');
    expect(normalizeStoredMatrixStep('standings')).toBe('standings');
    expect(normalizeStoredMatrixStep('analyze')).toBe('analyze');
    expect(normalizeStoredMatrixStep('nonsense')).toBeNull();
    expect(normalizeStoredMatrixStep(null)).toBeNull();
  });

  it('lands on Standings with a meet and Meet without one, but a saved step wins', () => {
    expect(resolveInitialMatrixStep(null, true)).toBe('standings');
    expect(resolveInitialMatrixStep(null, false)).toBe('meet');
    expect(resolveInitialMatrixStep('score', true)).toBe('meet');
    expect(resolveInitialMatrixStep('analyze', false)).toBe('analyze');
  });
});

describe('Official team scores', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled'); }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const teams = [{ teamName: 'Alpha' }, { teamName: 'Beta' }] as unknown as TeamScore[];
  const render = (lookup: Map<string, number | undefined>) =>
    act(async () => {
      root.render(
        createElement(MeetOpsScoringSection, {
          scoringSettings: mergeScoringSettings({}),
          suggestedPresetId: null,
          onSaveScoringSettings: vi.fn(),
          onClearSuggestedPreset: vi.fn(),
          officialLookup: lookup,
          teamsWithLineStyles: teams,
        })
      );
    });

  it('lists only teams that have a published score', () => {
    const rows = officialScoreRows(teams, new Map<string, number | undefined>([['Alpha', 412.5], ['Beta', undefined]]));
    expect(rows).toEqual([{ teamName: 'Alpha', score: 412.5 }]);
  });

  it('shows the card with values when scores exist', async () => {
    await render(new Map([['Alpha', 412.5], ['Beta', 300]]));
    expect(container.textContent).toContain('Official team scores');
    expect(container.textContent).toContain('412.5');
    expect(container.textContent).toContain('300.0');
  });

  it('keeps a team whose published score is 0 and shows it as 0.0', async () => {
    const lookup = new Map<string, number | undefined>([['Alpha', 412.5], ['Beta', 0]]);
    // A score of 0 is a real score; only an absent one is dropped.
    expect(officialScoreRows(teams, lookup)).toEqual([
      { teamName: 'Alpha', score: 412.5 },
      { teamName: 'Beta', score: 0 },
    ]);
    await render(lookup);
    expect(container.textContent).toContain('Official team scores');
    expect(container.textContent).toContain('412.5');
    expect(container.textContent).toContain('Beta');
    expect(container.textContent).toContain('0.0');
    const values = Array.from(container.querySelectorAll('span.font-mono')).map(el => el.textContent);
    expect(values).toEqual(['412.5', '0.0']);
  });

  it('hides the card when every team is keyed but none has a score', async () => {
    await render(new Map<string, number | undefined>([['Alpha', undefined], ['Beta', undefined]]));
    expect(container.textContent).not.toContain('Official team scores');
    expect(container.textContent).toContain('Edit scoring rules');
  });
});

describe('Standings wording', () => {
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

  it('titles the list "Team standings"', async () => {
    await act(async () => {
      root.render(
        createElement(MeetOpsStandingsStep, {
          reconciliationSummary: { status: 'none' } as never,
          scoringSettings: mergeScoringSettings({}),
          searchQuery: '',
          onSearchChange: vi.fn(),
          teamsWithLineStyles: [],
          gender: Gender.MEN,
          visibleEvents: [],
          officialLookup: new Map(),
          baselineByTeam: new Map(),
          prelimsByTeam: new Map(),
          psychByTeam: new Map(),
          showPrelimsPerformance: false,
          prelimsOuByEntry: new Map(),
          showPsychPerformance: false,
          psychOuByEntry: new Map(),
          scoringRefreshKey: 0,
          topContributors: [],
        })
      );
    });
    const heading = Array.from(container.querySelectorAll('h3')).map(h => h.textContent);
    expect(heading).toContain('Team standings');
    expect(container.textContent).not.toContain('Performance Matrix');
  });

  it('labels the chart toggle "Chart:" with By event and By class', async () => {
    const onChange = vi.fn();
    await act(async () => { root.render(createElement(TeamCardChartToggle, { value: 'event', onChange })); });
    expect(container.textContent).toContain('Chart:');
    const options = Array.from(container.querySelectorAll('button')).map(b => b.textContent);
    expect(options).toEqual(['By event', 'By class']);
    await act(async () => (container.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith('class');
  });

  it('labels the list toggle "List:" with By event and By swimmer', async () => {
    await act(async () => {
      root.render(
        createElement(TeamCardMatrixControls, {
          viewMode: 'event',
          sortMode: 'eventDesc',
          onSortModeChange: vi.fn(),
          onViewModeChange: vi.fn(),
        })
      );
    });
    expect(container.textContent).toContain('List:');
    const options = Array.from(container.querySelectorAll('[role="group"] button')).map(b => b.textContent);
    expect(options).toEqual(['By event', 'By swimmer']);
  });

  it('writes "vs prelims" and not "Base" for the baseline delta', async () => {
    await act(async () => {
      root.render(
        createElement(ProjectedActualScore, {
          compact: true,
          projected: 210,
          prelimsProjected: 200,
          baselineOverUnder: 5,
          projectedOverUnder: 10,
        })
      );
    });
    expect(container.textContent).toContain('vs prelims +5.0');
    expect(container.textContent).not.toMatch(/\bBase\b/);
  });
});
