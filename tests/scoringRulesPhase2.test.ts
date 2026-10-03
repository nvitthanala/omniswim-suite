// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoringSettingsFields } from '../packages/matrix/src/components/ScoringSettingsFields';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { Gender, type Workspace } from '@omniswim/core/types';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { workspacePdfPlacePointsLocked, workspaceScoringSettings } from '../apps/shell/src/lib/workspaceScoringSettings';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Phase 2 scoring eligibility', () => {
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

  it('renders the team scorer list and points pool choices', async () => {
    await act(async () => {
      root.render(createElement(ScoringSettingsFields, {
        settings: mergeScoringSettings({ usePdfPlacePoints: false, scorerEligibilityMode: 'roster' }),
        onChange: vi.fn(),
      }));
    });
    expect(container.querySelector('[aria-label="Scorer eligibility"]')).toBeTruthy();
    expect(container.textContent).toContain('Team scorer list');
    expect(container.textContent).toContain('Points pool');
  });

  it('disables team scorer list and explains the PDF points lock', async () => {
    await act(async () => {
      root.render(createElement(ScoringSettingsFields, {
        settings: mergeScoringSettings({ usePdfPlacePoints: true }),
        onChange: vi.fn(),
      }));
    });
    const field = container.querySelector('[aria-label="Scorer eligibility"]') as HTMLSelectElement;
    expect(field.disabled).toBe(true);
    expect(field.title).toMatch(/PDF/i);
    expect(field.value).toBe('points_pool');
  });

  it('passes the same resolved settings to the modal as useWorkspaceScoring', async () => {
    const workspace = {
      id: 'settings-proof', name: 'Settings proof', createdAt: 1,
      menResults: [], womenResults: [], recruits: [],
      scoringSettings: { usePdfPlacePoints: false, scorerEligibilityMode: 'roster' },
    } as unknown as Workspace;
    let actual: ReturnType<typeof workspaceScoringSettings> | undefined;
    function HookProbe() {
      actual = useWorkspaceScoring({ workspace, gender: Gender.MEN, removeSeniors: false, scoringRefreshKey: 0 }).scoringSettings;
      return null;
    }
    await act(async () => root.render(createElement(HookProbe)));
    expect(workspaceScoringSettings(workspace)).toEqual(actual);
  });

  it('agrees with useWorkspaceScoring when the PDF place-points hint path runs', async () => {
    // Ten rows carry the HyTek Points column, so Auto resolves to PDF place points.
    const menResults = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, rank: i + 1, name: `Swimmer ${i}`, classYear: 'FR', team: 'Alpha', time: '20.00',
      points: 5, pdfPoints: 5, event: '50 Free', gender: Gender.MEN,
    }));
    const workspace = {
      id: 'settings-proof-pdf', name: 'Settings proof PDF', createdAt: 1,
      menResults, womenResults: [], recruits: [],
      // Auto plus a saved roster mode: only the results hint can force the Points pool.
      scoringSettings: { usePdfPlacePoints: 'auto', scorerEligibilityMode: 'roster' },
    } as unknown as Workspace;
    let actual: ReturnType<typeof workspaceScoringSettings> | undefined;
    function HookProbe() {
      actual = useWorkspaceScoring({ workspace, gender: Gender.MEN, removeSeniors: false, scoringRefreshKey: 0 }).scoringSettings;
      return null;
    }
    await act(async () => root.render(createElement(HookProbe)));

    const unhinted = mergeScoringSettings(workspace.scoringSettings, { conference: workspace.conference });
    expect(unhinted.scorerEligibilityMode, 'without the hint the saved roster mode stands').toBe('roster');
    expect(actual?.scorerEligibilityMode, 'the hint path forced the Points pool').toBe('points_pool');
    expect(workspaceScoringSettings(workspace)).toEqual(actual);
    expect(workspacePdfPlacePointsLocked(workspace)).toBe(true);
  });

  it('keeps NSISC naming out of Manager and Matrix UI copy', () => {
    for (const folder of ['packages/manager/src', 'packages/matrix/src']) {
      const visit = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (path.endsWith('.tsx')) {
            expect(readFileSync(path, 'utf8'), path).not.toMatch(/NSISC/);
          }
        }
      };
      visit(folder);
    }
  });
});
