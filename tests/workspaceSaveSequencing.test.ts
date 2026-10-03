// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A save response must not overwrite a newer local change.
 *
 * `updateWorkspace` writes the cache at once, then sends the PUT 300 ms later. The old `onSuccess`
 * replaced the cache with whatever the server returned. When the coach changed the lineup while an
 * earlier PUT was still in flight (Apply, then Undo), the late response put the OLD arrays back in
 * view. The Undo watcher then read that as "the undo was not saved". The provider now numbers every
 * save per workspace and ignores a response unless it belongs to the latest save and nothing is
 * waiting in the debounce queue.
 *
 * These tests drive the real provider against a fake fetch whose PUT responses the test releases
 * by hand, so the order of arrival is the test's choice.
 */
import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SuiteWorkspaceProvider,
  useSuiteWorkspace,
} from '@omniswim/core/store/SuiteWorkspaceProvider';
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
  /** Answer with the server copy as it stands after this PUT. */
  succeed: (extra?: Partial<Workspace>) => void;
  fail: () => void;
};

let serverCopies: Record<string, Workspace>;
let puts: HeldPut[];
let getCount: number;

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
          succeed: extra => {
            // The server applies the patch when it answers.
            serverCopies[id] = { ...serverCopies[id], ...patch, ...(extra ?? {}) } as Workspace;
            resolve(jsonResponse(200, serverCopies[id]));
          },
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
        React.createElement(SuiteWorkspaceProvider, null, React.createElement(Probe))
      )
    );
  });
  await tick();
  await tick();
}

const ids = () => ctx!.activeWorkspace?.activeEntryIds;

/** The debounce is 300 ms. Wait past it so the PUT for the queued patch is sent. */
const waitForDebounce = () => tick(380);

beforeEach(() => {
  window.localStorage.clear();
  ctx = null;
  puts = [];
  getCount = 0;
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

describe('a late save response never overwrites a newer local change', () => {
  it('Apply in flight, Undo pressed, Apply response lands late: the cache keeps the Undo', async () => {
    await mount();
    expect(ids()).toEqual(['pre']);

    // Apply: cache shows the optimized arrays, then PUT A is sent and held.
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['optimized'] });
    });
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    expect(ids()).toEqual(['optimized']);

    // Undo while PUT A is in flight: the cache shows the pre-run arrays at once.
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['pre'] });
    });
    await tick(); // react-query tells observers on a 0 ms timer
    expect(ids()).toEqual(['pre']);

    // PUT A answers late, with the optimized arrays. The Undo is still waiting in the queue.
    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    expect(ids()).toEqual(['pre']); // not flipped back to the optimized lineup

    // The Undo's own save is sent and lands: the cache agrees with the server.
    await waitForDebounce();
    expect(puts).toHaveLength(2);
    await act(async () => {
      puts[1].succeed();
    });
    await tick();
    expect(ids()).toEqual(['pre']);
    expect(serverCopies.a.activeEntryIds).toEqual(['pre']);
  });

  it('out of order: the older response arrives after the newer save was sent', async () => {
    await mount();
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['optimized'] });
    });
    await waitForDebounce(); // PUT A sent
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['pre'] });
    });
    await waitForDebounce(); // PUT B sent, queue is empty now
    expect(puts).toHaveLength(2);

    // Only the debounce queue is empty here, so the sequence check alone must hold the line.
    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    expect(ids()).toEqual(['pre']);

    await act(async () => {
      puts[1].succeed();
    });
    await tick();
    expect(ids()).toEqual(['pre']);
  });

  it('a lone save still takes the server copy (server-set fields reach the cache)', async () => {
    await mount();
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['x'] });
    });
    await waitForDebounce();
    await act(async () => {
      puts[0].succeed({ name: 'renamed-by-server' });
    });
    await tick();
    expect(ctx!.activeWorkspace?.name).toBe('renamed-by-server');
    expect(ids()).toEqual(['x']);
  });

  it('the sequence is per workspace: a save to another workspace does not mute this response', async () => {
    serverCopies = { a: makeWorkspace('a', ['pre']), b: makeWorkspace('b', ['b-pre']) };
    await mount();
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['a-new'] });
    });
    await waitForDebounce(); // PUT for a is in flight
    await act(async () => {
      ctx!.setActiveWorkspaceId('b');
    });
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['b-new'] });
    });
    await waitForDebounce(); // PUT for b is in flight
    expect(puts.map(p => p.id)).toEqual(['a', 'b']);

    await act(async () => {
      puts[0].succeed({ name: 'a-from-server' });
    });
    await tick();
    expect(ctx!.workspaces.find(w => w.id === 'a')?.name).toBe('a-from-server');
  });

  it('a failed save is unchanged: the list is re-read from the server and the error is kept', async () => {
    await mount();
    const readsBefore = getCount;
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['optimized'] });
    });
    await waitForDebounce();
    expect(ids()).toEqual(['optimized']);
    await act(async () => {
      puts[0].fail();
    });
    await tick();
    await tick();
    expect(getCount).toBeGreaterThan(readsBefore); // invalidateQueries refetched
    expect(ids()).toEqual(['pre']); // the server copy came back
    expect(ctx!.error).toBe('boom');
  });
});
