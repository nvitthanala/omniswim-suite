// @vitest-environment happy-dom
/**
 * Regression cover for "workspaces are glitchy when removing them all — they
 * swap between workspaces incessantly".
 *
 * Root cause under test: three of the four workspace API helpers never looked at
 * `res.ok`, so a failed request was indistinguishable from a successful one.
 *
 *   - `fetchWorkspaces` coerced an error body to `[]`, which made the query
 *     *succeed* with an empty list. The provider's "keep a valid workspace
 *     selected" effect then drove `activeWorkspaceId` to null, and the next
 *     successful poll re-picked `workspaces[0]` — not the workspace the user had
 *     selected. Every server hiccup therefore blanked the sidebar and moved the
 *     selection, with no error surfaced anywhere.
 *   - `deleteWorkspaceApi` reported a rejected DELETE as a success, so the client
 *     dropped a workspace the server still held. The next read resurrected it.
 *
 * These tests render the real provider against a controllable fake fetch and
 * assert on the *committed* selection after every commit, so a flapping
 * selection is visible in the log rather than hidden by the final value.
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
import {
  createWorkspace,
  deleteWorkspaceApi,
  fetchWorkspaces,
} from '@omniswim/core/api/workspaces';
import type { Workspace } from '@omniswim/core/types';

type Ctx = ReturnType<typeof useSuiteWorkspace>;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeWorkspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    createdAt: 1,
  } as unknown as Workspace;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------- fake server

type FakeServer = {
  workspaces: Workspace[];
  /** Ids the server rejects with a 500 on DELETE. */
  failDeletes: Set<string>;
  /** When set, GET /api/workspaces answers with this status and an error body. */
  failList: number | null;
  /** Deletes park here while `holdDeletes` is on, so several overlap. */
  pending: Array<() => void>;
  deleteCalls: string[];
};

let server: FakeServer;
let holdDeletes = false;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/api/workspaces') && method === 'GET') {
      if (server.failList != null) {
        return jsonResponse(server.failList, { error: 'Failed to read workspaces' });
      }
      return jsonResponse(200, server.workspaces);
    }

    if (url.endsWith('/api/workspaces') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Partial<Workspace>;
      const created = makeWorkspace(body.id ?? `new-${server.workspaces.length}`, body.name ?? 'New');
      server.workspaces = [...server.workspaces, created];
      return jsonResponse(200, created);
    }

    const del = /\/api\/workspaces\/([^/]+)$/.exec(url);
    if (del && method === 'DELETE') {
      const id = del[1];
      server.deleteCalls.push(id);
      const run = () => {
        if (server.failDeletes.has(id)) {
          return jsonResponse(500, { error: 'Failed to delete workspace' });
        }
        server.workspaces = server.workspaces.filter(w => w.id !== id);
        return jsonResponse(200, { success: true });
      };
      if (!holdDeletes) return run();
      return new Promise<Response>(resolve => {
        server.pending.push(() => resolve(run()));
      });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

// --------------------------------------------------------------- test harness

let ctx: Ctx | null = null;
let commitLog: Array<string | null> = [];
let notices: Array<[string, string]> = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe() {
  const value = useSuiteWorkspace();
  ctx = value;
  useEffect(() => {
    commitLog.push(value.activeWorkspaceId);
  });
  return null;
}

/** Flush microtasks/timers inside act until the tree settles. */
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
  }
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
          { onNotify: (kind: string, message: string) => notices.push([kind, message]) },
          React.createElement(Probe)
        )
      )
    );
  });
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
  ctx = null;
  commitLog = [];
  notices = [];
  holdDeletes = false;
  server = {
    workspaces: [
      makeWorkspace('a', 'Alpha'),
      makeWorkspace('b', 'Bravo'),
      makeWorkspace('c', 'Charlie'),
    ],
    failDeletes: new Set(),
    failList: null,
    pending: [],
    deleteCalls: [],
  };
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

// ------------------------------------------------------- api layer, in isolation

describe('workspace API helpers surface transport failures', () => {
  it('fetchWorkspaces rejects on a non-OK response instead of returning []', async () => {
    server.failList = 500;
    await expect(fetchWorkspaces()).rejects.toThrow(/workspace/i);
  });

  it('deleteWorkspaceApi rejects on a non-OK response', async () => {
    server.failDeletes.add('b');
    await expect(deleteWorkspaceApi('b')).rejects.toThrow(/delete/i);
    // the server never dropped it
    expect(server.workspaces.map(w => w.id)).toContain('b');
  });

  it('createWorkspace rejects on a non-OK response instead of returning an error body', async () => {
    globalThis.fetch = (async () => jsonResponse(500, { error: 'boom' })) as typeof fetch;
    await expect(createWorkspace('X')).rejects.toThrow();
  });
});

