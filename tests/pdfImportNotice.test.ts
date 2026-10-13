// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C5-UI: the meet import screen shows how the PDF was read.
 *
 *  - pipeline "legacy"                    -> a visible warning, with the roll-up and the reason
 *  - 422 points_on_status_clock           -> an error that names the rows and says nothing was imported
 *  - 422 with rows, no code               -> the same panel
 *  - a clean unified read                 -> no notice
 *
 * Mutation map (revert the change, the named case turns red):
 *  - OpsModule stops setting the notice on a legacy read     -> "a legacy read shows the warning ..."
 *  - OpsModule keeps the refusal as a toast only             -> "a 422 points_on_status_clock shows its rows ..."
 *  - the helper stops reading `pipeline`                     -> "noticeForParsedMeet: legacy"
 *  - the legacy-fallback warning is listed twice             -> "the fallback warning is the reason, not a second row"
 *  - the next upload keeps the old notice                    -> "a new upload clears the previous notice"
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type Workspace } from '@omniswim/core/types';
import OpsModule from '../packages/matrix/src/components/OpsModule';
import {
  LEGACY_FALLBACK_WARNING_CODE,
  noticeForParsedMeet,
  noticeForRefusedMeet,
} from '../packages/matrix/src/lib/pdfImportNotice';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

const suite = vi.hoisted(() => ({ workspaces: [] as unknown[] }));
vi.mock('@omniswim/core/store/SuiteWorkspaceProvider', () => ({
  useSuiteWorkspace: () => ({
    activeWorkspace: null,
    activeGender: 'Men',
    workspaces: suite.workspaces,
    updateWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEGACY_RESPONSE = {
  results: [],
  pipeline: 'legacy',
  warnings: [
    {
      code: LEGACY_FALLBACK_WARNING_CODE,
      rows: 12,
      examples: ['The main PDF parser failed, so the older fallback parser read this file. Reason: columns moved'],
    },
    { code: 'relay_split_from_legacy', rows: 3, examples: ['Relay 4 split read from the older parser'] },
  ],
};

describe('noticeForParsedMeet', () => {
  it('legacy: a warning with the older-parser words, the roll-up and the reason', () => {
    const notice = noticeForParsedMeet(LEGACY_RESPONSE)!;
    expect(notice.tone).toBe('warning');
    expect(notice.title).toBe('This meet was read with the older parser.');
    expect(notice.body).toBe('Check relay splits before you trust them.');
    expect(notice.legacyReason).toContain('Reason: columns moved');
    expect(notice.warnings.map(w => w.code)).toEqual(['relay_split_from_legacy']);
  });

  it('the fallback warning is the reason, not a second row in the list', () => {
    const notice = noticeForParsedMeet(LEGACY_RESPONSE)!;
    expect(notice.warnings.some(w => w.code === LEGACY_FALLBACK_WARNING_CODE)).toBe(false);
  });

  it('a unified read with warnings still shows them; a clean unified read shows nothing', () => {
    const withWarnings = noticeForParsedMeet({
      pipeline: 'unified',
      warnings: [{ code: 'relay_leg_missing', rows: 2, examples: ['Relay 7 has 3 legs'] }],
    })!;
    expect(withWarnings.tone).toBe('warning');
    expect(withWarnings.legacyReason).toBeNull();
    expect(withWarnings.warnings).toHaveLength(1);
    expect(noticeForParsedMeet({ pipeline: 'unified', warnings: [] })).toBeNull();
    expect(noticeForParsedMeet({ pipeline: 'unified' })).toBeNull();
  });
});

describe('noticeForRefusedMeet', () => {
  it('points_on_status_clock names the rows and says nothing was imported', () => {
    const notice = noticeForRefusedMeet({
      error: 'Place points sit beside an NT, DQ, NS, SCR or DNF time',
      code: 'points_on_status_clock',
      rows: ['row 12 (Ann Lee, 100 Free): 17 points beside NT', 'row 40 (Bo Kim, 200 Back): 9 points beside DQ'],
    })!;
    expect(notice.tone).toBe('error');
    expect(notice.title).toBe('Nothing was imported.');
    expect(notice.rows).toHaveLength(2);
    expect(notice.body).toContain('NT, DQ, NS, SCR or DNF');
  });

  it('a refusal with rows and no code gets the same panel; one without rows gets none', () => {
    expect(noticeForRefusedMeet({ error: 'PDF rows could not be read without guessing', rows: ['row 3 (x, y)'] })!.title)
      .toBe('Nothing was imported.');
    expect(noticeForRefusedMeet({ error: 'Failed to parse PDF', details: 'boom' })).toBeNull();
    expect(noticeForRefusedMeet({ error: 'x', rows: [] })).toBeNull();
    // Rows that are not strings are not rendered as "[object Object]".
    expect(noticeForRefusedMeet({ error: 'x', rows: [{ a: 1 }] })).toBeNull();
  });
});

describe('the meet import screen', () => {
  let container: HTMLDivElement;
  let root: Root;

  const workspace = {
    id: 'ws-import',
    name: 'Import test',
    createdAt: 1,
    menResults: [],
    womenResults: [],
    recruits: [],
  } as unknown as Workspace;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sessionStorage.clear();
    suite.workspaces = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function settle(times = 6) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
      });
    }
  }

  async function mount(response: { ok: boolean; status: number; body: unknown }) {
    const onUpdate = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
        text: async () => JSON.stringify(response.body),
      }))
    );
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(ToastProvider, null, createElement(OpsModule, { workspace, gender: Gender.MEN, onUpdate }))
        )
      );
    });
    await settle(2);
    return onUpdate;
  }

  async function upload() {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Meet results PDF file"]')!;
    const file = new File(['%PDF-1.4'], 'meet.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  }

  const panel = () => document.body.querySelector<HTMLElement>('[data-testid="pdf-import-notice"]');

  it('a legacy read shows the warning, the roll-up and the reason, and the meet is still imported', async () => {
    const onUpdate = await mount({ ok: true, status: 200, body: LEGACY_RESPONSE });
    await upload();
    expect(onUpdate).toHaveBeenCalled();
    const el = panel()!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('data-tone')).toBe('warning');
    expect(el.textContent).toContain('This meet was read with the older parser.');
    expect(el.textContent).toContain('Check relay splits before you trust them.');
    expect(el.textContent).toContain('relay_split_from_legacy');
    expect(el.textContent).toContain('Reason: columns moved');
  });

  it('a 422 points_on_status_clock shows its rows as an error and imports nothing', async () => {
    const onUpdate = await mount({
      ok: false,
      status: 422,
      body: {
        error: 'Place points sit beside an NT, DQ, NS, SCR or DNF time',
        code: 'points_on_status_clock',
        details: 'x',
        rows: ['row 12 (Ann Lee, 100 Free): 17 points beside NT'],
      },
    });
    await upload();
    expect(onUpdate).not.toHaveBeenCalled();
    const el = panel()!;
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.textContent).toContain('Nothing was imported.');
    expect(el.textContent).toContain('row 12 (Ann Lee, 100 Free): 17 points beside NT');
  });

  it('a clean unified read shows no notice', async () => {
    await mount({ ok: true, status: 200, body: { results: [], pipeline: 'unified', warnings: [] } });
    await upload();
    expect(panel()).toBeNull();
  });

  it('a new upload clears the previous notice, even when the new upload fails with a plain error', async () => {
    await mount({ ok: true, status: 200, body: LEGACY_RESPONSE });
    await upload();
    expect(panel()).not.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Failed to parse PDF', details: 'boom' }),
      }))
    );
    await upload();
    expect(panel()).toBeNull();
  });
});
