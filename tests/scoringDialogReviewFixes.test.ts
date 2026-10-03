// @vitest-environment happy-dom
/**
 * Review fixes 2 and 3 for the scoring-rules dialog:
 *  2. An equal-but-new `settings` object (a toast or toggle re-render) must not
 *     wipe unsaved edits, in the modal, the shared fields, and the shell hook.
 *  3. The PDF-place-points lock follows the dialog's live choice, and the Lineup
 *     lock message names PDF place points when Auto resolves to On.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { Gender, type ScoringSettings, type SwimmerResult, type Workspace } from '@omniswim/core/types';
import { ToastProvider } from '@omniswim/ui';
import ScoringSettingsModal from '../packages/matrix/src/components/ScoringSettingsModal';
import { ScoringSettingsFields } from '../packages/matrix/src/components/ScoringSettingsFields';
import TeamRosterPanel from '../packages/manager/src/components/TeamRosterPanel';
import { useWorkspaceScoringDialogProps } from '../apps/shell/src/lib/workspaceScoringSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('scoring dialog review fixes', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in this test'); }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // The Modal portals to document.body, so look there.
  const byLabel = <T extends HTMLElement>(label: string) => document.querySelector(`[aria-label="${label}"]`) as T | null;

  describe('fix 2: equal-but-new settings do not reset the draft', () => {
    const BASE = { scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11] };

    it('modal keeps an unsaved edit across a parent re-render with a new equal object', async () => {
      const onSave = vi.fn();
      const render = (settings: ScoringSettings) =>
        act(async () => root.render(createElement(ScoringSettingsModal, { settings, onSave, onClose: () => {} })));
      await render(mergeScoringSettings(BASE));
      await flush();
      const relay = () => byLabel<HTMLInputElement>('Relay multiplier')!;
      await act(async () => setNativeValue(relay(), '3'));
      expect(relay().value).toBe('3');

      await render(mergeScoringSettings(BASE)); // equal content, new identity
      await flush();
      expect(relay().value).toBe('3');
      const save = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Update scoring model'))!;
      await act(async () => save.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect((onSave.mock.calls[0][0] as ScoringSettings).relayMultiplier).toBe(3);
    });

    it('modal still resets when the incoming settings change in content', async () => {
      const render = (settings: ScoringSettings) =>
        act(async () => root.render(createElement(ScoringSettingsModal, { settings, onSave: () => {}, onClose: () => {} })));
      await render(mergeScoringSettings(BASE));
      await flush();
      await act(async () => setNativeValue(byLabel<HTMLInputElement>('Relay multiplier')!, '3'));
      await render(mergeScoringSettings({ ...BASE, relayMultiplier: 5 }));
      await flush();
      expect(byLabel<HTMLInputElement>('Relay multiplier')!.value).toBe('5');
    });

    it('shared fields keep an edit across a re-render with a new equal settings object', async () => {
      const render = (settings: ScoringSettings) =>
        act(async () => root.render(createElement(ScoringSettingsFields, { settings, onChange: () => {} })));
      await render(mergeScoringSettings(BASE));
      await flush();
      await act(async () => setNativeValue(byLabel<HTMLInputElement>('Relay multiplier')!, '3'));
      await render(mergeScoringSettings(BASE));
      await flush();
      expect(byLabel<HTMLInputElement>('Relay multiplier')!.value).toBe('3');
    });

    it('shell hook returns the same settings object while unrelated workspace fields change', async () => {
      const seen: Array<ReturnType<typeof useWorkspaceScoringDialogProps>> = [];
      const Probe = ({ ws }: { ws: Workspace }) => {
        seen.push(useWorkspaceScoringDialogProps(ws));
        return null;
      };
      const ws = { id: 'w', name: 'A', scoringSettings: BASE, conference: 'D2', menResults: [], womenResults: [] } as unknown as Workspace;
      await act(async () => root.render(createElement(Probe, { ws })));
      await act(async () => root.render(createElement(Probe, { ws: { ...ws, name: 'B' } })));
      expect(seen).toHaveLength(2);
      expect(seen[1]!.settings).toBe(seen[0]!.settings);
      await act(async () => root.render(createElement(Probe, { ws: { ...ws, scoringSettings: { ...BASE, relayMultiplier: 4 } } })));
      expect(seen[2]!.settings).not.toBe(seen[0]!.settings);
      expect(seen[2]!.settings.relayMultiplier).toBe(4);
    });
  });

  describe('fix 3: PDF place points lock follows the live choice', () => {
    const eligibility = () => byLabel<HTMLSelectElement>('Scorer eligibility')!;
    const pdfSelect = () => byLabel<HTMLSelectElement>('PDF place points setting')!;
    const POINTS = [20, 17, 16, 15, 14, 13, 12, 11];

    it('Auto with PDF points in the results locks eligibility, and Off unlocks it without saving', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: 'auto', scoringPoints: POINTS });
      await act(async () => root.render(createElement(ScoringSettingsFields, { settings, onChange: () => {}, pdfPlacePointsLocked: true })));
      await flush();
      expect(pdfSelect().value).toBe('auto');
      expect(eligibility().disabled).toBe(true);

      await act(async () => setNativeValue(pdfSelect(), 'off'));
      expect(eligibility().disabled).toBe(false);

      await act(async () => setNativeValue(pdfSelect(), 'on'));
      expect(eligibility().disabled).toBe(true);
    });

    it('a saved On that the user flips to Off unlocks in the same session (modal)', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: true, scoringPoints: POINTS });
      await act(async () =>
        root.render(createElement(ScoringSettingsModal, { settings, pdfPlacePointsLocked: true, onSave: () => {}, onClose: () => {} })));
      await flush();
      expect(eligibility().disabled).toBe(true);
      await act(async () => setNativeValue(pdfSelect(), 'off'));
      expect(eligibility().disabled).toBe(false);
    });

    function pdfResults(): SwimmerResult[] {
      return Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`, rank: i + 1, name: `Swimmer ${i}`, classYear: 'FR', team: 'Alpha', time: '20.00',
        points: 5, pdfPoints: 5, event: '50 Free', gender: Gender.MEN,
      })) as SwimmerResult[];
    }

    async function renderPanel(settings: ScoringSettings) {
      await act(async () =>
        root.render(
          createElement(ToastProvider, null,
            createElement(TeamRosterPanel, {
              results: pdfResults(), scoredResults: pdfResults(), settings, gender: Gender.MEN,
              overrides: [], onChangeOverrides: () => {}, editable: true,
              projectedByTeam: new Map(), baselineByTeam: new Map(),
              showTeamSidebar: false, teamPickerMode: 'dropdown', hideTeamSelect: true, selectedTeam: 'Alpha',
            }))));
    }

    it('Lineup lock message names PDF place points when Auto resolves to On, and offers Open scoring rules', async () => {
      // Auto + PDF points in the results: the engine forces Points pool.
      await renderPanel(mergeScoringSettings({ usePdfPlacePoints: 'auto' }, { resultsForPdfHint: pdfResults() }));
      const text = container.textContent ?? '';
      expect(text).toContain('PDF place points require Points pool eligibility');
      expect(text).not.toContain('Lineup editing requires Team scorer list eligibility');
      expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent === 'Open scoring rules')).toBe(true);
    });

    it('Lineup lock message stays the eligibility message when PDF place points are not in play', async () => {
      await renderPanel(mergeScoringSettings({ usePdfPlacePoints: false, scorerEligibilityMode: 'points_pool' }));
      expect(container.textContent ?? '').toContain('Lineup editing requires Team scorer list eligibility');
    });
  });
});