// ------------------------------------------------------------ provider behaviour

describe('SuiteWorkspaceProvider keeps the selection stable', () => {
  it('a failed list refetch neither empties the sidebar nor moves the selection', async () => {
    await mount();
    // Select a workspace that is NOT workspaces[0] — that is what makes a
    // silent reset visible as a "swap" rather than a no-op.
    await act(async () => {
      ctx!.setActiveWorkspaceId('c');
    });
    await settle(2);
    expect(ctx!.activeWorkspaceId).toBe('c');

    commitLog = [];
    server.failList = 500;
    await act(async () => {
      await ctx!.refreshWorkspaces();
    });
    await settle();

    // The list must survive the outage...
    expect(ctx!.workspaces.map(w => w.id)).toEqual(['a', 'b', 'c']);
    // ...and so must the user's selection.
    expect(ctx!.activeWorkspaceId).toBe('c');
    // Never blanked, never re-pointed at workspaces[0], at any commit.
    expect(commitLog).not.toContain(null);
    expect(commitLog).not.toContain('a');
    // The failure is reported rather than swallowed.
    expect(ctx!.error).toBeTruthy();

    // Recovery does not move the selection either.
    server.failList = null;
    await act(async () => {
      await ctx!.refreshWorkspaces();
    });
    await settle();
    expect(ctx!.activeWorkspaceId).toBe('c');
  });

  it('a rejected DELETE keeps the workspace instead of resurrecting it later', async () => {
    await mount();
    server.failDeletes.add('b');
    await act(async () => {
      ctx!.setActiveWorkspaceId('b');
    });
    await settle(2);

    commitLog = [];
    let caught: unknown = null;
    await act(async () => {
      caught = await ctx!.deleteWorkspace('b').then(
        () => null,
        (e: unknown) => e
      );
    });
    await settle();
    expect(caught).toBeInstanceOf(Error);

    // Client and server agree: 'b' is still there.
    expect(ctx!.workspaces.map(w => w.id)).toEqual(['a', 'b', 'c']);
    expect(server.workspaces.map(w => w.id)).toContain('b');
    expect(ctx!.activeWorkspaceId).toBe('b');
    expect(notices.some(([kind]) => kind === 'error')).toBe(true);

    // A later read must not surprise the user with a reappearing workspace.
    await act(async () => {
      await ctx!.refreshWorkspaces();
    });
    await settle();
    expect(ctx!.activeWorkspaceId).toBe('b');
    expect(commitLog).not.toContain(null);
  });

  it('deleting every workspace in quick succession settles once on null', async () => {
    await mount();
    expect(ctx!.activeWorkspaceId).toBe('a');

    holdDeletes = true;
    commitLog = [];

    // Three trash-can confirmations before any request has come back.
    const inFlight: Array<Promise<void>> = [];
    await act(async () => {
      inFlight.push(ctx!.deleteWorkspace('a'));
      inFlight.push(ctx!.deleteWorkspace('b'));
      inFlight.push(ctx!.deleteWorkspace('c'));
    });
    await act(async () => {
      for (const release of server.pending) release();
      await Promise.all(inFlight);
    });
    await settle();

    expect(ctx!.workspaces).toEqual([]);
    expect(ctx!.activeWorkspaceId).toBeNull();
    expect(server.workspaces).toEqual([]);

    // The selection walks strictly forward and never revisits a deleted id.
    const distinct = commitLog.filter((v, i) => i === 0 || v !== commitLog[i - 1]);
    expect(distinct).toEqual([null]);
    // Nothing was resurrected by a follow-up read.
    await act(async () => {
      await ctx!.refreshWorkspaces();
    });
    await settle();
    expect(ctx!.activeWorkspaceId).toBeNull();
    expect(ctx!.workspaces).toEqual([]);
  });

  it('deleting one at a time hands the selection forward without flapping', async () => {
    await mount();
    commitLog = [];

    for (const id of ['a', 'b', 'c']) {
      await act(async () => {
        await ctx!.deleteWorkspace(id);
      });
      await settle(2);
    }

    const distinct = commitLog.filter((v, i) => i === 0 || v !== commitLog[i - 1]);
    // b, then c, then nothing left — each value appears once, in order.
    expect(distinct).toEqual(['b', 'c', null]);
    expect(ctx!.activeWorkspaceId).toBeNull();
  });

  it('the selection is never a non-null id that is absent from the list', async () => {
    await mount();
    await act(async () => {
      await ctx!.deleteWorkspace('a');
    });
    await settle();
    for (const id of commitLog) {
      if (id != null) {
        expect(ctx!.workspaces.some(w => w.id === id) || id === 'a').toBe(true);
      }
    }
    expect(ctx!.activeWorkspaceId).toBe('b');
    expect(ctx!.activeWorkspace?.id).toBe('b');
  });
});
