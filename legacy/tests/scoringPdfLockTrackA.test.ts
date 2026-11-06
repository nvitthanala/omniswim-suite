// @vitest-environment happy-dom
/**
 * Track A2: the PDF place-points lock.
 *  (a) Under Auto with PDF points in the results, the engine ignores the scorer-pool fields
 *      (diver weight, caps, scope, relay eligibility). They must be disabled with a reason.
 *  (b) Picking Auto in the dialog locks at once when the RESULTS carry PDF points, and unlocks
 *      when they do not, whatever was saved. The shell passes `resultsCarryPdfPlacePoints`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { Gender, type ScoringSettings, type SwimmerResult, type Workspace } from '@omniswim/core/types';
import ScoringSettingsModal from '../packages/matrix/src/components/ScoringSettingsModal';
import { ScoringSettingsFields } from '../packages/matrix/src/components/ScoringSettingsFields';
import { useWorkspaceScoringDialogProps } from '../apps/shell/src/lib/workspaceScoringSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setNativeValue(el: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const POINTS = [20, 17, 16, 15, 14, 13, 12, 11];
/** Every field the engine neutralises under PDF place points (see PDF_PLACE_POINTS_LOCKED_SETTING_KEYS). */
const POOL_FIELDS = [
  'Diver scorer weight',
  'Maximum individual scorers per team',
  'Maximum scoring relays per team per event',
  'Scorer cap scope',
  'Require relay legs to be in individual scorer pool',
] as const;

describe('Track A2: PDF place-points lock', () => {
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

  const byLabel = <T extends HTMLElement>(label: string) => document.querySelector(`[aria-label="${label}"]`) as T;
  const eligibility = () => byLabel<HTMLSelectElement>('Scorer eligibility');
  const pdfSelect = () => byLabel<HTMLSelectElement>('PDF place points setting');
  const disabled = (label: string) => byLabel<HTMLInputElement | HTMLSelectElement>(label).disabled;

  async function renderFields(settings: ScoringSettings, extra: Record<string, unknown>) {
    await act(async () => root.render(createElement(ScoringSettingsFields, { settings, onChange: () => {}, ...extra })));
    await flush();
  }

  describe('(a) pool fields are locked under Auto + PDF points', () => {
    it('disables diver weight and the other scorer-pool fields, with the reason as the title', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: 'auto', scoringPoints: POINTS });
      await renderFields(settings, { resultsCarryPdfPlacePoints: true });
      for (const label of POOL_FIELDS) expect(disabled(label), label).toBe(true);
      const diver = byLabel<HTMLInputElement>('Diver scorer weight');
      expect(diver.title).toContain('place points');
      expect(container.textContent ?? '').toContain('This meet PDF carries its own place points');
    });

    it('leaves them editable under Auto when the results carry no PDF points', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: 'auto', scoringPoints: POINTS });
      await renderFields(settings, { resultsCarryPdfPlacePoints: false });
      for (const label of POOL_FIELDS) expect(disabled(label), label).toBe(false);
      expect(container.textContent ?? '').not.toContain('This meet PDF carries its own place points');
    });

    it('leaves them editable under Off even when the results carry PDF points', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: false, scoringPoints: POINTS });
      await renderFields(settings, { resultsCarryPdfPlacePoints: true });
      for (const label of POOL_FIELDS) expect(disabled(label), label).toBe(false);
    });

    it('still honours the older pdfPlacePointsLocked flag when the host sends no results flag', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: 'auto', scoringPoints: POINTS });
      await renderFields(settings, { pdfPlacePointsLocked: true });
      expect(disabled('Diver scorer weight')).toBe(true);
    });

    it('locks and unlocks the pool fields as the user moves the PDF setting, without saving', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: 'auto', scoringPoints: POINTS });
      await renderFields(settings, { resultsCarryPdfPlacePoints: true });
      expect(disabled('Diver scorer weight')).toBe(true);
      await act(async () => setNativeValue(pdfSelect(), 'off'));
      expect(disabled('Diver scorer weight')).toBe(false);
      await act(async () => setNativeValue(pdfSelect(), 'on'));
      expect(disabled('Diver scorer weight')).toBe(true);
    });
  });

  describe('(b) a draft Auto resolves from the results, not from the saved setting', () => {
    it('saved Off, results carry PDF points: picking Auto locks eligibility and pool fields at once', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: false, scorerEligibilityMode: 'roster', scoringPoints: POINTS });
      await act(async () =>
        root.render(createElement(ScoringSettingsModal, {
          settings, pdfPlacePointsLocked: false, resultsCarryPdfPlacePoints: true, onSave: () => {}, onClose: () => {},
        })));
      await flush();
      expect(eligibility().disabled).toBe(false);
      expect(disabled('Diver scorer weight')).toBe(false);
      await act(async () => setNativeValue(pdfSelect(), 'auto'));
      expect(eligibility().disabled).toBe(true);
      expect(eligibility().value).toBe('points_pool');
      expect(disabled('Diver scorer weight')).toBe(true);
    });

    it('saved On, results carry no PDF points: picking Auto unlocks at once', async () => {
      const settings = mergeScoringSettings({ usePdfPlacePoints: true, scoringPoints: POINTS });
      await act(async () =>
        root.render(createElement(ScoringSettingsModal, {
          settings, pdfPlacePointsLocked: true, resultsCarryPdfPlacePoints: false, onSave: () => {}, onClose: () => {},
        })));
      await flush();
      expect(eligibility().disabled).toBe(true);
      await act(async () => setNativeValue(pdfSelect(), 'auto'));
      expect(eligibility().disabled).toBe(false);
      expect(disabled('Diver scorer weight')).toBe(false);
    });
  });

  describe('shell hook', () => {
    function pdfResults(): SwimmerResult[] {
      return Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`, rank: i + 1, name: `Swimmer ${i}`, classYear: 'FR', team: 'Alpha', time: '20.00',
        points: 5, pdfPoints: 5, event: '50 Free', gender: Gender.MEN,
      })) as SwimmerResult[];
    }
    async function probe(ws: Workspace) {
      let seen: ReturnType<typeof useWorkspaceScoringDialogProps> = null;
      const Probe = () => {
        seen = useWorkspaceScoringDialogProps(ws);
        return null;
      };
      await act(async () => root.render(createElement(Probe)));
      return seen!;
    }

    it('reports that the results carry PDF points even when the saved setting is Off', async () => {
      const ws = { id: 'w', name: 'A', conference: 'D2', scoringSettings: { usePdfPlacePoints: false }, menResults: pdfResults(), womenResults: [] } as unknown as Workspace;
      const props = await probe(ws);
      expect(props.pdfPlacePointsLocked).toBe(false);
      expect(props.resultsCarryPdfPlacePoints).toBe(true);
    });

    it('reports false when no result carries PDF points, even with a saved On', async () => {
      const ws = { id: 'w', name: 'A', conference: 'D2', scoringSettings: { usePdfPlacePoints: true }, menResults: [], womenResults: [] } as unknown as Workspace;
      const props = await probe(ws);
      expect(props.pdfPlacePointsLocked).toBe(true);
      expect(props.resultsCarryPdfPlacePoints).toBe(false);
    });
  });
});
