// @vitest-environment happy-dom
/**
 * UI review fix 6 (the smaller ones):
 *  - OpsModule renders when sessionStorage is missing or throws.
 *  - The scorer caps accept 0 and reject negatives.
 *  - A failed suggested-preset load shows a visible message.
 *  - The history preview "choose a team" warning uses a theme token.
 * (The Delete or Backspace hint and aria-activedescendant are in
 * phase6WordingDensity.test.ts, next to the Delete-key test they extend.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { Gender, type ScoringSettings, type Workspace } from '@omniswim/core/types';
import OpsModule from '../packages/matrix/src/components/OpsModule';
import ScoringSettingsPanel from '../packages/matrix/src/components/ScoringSettingsPanel';
import { ScoringSettingsFields } from '../packages/matrix/src/components/ScoringSettingsFields';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);
vi.mock('@omniswim/core/store/SuiteWorkspaceProvider', () => ({
  useSuiteWorkspace: () => ({
    activeWorkspace: null,
    activeGender: 'Men',
    workspaces: [],
    updateWorkspace: vi.fn(),
    createWorkspace: vi.fn(async () => ({})),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('UI review smaller fixes', () => {
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
    vi.restoreAllMocks();
  });

  it('OpsModule renders and opens on its default step when sessionStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    const ws = {
      id: 'blocked-storage', name: 'W', createdAt: 1, menResults: [], womenResults: [], recruits: [],
      loadedMeet: { pdfFilename: 'meet.pdf', uploadedAt: 1 },
    } as unknown as Workspace;
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(ToastProvider, null,
        createElement(OpsModule, { workspace: ws, gender: Gender.MEN, onUpdate: vi.fn() }))));
    });
    await settle();
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs).toHaveLength(3);
    expect(tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent).toMatch(/Standings/);
  });

  describe('scorer caps', () => {
    it('accept 0 and reject a negative number', async () => {
      let latest: ScoringSettings | undefined;
      const settings = mergeScoringSettings({ scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11], maxIndividualScorersPerTeam: 5, maxRelaysScoringPerTeam: 3 });
      await act(async () => root.render(createElement(ScoringSettingsFields, { settings, onChange: next => { latest = next; } })));
      await settle();
      for (const [label, key] of [
        ['Maximum individual scorers per team', 'maxIndividualScorersPerTeam'],
        ['Maximum scoring relays per team per event', 'maxRelaysScoringPerTeam'],
      ] as const) {
        const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
        expect(input, label).toBeTruthy();
        await act(async () => setNativeValue(input, '-1'));
        expect(input.getAttribute('aria-invalid'), `${label} rejects -1`).toBe('true');
        expect(latest?.[key]).not.toBe(-1);
        await act(async () => setNativeValue(input, '0'));
        expect(input.hasAttribute('aria-invalid'), `${label} accepts 0`).toBe(false);
        expect(latest?.[key]).toBe(0);
      }
    });
  });

  describe('suggested preset banner on the Meet step', () => {
    it('shows a visible message when the preset cannot be loaded, and does not save', async () => {
      const onSave = vi.fn();
      const onClear = vi.fn();
      await act(async () => root.render(createElement(ScoringSettingsPanel, {
        settings: mergeScoringSettings({}), onSave, suggestedPresetId: 'no-such-preset', onClearSuggestedPreset: onClear,
      })));
      const load = container.querySelector('[aria-label="Load and save suggested no-such-preset scoring preset"]') as HTMLElement;
      expect(load).toBeTruthy();
      await act(async () => load.click());
      await settle();
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toMatch(/Could not load the suggested rule set/);
      expect(onSave).not.toHaveBeenCalled();
      expect(onClear).not.toHaveBeenCalled();
    });
  });

  it('the history preview warning uses a theme token, not a fixed amber', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'packages/manager/src/components/AthleteHistoryPreviewSection.tsx'), 'utf8');
    expect(source).not.toMatch(/amber-\d/);
    expect(source).toContain('Choose a team in the team bar above before importing.');
    const line = source.split('\n').find(l => l.includes('Choose a team in the team bar above'))!;
    expect(line).toContain('text-[var(--color-warning)]');
    // The token exists in the theme sheet for both themes.
    const css = readFileSync(join(import.meta.dirname, '..', 'packages/ui/src/index.css'), 'utf8');
    expect(css.match(/--color-warning:/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
