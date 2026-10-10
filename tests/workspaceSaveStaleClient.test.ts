// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client half of out-of-order save protection.
 *
 * 1. Every PUT carries the page's client id and a per-workspace save number that
 *    only goes up.
 * 2. When the server answers 409 STALE_SAVE the user is told (a notice, not a
 *    silent drop), the cache keeps the newer local data, no error banner is
 *    raised, and the list is NOT refetched (a refetch could drop a change that
 *    still waits in the debounce queue).
 * 3. Any other failure keeps its old path: error notice, banner, refetch.
 */
import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SuiteWorkspaceProvider,
  useSuiteWorkspace,
  type NotifyKind,
} from '@omniswim/core/store/SuiteWorkspaceProvider';
import { updateWorkspaceApi, StaleSaveError } from '@omniswim/core/api/workspaces';
import {
  SAVE_CLIENT_HEADER,
  SAVE_SEQ_HEADER,
  STALE_SAVE_CODE,
} from '@omniswim/core/api/saveSequence';
import type { Workspace } from '@omniswim/core/types';

type Ctx = ReturnType<typeof useSuiteWorkspace>;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeWorkspace(id: string, activeEntryIds: string[]): Workspace {
  return {
    id,
    name: id,
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    createdAt: 1,
    activeEntryIds,
  } as unknown as Workspace;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

type HeldPut = {
  id: string;
  patch: Partial<Workspace>;
  headers: Record<string, string>;
  succeed: () => void;
  stale: () => void;
  fail: () => void;
};

let serverCopies: Record<string, Workspace>;
let puts: HeldPut[];
let getCount: number;
let notices: Array<{ kind: NotifyKind; message: string }>;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/api/workspaces') && method === 'GET') {
      getCount += 1;
      return jsonResponse(200, Object.values(serverCopies));
    }
    const put = /\/api\/workspaces\/([^/]+)$/.exec(url);
    if (put && method === 'PUT') {
      const id = put[1];
      const patch = JSON.parse(String(init?.body ?? '{}')) as Partial<Workspace>;
      return new Promise<Response>(resolve => {
        puts.push({
          id,
          patch,
          headers: { ...(init?.headers as Record<string, string>) },
          succeed: () => {
            serverCopies[id] = { ...serverCopies[id], ...patch } as Workspace;
            resolve(jsonResponse(200, serverCopies[id]));
          },
          stale: () =>
            resolve(
              jsonResponse(409, {
                error: 'This save was superseded by a newer one and was not applied.',
                code: STALE_SAVE_CODE,
                lastAppliedSeq: 2,
                receivedSeq: 1,
              })
            ),
          fail: () => resolve(jsonResponse(500, { error: 'boom' })),
        });
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

let ctx: Ctx | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe() {
  const value = useSuiteWorkspace();
  useEffect(() => {
    ctx = value;
  });
  ctx = value;
  return null;
}

async function tick(ms = 0) {
  await act(async () => {
    await new Promise(r => setTimeout(r, ms));
  });
}

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  container = el;
  const r = createRoot(el);
  root = r;
  await act(async () => {
    r.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          SuiteWorkspaceProvider,
          { onNotify: (kind: NotifyKind, message: string) => notices.push({ kind, message }) },
          React.createElement(Probe)
        )
      )
    );
  });
  await tick();
  await tick();
}

const ids = () => ctx!.activeWorkspace?.activeEntryIds;
const waitForDebounce = () => tick(380);

async function edit(entryIds: string[]) {
  await act(async () => {
    await ctx!.updateWorkspace({ activeEntryIds: entryIds });
  });
  await waitForDebounce();
}

beforeEach(() => {
  window.localStorage.clear();
  ctx = null;
  puts = [];
  getCount = 0;
  notices = [];
  serverCopies = { a: makeWorkspace('a', ['pre']) };
  installFetch();
});

afterEach(async () => {
  const currentRoot = root;
  const currentContainer = container;
  root = null;
  container = null;
  if (currentRoot) {
    await act(async () => {
      currentRoot.unmount();
    });
  }
  currentContainer?.remove();
});

