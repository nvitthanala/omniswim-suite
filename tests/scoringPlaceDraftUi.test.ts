// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * U5 on the scoring settings screens (C6 UI half, X4). The core contract is in
 * `tests/scoringPlaceTables.test.ts`; this file pins what a coach sees:
 *
 *  - turning a relay or diving table on seeds ONE BLANK cell, and Save is
 *    disabled with the reason written next to it;
 *  - growing a table pads with blank cells, not 0;
 *  - a legacy stored table loads exactly as stored: a 0 stays "0", nothing is
 *    reported as an edit, and an unedited Save returns the stored numbers;
 *  - a legacy `relayPoints: [0]` is flagged but never blocks save;
 *  - a completed draft saves as plain `number[]`;
 *  - X4: a cleared count or cap field never publishes a made-up number.
 *
 * Plain `createElement`, matching the other DOM-render tests in this repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import type {
  FinalizeScoringDraftResult,
  ScoringSettingsDraft,
} from '@omniswim/core/lib/scoringPlaceTables';
import type { ScoringSettings } from '@omniswim/core/types';
import { ScoringSettingsFields } from '../packages/matrix/src/components/ScoringSettingsFields';
import ScoringSettingsModal from '../packages/matrix/src/components/ScoringSettingsModal';
import { ScoringPresetManagerModal } from '../packages/matrix/src/components/ScoringPresetManagerModal';
import { describeBlankPlaces } from '../packages/matrix/src/components/NullablePlacePointInput';

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
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no native value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

/** A stored table as an older workspace wrote it: real values, then two 0 places. */
const LEGACY_SCORING = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 0, 0];

