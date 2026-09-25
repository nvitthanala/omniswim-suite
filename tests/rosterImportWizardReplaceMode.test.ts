// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `RosterImportWizard`'s merge/replace choice (plans/2026-09-24, item A1) —
 * the coach-facing half of `importHistoryToRoster(..., { mode: 'replace' })`.
 * The core replace logic (`planSwimCloudReplace`, `previewSwimCloudReplace`,
 * `SwimCloudReplaceRefusedError`) is proven against
 * `tests/fixtures/hsu-2026-27-replace-snapshot.json` in
 * `tests/swimCloudReplaceImport.test.ts`; this file only exercises the glue
 * this package owns: the mode picker defaults to merge, choosing "Replace"
 * renders the real removal preview computed from that same fixture, and the
 * confirm step backs the workspace up (`POST /api/workspaces/backup`) before
 * it ever calls `onUpdate`, aborting if that backup fails.
 *
 * Written without JSX (plain `React.createElement`), matching
 * `tests/rosterImportWizardClipboardRouting.test.ts`'s convention for this
 * component. `useToast` outside a `ToastProvider` falls back to
 * `console.error`/`console.log` — see that file's header comment.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type Workspace } from '@omniswim/core/types';
import { NSISC_PRESET_SETTINGS } from '@omniswim/core/lib/scoringDefaults';
import RosterImportWizard from '@omniswim/manager/components/RosterImportWizard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';

type Snapshot = {
  athleteHistory: Workspace['athleteHistory'];
  recruits: Workspace['recruits'];
  meetEntryPlans: Workspace['meetEntryPlans'];
  activeEntryIds: string[];
};

const SNAPSHOT: Snapshot = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'hsu-2026-27-replace-snapshot.json'), 'utf8')
);

/** Same stored Capocci/Kis rows `swimCloudReplaceImport.test.ts` builds the plan against. */
function fixtureWorkspace(): Workspace {
  const snap: Snapshot = structuredClone(SNAPSHOT);
  return {
    id: 'ws-hsu-snapshot',
    name: 'HSU 2026-27 Roster Plan (snapshot)',
    createdAt: 0,
    conference: 'NSISC',
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    menResults: [],
    womenResults: [],
    athleteHistory: snap.athleteHistory,
    recruits: snap.recruits,
    meetEntryPlans: snap.meetEntryPlans,
    activeEntryIds: snap.activeEntryIds,
    athleteAliases: [],
  } as Workspace;
}

// Only Noel Kis's row is re-captured — Fabio Capocci is entirely absent from
// this "incoming" paste, so a replace preview must list him under
// `athletesAbsentFromIncoming`.
const CSV_INCOMING = ['name,event,time,team,gender', `Noel Kis,100 Freestyle,48.99,${HSU},Men`].join(
  '\n'
);

describe('RosterImportWizard — merge/replace mode', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onUpdate: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onUpdate = vi.fn();
    onClose = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('no native value setter');
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function clickByText(text: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text));
    if (!btn) throw new Error(`button "${text}" not rendered`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return btn;
  }

  /** Mounts the wizard, names the HSU team, pastes the CSV capture, and parses to the preview step. */
  async function renderAtPreviewStep(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(RosterImportWizard, {
          workspace: fixtureWorkspace(),
          gender: Gender.MEN,
          onClose,
          onUpdate,
        })
      );
    });

    const teamInput = container.querySelector<HTMLInputElement>('input[aria-label="Custom team name"]');
    if (!teamInput) throw new Error('team input not rendered');
    await act(async () => {
      setNativeValue(teamInput, HSU);
    });

    await act(async () => {
      clickByText('CSV');
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('CSV textarea not rendered');
    await act(async () => {
      setNativeValue(textarea, CSV_INCOMING);
    });

    await act(async () => {
      clickByText('Preview');
    });
  }

  it('defaults to merge, with no replace preview shown', async () => {
    await renderAtPreviewStep();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="swimcloud-import-mode"]')];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true); // merge
    expect(radios[1].checked).toBe(false); // replace
    expect(container.textContent).not.toContain('history row');
    expect(
      [...container.querySelectorAll('button')].some(b => b.textContent?.includes('Import & add to roster'))
    ).toBe(true);
  });

  it('choosing replace renders the real removal preview from the fixture', async () => {
    await renderAtPreviewStep();
    const replaceRadio = container.querySelectorAll<HTMLInputElement>(
      'input[name="swimcloud-import-mode"]'
    )[1];
    await act(async () => {
      replaceRadio.click();
    });

    // The fixture's stored Capocci rows are removed (see
    // tests/swimCloudReplaceImport.test.ts) and he never appears in
    // CSV_INCOMING, so the preview must warn he is absent from this capture.
    expect(container.textContent).toContain('history row');
    expect(container.textContent).toContain('Fabio Capocci');
    expect(container.textContent).toContain('not in this capture');
    expect(
      [...container.querySelectorAll('button')].some(b => b.textContent?.includes('Review replace'))
    ).toBe(true);
  });

  it('backs the workspace up before updating, and never updates if the backup fails', async () => {
    const fetchCalls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        fetchCalls.push({ url, method: init?.method });
        return { ok: false, status: 500, json: async () => ({ error: 'disk full' }) } as Response;
      })
    );

    await renderAtPreviewStep();
    const replaceRadio = container.querySelectorAll<HTMLInputElement>(
      'input[name="swimcloud-import-mode"]'
    )[1];
    await act(async () => {
      replaceRadio.click();
    });
    await act(async () => {
      clickByText('Review replace');
    });
    await act(async () => {
      clickByText('Back up & replace');
    });
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/workspaces/backup');
    expect(fetchCalls[0].method).toBe('POST');
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The confirm dialog is still up, ready to retry, not stuck mid-request.
    expect(
      [...container.querySelectorAll('button')].some(b => b.textContent?.includes('Back up & replace'))
    ).toBe(true);
  });

  it('updates the workspace with the replace patch once the backup succeeds', async () => {
    const fetchCalls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        fetchCalls.push({ url, method: init?.method });
        return { ok: true, status: 200, json: async () => ({ success: true, file: 'manual-x.json' }) } as Response;
      })
    );

    await renderAtPreviewStep();
    const replaceRadio = container.querySelectorAll<HTMLInputElement>(
      'input[name="swimcloud-import-mode"]'
    )[1];
    await act(async () => {
      replaceRadio.click();
    });
    await act(async () => {
      clickByText('Review replace');
    });
    await act(async () => {
      clickByText('Back up & replace');
    });
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/api/workspaces/backup');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const patch = onUpdate.mock.calls[0][0] as Partial<Workspace>;
    expect(Array.isArray(patch.athleteHistory)).toBe(true);
    // The fixture's Capocci history rows are all SwimCloud-sourced and removed.
    expect((patch.athleteHistory ?? []).some(h => h.name === 'Fabio Capocci')).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
