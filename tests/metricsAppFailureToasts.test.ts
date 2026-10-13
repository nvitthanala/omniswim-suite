// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P4: a failed read of saved sessions, or of a video's metadata, used to end in
 * `.catch(() => undefined)`. An unreadable session store looked the same as an
 * empty one. These tests render the real MetricsApp inside the real ToastProvider
 * and require the toast.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = vi.hoisted(() => ({
  available: true,
  listSessions: vi.fn(),
  loadSession: vi.fn(),
  deleteSession: vi.fn(),
  saveSession: vi.fn(),
  extractVideoMeta: vi.fn(),
}));

vi.mock('../packages/metrics/src/lib/sessionStore', () => ({
  isIndexedDbAvailable: () => store.available,
  listSessions: (...a: unknown[]) => store.listSessions(...a),
  loadSession: (...a: unknown[]) => store.loadSession(...a),
  deleteSession: (...a: unknown[]) => store.deleteSession(...a),
  saveSession: (...a: unknown[]) => store.saveSession(...a),
}));
vi.mock('../packages/metrics/src/lib/videoMeta', () => ({
  extractVideoMeta: (...a: unknown[]) => store.extractVideoMeta(...a),
}));
vi.mock('@omniswim/core/store/SuiteWorkspaceProvider', () => ({
  useSuiteWorkspace: () => ({ rosterNames: [], activeWorkspace: undefined }),
}));

import MetricsApp from '../packages/metrics/src/MetricsApp';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ToastProvider, null, React.createElement(MetricsApp)));
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });
}

const alertsText = () => document.body.textContent ?? '';

/** Poll until `cond` holds. Fixed single ticks were enough on an idle machine and not on a loaded one. */
async function waitFor(what: string, cond: () => boolean, limitMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > limitMs) throw new Error(`timed out waiting for: ${what}
body: ${alertsText().slice(0, 400)}`);
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });
  }
}

beforeEach(() => {
  store.available = true;
  store.listSessions.mockReset().mockResolvedValue([]);
  store.loadSession.mockReset();
  store.deleteSession.mockReset();
  store.saveSession.mockReset();
  store.extractVideoMeta.mockReset();
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:test';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  container?.remove();
  container = null;
});

describe('MetricsApp failures reach the user', () => {
  it('an unreadable session store shows a toast instead of an empty list', async () => {
    store.listSessions.mockRejectedValue(new Error('IndexedDB blocked by the browser'));
    await mount();
    await waitFor('the session-store toast', () => alertsText().includes('Could not read saved sessions: IndexedDB blocked by the browser'));
    // The toast must not re-trigger the read that raised it.
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    expect(store.listSessions).toHaveBeenCalledTimes(1);
  });

  it('a readable store raises no failure toast', async () => {
    await mount();
    await waitFor('the session read', () => store.listSessions.mock.calls.length === 1);
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    expect(store.listSessions).toHaveBeenCalledTimes(1);
    expect(alertsText()).not.toContain('Could not read saved sessions');
  });

  it('a video whose metadata cannot be read shows a toast naming the file and the reason', async () => {
    store.extractVideoMeta.mockRejectedValue(new Error('Could not read video metadata'));
    await mount();
    const input = document.getElementById('metrics-file-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File(['x'], 'heat3.mov', { type: 'video/quicktime' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor('the metadata toast', () =>
      alertsText().includes('Could not read the frame rate and size of "heat3.mov": Could not read video metadata')
    );
    expect(store.extractVideoMeta).toHaveBeenCalledTimes(1);
  });

  async function openSessionsPanel() {
    store.listSessions.mockResolvedValue([{ id: 's1', label: 'Alex Rivera', updatedAt: 1, legacy: false }]);
    await mount();
    // The panel only lists a session once the (mocked) read has landed in state.
    await waitFor('the sessions button to show one saved session', () =>
      Array.from(document.querySelectorAll('button')).some(b => b.textContent?.startsWith('Sessions (1)'))
    );
    const toggle = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.startsWith('Sessions'))!;
    await act(async () => {
      toggle.click();
    });
    await waitFor('the saved-session row', () => document.querySelector('li button') !== null);
  }

  it('a session that cannot be opened shows a toast', async () => {
    store.loadSession.mockRejectedValue(new Error('read transaction aborted'));
    await openSessionsPanel();
    const row = Array.from(document.querySelectorAll('li button')).find(b => b.textContent?.includes('Alex Rivera'))!;
    await act(async () => {
      (row as HTMLButtonElement).click();
    });
    await waitFor('the open-failure toast', () =>
      alertsText().includes('Could not open the saved session: read transaction aborted')
    );
  });

  it('a session that cannot be deleted shows a toast and no success message', async () => {
    store.deleteSession.mockRejectedValue(new Error('database is closing'));
    await openSessionsPanel();
    const del = document.querySelector('button[aria-label="Delete session"]') as HTMLButtonElement;
    await act(async () => {
      del.click();
    });
    await waitFor('the delete-failure toast', () =>
      alertsText().includes('Could not delete the saved session: database is closing')
    );
    expect(alertsText()).not.toContain('Saved session deleted');
  });
});