describe('place-table drafts on the scoring settings screens (U5)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network disabled in this test');
      })
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // Modals portal to document.body, so query the document, not the container.
  const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  const buttonByText = (text: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
  const buttonByLabel = (label: string) =>
    [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label) as HTMLButtonElement;

  // ---- ScoringSettingsFields ------------------------------------------------

  describe('ScoringSettingsFields', () => {
    let drafts: { draft: ScoringSettingsDraft; result: FinalizeScoringDraftResult }[];
    let changes: ScoringSettings[];

    async function renderFields(settings: Partial<ScoringSettings>) {
      drafts = [];
      changes = [];
      await act(async () => {
        root.render(
          createElement(ScoringSettingsFields, {
            settings: mergeScoringSettings(settings),
            onChange: next => changes.push(next),
            onDraftChange: (draft, result) => drafts.push({ draft, result }),
          })
        );
      });
      await flush();
    }
    const lastDraft = () => drafts[drafts.length - 1];

    it('turning on a relay table shows one blank cell and reports the blank', async () => {
      await renderFields({ scoringPoints: [9, 7, 6, 5] });
      await click(buttonByLabel('Score relays from an explicit relay place table'));

      const cells = [...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Relay points for place"]')];
      expect(cells).toHaveLength(1);
      expect(cells[0].value).toBe('');
      expect(cells[0].getAttribute('aria-invalid')).toBe('true');

      expect(lastDraft().draft.relayPoints).toStrictEqual([null]);
      expect(lastDraft().result).toStrictEqual({ ok: false, blanks: [{ table: 'relayPoints', place: 1 }] });
      // A blank is not a ScoringSettings: nothing is published through onChange.
      expect(changes).toHaveLength(0);
    });

    it('turning on a diving table seeds one blank cell, not 0', async () => {
      await renderFields({ scoringPoints: [9, 7, 6, 5] });
      await click(buttonByLabel('Score diving from its own place table'));
      expect(input('Diving points for place 1')!.value).toBe('');
      expect(lastDraft().draft.divingPoints).toStrictEqual([null]);
    });

    it('growing the scoring table from 8 to 12 adds 4 blank cells and keeps the 8 values', async () => {
      await renderFields({ scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11] });
      await act(async () => setNativeValue(select('Number of scoring places')!, '12'));

      const cells = [...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Points for place"]')];
      expect(cells.map(c => c.value)).toStrictEqual(
        ['20', '17', '16', '15', '14', '13', '12', '11', '', '', '', '']
      );
      expect(lastDraft().draft.scoringPoints).toStrictEqual([20, 17, 16, 15, 14, 13, 12, 11, null, null, null, null]);
      expect(lastDraft().result).toStrictEqual({
        ok: false,
        blanks: [9, 10, 11, 12].map(place => ({ table: 'scoringPoints', place })),
      });
    });

    it('growing a relay table pads with blank cells, not 0', async () => {
      await renderFields({ scoringPoints: [9, 7], relayPoints: [11, 4] });
      await act(async () => setNativeValue(input('Number of relay scoring places')!, '4'));
      expect(lastDraft().draft.relayPoints).toStrictEqual([11, 4, null, null]);
    });

    it('a legacy table with 0 places loads unchanged and the unedited form reports no edit', async () => {
      await renderFields({ scoringPoints: LEGACY_SCORING });
      const cells = [...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Points for place"]')];
      // A stored 0 is a 0: displayed as "0", never emptied into a blank.
      expect(cells.map(c => c.value)).toStrictEqual(LEGACY_SCORING.map(String));
      expect(cells.some(c => c.getAttribute('aria-invalid') === 'true')).toBe(false);
      // No edit happened, so neither callback has fired.
      expect(drafts).toHaveLength(0);
      expect(changes).toHaveLength(0);
    });

    it('a legacy relayPoints [0] shows a warning, keeps its 0, and does not block', async () => {
      await renderFields({ scoringPoints: [9, 7, 6], relayPoints: [0] });
      expect(document.body.textContent).toContain('Relay table: one place, worth 0.');
      expect(input('Relay points for place 1')!.value).toBe('0');
      expect(input('Relay points for place 1')!.getAttribute('aria-invalid')).toBeNull();
      expect(drafts).toHaveLength(0);
    });

    it('a real relay table shows no zero-relay warning', async () => {
      await renderFields({ scoringPoints: [9, 7, 6], relayPoints: [11, 4, 2, 0] });
      expect(document.body.textContent).not.toContain('worth 0');
    });

    it('an emptied place cell becomes a blank draft cell, never 0', async () => {
      await renderFields({ scoringPoints: [9, 7, 6] });
      await act(async () => setNativeValue(input('Points for place 2')!, ''));
      expect(lastDraft().draft.scoringPoints).toStrictEqual([9, null, 6]);
      expect(lastDraft().result.ok).toBe(false);
      // Typing a value back clears the blank.
      await act(async () => setNativeValue(input('Points for place 2')!, '0'));
      expect(lastDraft().draft.scoringPoints).toStrictEqual([9, 0, 6]);
      expect(lastDraft().result.ok).toBe(true);
    });

    // ---- X4 ---------------------------------------------------------------

    describe('X4: a cleared count or cap field does not publish a fake number', () => {
      it('clearing the relay place count publishes nothing (it used to collapse the table to 1)', async () => {
        await renderFields({ scoringPoints: [9, 7], relayPoints: [11, 4, 2, 0] });
        await act(async () => setNativeValue(input('Number of relay scoring places')!, ''));
        expect(drafts).toHaveLength(0);
        expect(input('Relay points for place 4')).not.toBeNull();
      });

      it('clearing the diving place count publishes nothing', async () => {
        await renderFields({ scoringPoints: [9, 7], divingPoints: [7, 3, 1] });
        await act(async () => setNativeValue(input('Number of diving scoring places')!, ''));
        expect(drafts).toHaveLength(0);
        expect(input('Diving points for place 3')).not.toBeNull();
      });

      it('a cleared count reverts to the table length on blur', async () => {
        await renderFields({ scoringPoints: [9, 7], relayPoints: [11, 4, 2, 0] });
        const count = input('Number of relay scoring places')!;
        await act(async () => setNativeValue(count, ''));
        expect(count.value).toBe('');
        await act(async () => void count.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
        expect(count.value).toBe('4');
      });

      it('a per-event cap of 0 is refused, not silently turned into "no cap"', async () => {
        await renderFields({ scoringPoints: [9, 7, 6] });
        const cap = input('Maximum individual scorers per team per event')!;
        await act(async () => setNativeValue(cap, '3'));
        expect(changes[changes.length - 1].maxIndividualScorersPerTeamPerEvent).toBe(3);
        const before = drafts.length;
        await act(async () => setNativeValue(cap, '0'));
        await act(async () => setNativeValue(cap, '2.5'));
        expect(drafts).toHaveLength(before);
        expect(lastDraft().draft.maxIndividualScorersPerTeamPerEvent).toBe(3);
      });

      it('clearing the per-event cap and the diving cap reports undefined, a real "no cap"', async () => {
        await renderFields({ scoringPoints: [9, 7, 6], divingPoints: [7, 3] });
        const cap = input('Maximum individual scorers per team per event')!;
        await act(async () => setNativeValue(cap, '3'));
        await act(async () => setNativeValue(cap, ''));
        expect(lastDraft().draft.maxIndividualScorersPerTeamPerEvent).toBeUndefined();
        const diving = input('Maximum scoring divers per team per diving event')!;
        await act(async () => setNativeValue(diving, '2'));
        expect(lastDraft().draft.divingMaxScorersPerTeamPerEvent).toBe(2);
        await act(async () => setNativeValue(diving, ''));
        expect(lastDraft().draft.divingMaxScorersPerTeamPerEvent).toBeUndefined();
      });
    });
  });

  // ---- ScoringSettingsModal -------------------------------------------------

  describe('ScoringSettingsModal', () => {
    async function renderModal(settings: Partial<ScoringSettings>) {
      const onSave = vi.fn();
      await act(async () => {
        root.render(
          createElement(ScoringSettingsModal, {
            settings: mergeScoringSettings(settings),
            onSave,
            onClose: () => {},
          })
        );
      });
      await flush();
      return onSave;
    }
    const saveButton = () => buttonByText('Update scoring model')!;

    it('an unedited legacy form can be saved and returns exactly the stored numbers', async () => {
      const onSave = await renderModal({ scoringPoints: LEGACY_SCORING, relayPoints: [0] });
      expect(saveButton().disabled).toBe(false);
      expect(document.body.textContent).not.toContain('is blank');
      await click(saveButton());
      const saved = onSave.mock.calls[0][0] as ScoringSettings;
      expect(saved.scoringPoints).toStrictEqual(LEGACY_SCORING);
      expect(saved.relayPoints).toStrictEqual([0]);
    });

    it('turning on a relay table disables Save and says which place is blank, next to the button', async () => {
      const onSave = await renderModal({ scoringPoints: [9, 7, 6, 5] });
      expect(saveButton().disabled).toBe(false);
      await click(buttonByLabel('Score relays from an explicit relay place table'));

      expect(saveButton().disabled).toBe(true);
      const reason = document.body.querySelector('[role="status"]')!;
      expect(reason.textContent).toContain('Relay table: place 1 is blank.');
      // The reason is attached to the button, not only placed beside it.
      expect(saveButton().getAttribute('aria-describedby')).toBe(reason.id);
      await click(saveButton());
      expect(onSave).not.toHaveBeenCalled();
    });

    it('growing 8 to 12 disables Save and names the four blank places', async () => {
      await renderModal({ scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11] });
      await act(async () => setNativeValue(select('Number of scoring places')!, '12'));
      expect(saveButton().disabled).toBe(true);
      expect(document.body.textContent).toContain('Scoring table: places 9, 10, 11 and 12 are blank.');
    });

    it('a completed draft enables Save and stores plain number[] tables', async () => {
      const onSave = await renderModal({ scoringPoints: [9, 7, 6, 5] });
      await click(buttonByLabel('Score relays from an explicit relay place table'));
      await click(buttonByLabel('Score diving from its own place table'));
      expect(saveButton().disabled).toBe(true);

      await act(async () => setNativeValue(input('Relay points for place 1')!, '11'));
      // Relay is complete, diving is still blank: still blocked, and the notice names diving only.
      expect(saveButton().disabled).toBe(true);
      expect(document.body.textContent).toContain('Diving table: place 1 is blank.');
      expect(document.body.textContent).not.toContain('Relay table: place 1 is blank.');

      await act(async () => setNativeValue(input('Diving points for place 1')!, '7'));
      expect(saveButton().disabled).toBe(false);
      expect(document.body.textContent).not.toContain('is blank');

      await click(saveButton());
      expect(onSave).toHaveBeenCalledTimes(1);
      const saved = onSave.mock.calls[0][0] as ScoringSettings;
      expect(saved.relayPoints).toStrictEqual([11]);
      expect(saved.divingPoints).toStrictEqual([7]);
      for (const table of [saved.scoringPoints, saved.relayPoints, saved.divingPoints]) {
        expect(table!.every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true);
      }
    });

    it('re-blanking a filled cell blocks Save again, so a stale earlier copy is never saved', async () => {
      const onSave = await renderModal({ scoringPoints: [9, 7, 6, 5] });
      await click(buttonByLabel('Score relays from an explicit relay place table'));
      await act(async () => setNativeValue(input('Relay points for place 1')!, '11'));
      expect(saveButton().disabled).toBe(false);
      await act(async () => setNativeValue(input('Relay points for place 1')!, ''));
      expect(saveButton().disabled).toBe(true);
      await click(saveButton());
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  // ---- ScoringPresetManagerModal -------------------------------------------

  describe('ScoringPresetManagerModal editor', () => {
    it('blocks Save rule set while a place is blank, then saves number[] once it is filled', async () => {
      const posts: { settings: ScoringSettings }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
          if (init?.method === 'POST') {
            posts.push(JSON.parse(init.body ?? '{}'));
            return { ok: true, json: async () => ({ id: 'mine' }) };
          }
          throw new Error('network disabled in this test');
        })
      );
      await act(async () => {
        root.render(createElement(ScoringPresetManagerModal, { onClose: () => {} }));
      });
      await flush();
      await click(buttonByText('New rule set')!);
      await act(async () => setNativeValue(input('Preset label')!, 'My rules'));

      const save = () => buttonByText('Save rule set')!;
      expect(save().disabled).toBe(false);

      await act(async () => setNativeValue(select('Number of scoring places')!, '20'));
      expect(save().disabled).toBe(true);
      expect(document.body.textContent).toContain('Scoring table: places 17, 18, 19 and 20 are blank.');
      expect(save().getAttribute('aria-describedby')).toBe(
        document.body.querySelector('[role="status"]')!.id
      );

      for (const place of [17, 18, 19, 20]) {
        await act(async () => setNativeValue(input(`Points for place ${place}`)!, '1'));
      }
      expect(save().disabled).toBe(false);
      await click(save());
      await flush();

      expect(posts).toHaveLength(1);
      const table = posts[0].settings.scoringPoints;
      expect(table).toHaveLength(20);
      expect(table.every(v => typeof v === 'number')).toBe(true);
      expect(table.slice(16)).toStrictEqual([1, 1, 1, 1]);
    });

    it('an unedited editor saves the loaded table as it was', async () => {
      const posts: { settings: ScoringSettings }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
          if (init?.method === 'POST') {
            posts.push(JSON.parse(init.body ?? '{}'));
            return { ok: true, json: async () => ({ id: 'mine' }) };
          }
          throw new Error('network disabled in this test');
        })
      );
      await act(async () => {
        root.render(createElement(ScoringPresetManagerModal, { onClose: () => {} }));
      });
      await flush();
      await click(buttonByText('New rule set')!);
      await act(async () => setNativeValue(input('Preset label')!, 'Plain'));
      await click(buttonByText('Save rule set')!);
      await flush();
      expect(posts).toHaveLength(1);
      expect(posts[0].settings.scoringPoints).toStrictEqual(mergeScoringSettings({}).scoringPoints);
    });
  });

  // ---- the shared message --------------------------------------------------

  describe('describeBlankPlaces', () => {
    it('names the table and uses plain words', () => {
      expect(describeBlankPlaces([])).toBeNull();
      expect(describeBlankPlaces([{ table: 'relayPoints', place: 1 }])).toBe('Relay table: place 1 is blank.');
      expect(
        describeBlankPlaces([
          { table: 'scoringPoints', place: 3 },
          { table: 'scoringPoints', place: 4 },
          { table: 'divingPoints', place: 1 },
        ])
      ).toBe('Scoring table: places 3 and 4 are blank. Diving table: place 1 is blank.');
    });
  });
});