describe('save numbering', () => {
  it('every PUT carries one client id and a per-workspace number that only goes up', async () => {
    serverCopies = { a: makeWorkspace('a', ['pre']), b: makeWorkspace('b', ['b-pre']) };
    await mount();
    await edit(['a1']);
    await edit(['a2']);
    await act(async () => {
      ctx!.setActiveWorkspaceId('b');
    });
    await edit(['b1']);
    expect(puts).toHaveLength(3);

    const seqs = puts.map(p => Number(p.headers[SAVE_SEQ_HEADER]));
    expect(seqs).toEqual([1, 2, 1]); // a:1, a:2, b:1 — numbered per workspace
    const clientIds = new Set(puts.map(p => p.headers[SAVE_CLIENT_HEADER]));
    expect(clientIds.size).toBe(1);
    expect([...clientIds][0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // The patch body stays a pure patch: no sequence leaks into workspace data.
    for (const p of puts) expect(Object.keys(p.patch)).toEqual(['activeEntryIds']);
  });

  it('two page loads use two client ids', async () => {
    await mount();
    await edit(['x']);
    const first = puts[0].headers[SAVE_CLIENT_HEADER];
    await act(async () => {
      root!.unmount();
    });
    root = null;
    container?.remove();
    puts = [];
    await mount();
    await edit(['y']);
    expect(puts[0].headers[SAVE_CLIENT_HEADER]).not.toBe(first);
  });
});

describe('a refused stale save is visible, not silent', () => {
  it('409 STALE_SAVE: notice shown, cache keeps the newer data, no banner, no refetch', async () => {
    await mount();
    await edit(['A']); // seq 1, held
    await edit(['B']); // seq 2, held
    expect(puts).toHaveLength(2);
    const readsBefore = getCount;

    // B lands first, then A is refused as stale.
    await act(async () => {
      puts[1].succeed();
    });
    await tick();
    await act(async () => {
      puts[0].stale();
    });
    await tick();
    await tick();

    expect(ids()).toEqual(['B']);
    expect(serverCopies.a.activeEntryIds).toEqual(['B']);
    expect(ctx!.error).toBeNull();
    expect(getCount).toBe(readsBefore);
    const info = notices.filter(n => n.kind === 'info');
    expect(info).toHaveLength(1);
    expect(info[0].message).toMatch(/older save/i);
    expect(notices.filter(n => n.kind === 'error')).toHaveLength(0);
  });

  it('a stale refusal does not eat a change still waiting in the debounce queue', async () => {
    await mount();
    await edit(['A']);
    await edit(['B']);
    await act(async () => {
      puts[1].succeed();
    });
    // C is queued but not yet sent when A's refusal arrives.
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['C'] });
    });
    await act(async () => {
      puts[0].stale();
    });
    await tick();
    expect(ids()).toEqual(['C']);
    await waitForDebounce();
    expect(puts).toHaveLength(3);
    expect(puts[2].patch.activeEntryIds).toEqual(['C']);
  });

  it('any other failure keeps the old path: error notice, banner, refetch', async () => {
    await mount();
    const readsBefore = getCount;
    await edit(['A']);
    await act(async () => {
      puts[0].fail();
    });
    await tick();
    await tick();
    expect(ctx!.error).toBe('boom');
    expect(getCount).toBeGreaterThan(readsBefore);
    expect(notices.some(n => n.kind === 'error' && n.message === 'boom')).toBe(true);
  });
});

describe('updateWorkspaceApi', () => {
  it('sends no sequence headers when no token is given (compat for other callers)', async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = { ...(init?.headers as Record<string, string>) };
      return jsonResponse(200, makeWorkspace('a', []));
    }) as typeof fetch;
    await updateWorkspaceApi('a', { name: 'n' });
    expect(seen).not.toHaveProperty(SAVE_SEQ_HEADER);
    expect(seen).not.toHaveProperty(SAVE_CLIENT_HEADER);
  });

  it('turns a 409 STALE_SAVE into a StaleSaveError, and other 409s stay plain errors', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(409, { error: 'old', code: STALE_SAVE_CODE, lastAppliedSeq: 4, receivedSeq: 3 })) as typeof fetch;
    const err = await updateWorkspaceApi('a', {}, { clientId: 'client-aaaaaaaa', seq: 3 }).catch(e => e);
    expect(err).toBeInstanceOf(StaleSaveError);
    expect(err.lastAppliedSeq).toBe(4);
    expect(err.receivedSeq).toBe(3);

    globalThis.fetch = (async () =>
      jsonResponse(409, { error: 'Version conflict — refresh and retry', code: 'VERSION_CONFLICT' })) as typeof fetch;
    const other = await updateWorkspaceApi('a', {}).catch(e => e);
    expect(other).not.toBeInstanceOf(StaleSaveError);
    expect(other.message).toMatch(/Version conflict/);
  });
});
