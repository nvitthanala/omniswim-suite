// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client half of out-of-order save protection.
 *
 * 0. One save is in flight per workspace at a time. Edits made meanwhile are
 *    merged into one pending patch and sent when the PUT finishes, carrying the
 *    version from that PUT's response (P3, architect decision).
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
  EXPECTED_VERSION_HEADER,
  SAVE_CLIENT_HEADER,
  SAVE_SEQ_HEADER,
  STALE_SAVE_CODE,
  VERSION_CONFLICT_CODE,
} from '@omniswim/core/api/saveSequence';
import type { Workspace } from '@omniswim/core/types';
import type { WorkspaceSaveResult } from '@omniswim/core/store/SuiteWorkspaceProvider';

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
    version: 1,
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
          // The server answers like the real one: a header version that is not the stored one
          // is refused (409 VERSION_CONFLICT) and nothing is written; otherwise the patch is
          // applied and the version moves up by one.
          succeed: () => {
            const stored = (serverCopies[id] as unknown as { version: number }).version;
            const sent = (init?.headers as Record<string, string>)[EXPECTED_VERSION_HEADER];
            if (sent !== undefined && Number(sent) !== stored) {
              resolve(jsonResponse(409, { error: 'Version conflict', code: VERSION_CONFLICT_CODE }));
              return;
            }
            serverCopies[id] = { ...serverCopies[id], ...patch, version: stored + 1 } as unknown as Workspace;
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
  // Wait for the list to land and a workspace to be selected. A fixed two ticks was enough on an
  // idle machine and dropped the first edit (no active workspace yet) when the machine was busy.
  for (let i = 0; i < 200 && !ctx?.activeWorkspace; i += 1) await tick(10);
  expect(ctx?.activeWorkspace, 'the workspace list loaded').toBeTruthy();
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
    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    await edit(['a2']);
    await act(async () => {
      puts[1].succeed();
    });
    await tick();
    await act(async () => {
      ctx!.setActiveWorkspaceId('b');
    });
    await edit(['b1']);
    expect(puts).toHaveLength(3);
    // The version each save asked about: a's first is the fetched 1, its second is the response (2),
    // and b has its own.
    expect(puts.map(p => p.headers[EXPECTED_VERSION_HEADER])).toEqual(['1', '2', '1']);

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

describe('one save in flight per workspace', () => {
  it('an edit made while a save is in flight waits, then goes out with the version from the first response', async () => {
    await mount();
    await edit(['A']); // PUT 1 sent, held
    await edit(['B']); // waits: PUT 1 has not answered
    await edit(['C']); // merges into the same pending patch
    expect(puts).toHaveLength(1);
    expect(puts[0].headers[EXPECTED_VERSION_HEADER]).toBe('1');

    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    await tick();
    expect(puts).toHaveLength(2);
    expect(puts[1].patch.activeEntryIds).toEqual(['C']);
    // The first response moved the server to version 2; the second save must ask about that.
    expect(puts[1].headers[EXPECTED_VERSION_HEADER]).toBe('2');
    // Still the same page, so the number only goes up.
    expect(Number(puts[1].headers[SAVE_SEQ_HEADER])).toBe(Number(puts[0].headers[SAVE_SEQ_HEADER]) + 1);

    await act(async () => {
      puts[1].succeed();
    });
    await tick();
    expect(ids()).toEqual(['C']);
    expect(serverCopies.a.activeEntryIds).toEqual(['C']);
    expect(ctx!.versionConflictIds).toEqual([]);
    expect(ctx!.error).toBeNull();
  });

  it('three quick edits in one tab never conflict with themselves', async () => {
    await mount();
    for (const next of [['q1'], ['q2'], ['q3']]) {
      await act(async () => {
        await ctx!.updateWorkspace({ activeEntryIds: next });
      });
      await tick(320); // longer than the debounce: each edit would have been its own PUT
    }
    // Answer whatever is in flight until the queue drains.
    for (let guard = 0; guard < 6; guard++) {
      const open = puts.filter(p => !(p as unknown as { answered?: boolean }).answered);
      const next = open[0];
      if (!next) break;
      (next as unknown as { answered?: boolean }).answered = true;
      await act(async () => {
        next.succeed();
      });
      await tick(20);
    }
    expect(ctx!.versionConflictIds).toEqual([]);
    expect(ctx!.error).toBeNull();
    expect(serverCopies.a.activeEntryIds).toEqual(['q3']);
    expect(ids()).toEqual(['q3']);
  });
});

describe('a refused stale save is visible, not silent', () => {
  it('409 STALE_SAVE: notice shown, cache keeps the local data, no banner, no refetch', async () => {
    await mount();
    await edit(['A']); // the one PUT in flight
    expect(puts).toHaveLength(1);
    const readsBefore = getCount;

    await act(async () => {
      puts[0].stale();
    });
    await tick();
    await tick();

    expect(ids()).toEqual(['A']);
    expect(ctx!.error).toBeNull();
    expect(ctx!.versionConflictIds).toEqual([]);
    expect(getCount).toBe(readsBefore);
    const info = notices.filter(n => n.kind === 'info');
    expect(info).toHaveLength(1);
    expect(info[0].message).toMatch(/older save/i);
    expect(notices.filter(n => n.kind === 'error')).toHaveLength(0);
  });

  it('a stale refusal does not eat a change still waiting to be sent', async () => {
    await mount();
    await edit(['A']); // in flight
    // C is queued behind A's PUT when A's refusal arrives.
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['C'] });
    });
    await act(async () => {
      puts[0].stale();
    });
    await tick();
    expect(ids()).toEqual(['C']);
    await waitForDebounce();
    await tick();
    expect(puts).toHaveLength(2);
    expect(puts[1].patch.activeEntryIds).toEqual(['C']);
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

describe('a version conflict pauses the workspace and keeps the edits until Reload', () => {
  it('a save refused after a restore: banner state, edits kept, autosave paused, no refetch, Reload discards', async () => {
    await mount();
    expect(puts).toHaveLength(0);
    // A restore from backup (or another tab's save) moved the server on while this tab sat open.
    serverCopies.a = { ...makeWorkspace('a', ['restored']), version: 5 } as unknown as Workspace;
    const readsBefore = getCount;

    await edit(['mine']);
    expect(puts).toHaveLength(1);
    expect(puts[0].headers[EXPECTED_VERSION_HEADER]).toBe('1');
    await act(async () => {
      puts[0].succeed(); // the mock server compares 1 with 5 and answers 409 VERSION_CONFLICT
    });
    await tick();
    await tick();

    expect(ctx!.versionConflictIds).toEqual(['a']);
    expect(ids()).toEqual(['mine']); // the user's edit is still on screen
    expect(serverCopies.a.activeEntryIds).toEqual(['restored']); // nothing was written
    expect(getCount).toBe(readsBefore); // no refetch, so the edit was not replaced
    expect(ctx!.error).toBeNull();

    // Autosave stays paused: more typing is kept but never sent.
    await edit(['mine-2']);
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    expect(ids()).toEqual(['mine-2']);

    // Reload is the only way out, and it discards the unsaved edits.
    await act(async () => {
      await ctx!.reloadWorkspace('a');
    });
    await tick();
    expect(getCount).toBe(readsBefore + 1);
    expect(ctx!.versionConflictIds).toEqual([]);
    expect(ids()).toEqual(['restored']);

    // Saving works again, against the version Reload fetched.
    await edit(['after-reload']);
    expect(puts).toHaveLength(2);
    expect(puts[1].headers[EXPECTED_VERSION_HEADER]).toBe('5');
  });

  it('a list refetch never advances the version under an unsent edit', async () => {
    await mount();
    // The edit is typed but the debounce has not fired yet.
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['mine'] });
    });
    // Meanwhile another tab saved (server is at 7) and this tab's list is re-read.
    serverCopies.a = { ...makeWorkspace('a', ['theirs']), version: 7 } as unknown as Workspace;
    await act(async () => {
      await ctx!.refreshWorkspaces();
    });
    await tick(); // react-query notifies observers on a timer; let that render land
    expect(ids()).toEqual(['mine']); // the unsent edit is still what is shown, not the server copy
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    // It must still ask about the version this tab's edit was made against, so the server can refuse it.
    expect(puts[0].headers[EXPECTED_VERSION_HEADER]).toBe('1');
    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    expect(ctx!.versionConflictIds).toEqual(['a']);
    expect(serverCopies.a.activeEntryIds).toEqual(['theirs']);
  });

  it('a list refetch under the banner keeps the edits on screen and the conflict up', async () => {
    await mount();
    serverCopies.a = { ...makeWorkspace('a', ['theirs']), version: 6 } as unknown as Workspace;
    await edit(['mine']);
    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    expect(ctx!.versionConflictIds).toEqual(['a']);
    await edit(['mine-2']); // typed after the refusal, never sent

    // A snapshot restore elsewhere in the UI, or a failed save of another workspace, re-reads the list.
    await act(async () => {
      await ctx!.refreshWorkspaces();
    });
    await tick();
    expect(ids()).toEqual(['mine-2']);
    expect(ctx!.versionConflictIds).toEqual(['a']);
    expect(puts).toHaveLength(1);
    expect(serverCopies.a.activeEntryIds).toEqual(['theirs']);

    // Only Reload swaps in the server copy.
    await act(async () => {
      await ctx!.reloadWorkspace('a');
    });
    await tick();
    expect(ids()).toEqual(['theirs']);
    expect(ctx!.versionConflictIds).toEqual([]);
  });

  it('Reload takes the version the server now has, even when it is lower than the one this tab held', async () => {
    // The data directory was swapped for an older copy: the server's version went DOWN.
    serverCopies.a = { ...makeWorkspace('a', ['pre']), version: 9 } as unknown as Workspace;
    await mount();
    serverCopies.a = { ...makeWorkspace('a', ['older-copy']), version: 4 } as unknown as Workspace;
    await edit(['mine']);
    expect(puts[0].headers[EXPECTED_VERSION_HEADER]).toBe('9');
    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    expect(ctx!.versionConflictIds).toEqual(['a']);

    await act(async () => {
      await ctx!.reloadWorkspace('a');
    });
    await tick();
    expect(ctx!.versionConflictIds).toEqual([]);
    expect(ids()).toEqual(['older-copy']);

    // A "raise only" rule would keep asking for 9 and be refused forever.
    await edit(['after-reload']);
    expect(puts).toHaveLength(2);
    expect(puts[1].headers[EXPECTED_VERSION_HEADER]).toBe('4');
    await act(async () => {
      puts[1].succeed();
    });
    await tick();
    expect(ctx!.versionConflictIds).toEqual([]);
    expect(serverCopies.a.activeEntryIds).toEqual(['after-reload']);
  });

  it('a failed Reload keeps the conflict and the edits', async () => {
    await mount();
    serverCopies.a = { ...makeWorkspace('a', ['restored']), version: 3 } as unknown as Workspace;
    await edit(['mine']);
    await act(async () => {
      puts[0].succeed();
    });
    await tick();
    expect(ctx!.versionConflictIds).toEqual(['a']);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse(500, { error: 'down' })) as typeof fetch;
    await act(async () => {
      await ctx!.reloadWorkspace('a');
    });
    await tick();
    globalThis.fetch = realFetch;
    expect(ctx!.versionConflictIds).toEqual(['a']);
    expect(ids()).toEqual(['mine']);
  });
});

describe('saveWorkspace: the caller sees what became of its edit (P4)', () => {
  /** Queue an edit through `saveWorkspace` without awaiting it; the result is read later. */
  async function save(entryIds: string[]): Promise<{ result: () => Promise<WorkspaceSaveResult>; settled: () => boolean }> {
    let value: WorkspaceSaveResult | null = null;
    let promise!: Promise<WorkspaceSaveResult>;
    await act(async () => {
      promise = ctx!.saveWorkspace({ activeEntryIds: entryIds });
      void promise.then(v => {
        value = v;
      });
    });
    return { result: () => promise, settled: () => value !== null };
  }

  it('resolves ok with the stored copy once the PUT succeeds, and not before', async () => {
    await mount();
    const s = await save(['mine']);
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    expect(s.settled()).toBe(false); // the PUT has not answered yet
    await act(async () => {
      puts[0].succeed();
    });
    const result = await s.result();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace.activeEntryIds).toEqual(['mine']);
      expect((result.workspace as unknown as { version: number }).version).toBe(2);
    }
  });

  it('a failed save resolves { ok: false, reason: "error" } with the reason, and still notifies', async () => {
    await mount();
    const s = await save(['mine']);
    await waitForDebounce();
    await act(async () => {
      puts[0].fail();
    });
    const result = await s.result();
    expect(result).toEqual({ ok: false, reason: 'error', message: 'boom' });
    expect(notices.some(n => n.kind === 'error' && n.message === 'boom')).toBe(true);
  });

  it('a version conflict resolves "conflict", is not a generic error, and does not raise the error banner', async () => {
    await mount();
    serverCopies.a = { ...makeWorkspace('a', ['theirs']), version: 4 } as unknown as Workspace;
    const s = await save(['mine']);
    await waitForDebounce();
    await act(async () => {
      puts[0].succeed(); // the mock server answers 409 VERSION_CONFLICT
    });
    const result = await s.result();
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(ctx!.versionConflictIds).toEqual(['a']);
    expect(ctx!.error).toBeNull();
    expect(notices.filter(n => n.kind === 'error')).toEqual([]);
  });

  it('an edit made while the workspace is paused on a conflict resolves "conflict" at once and sends nothing', async () => {
    await mount();
    serverCopies.a = { ...makeWorkspace('a', ['theirs']), version: 4 } as unknown as Workspace;
    const first = await save(['mine']);
    await waitForDebounce();
    await act(async () => {
      puts[0].succeed();
    });
    await first.result();

    const second = await save(['mine-2']);
    expect(second.settled()).toBe(true);
    expect(await second.result()).toMatchObject({ ok: false, reason: 'conflict' });
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    expect(ids()).toEqual(['mine-2']); // still on screen
  });

  it('an edit queued behind a refused one resolves "conflict" too, instead of waiting for a Reload', async () => {
    await mount();
    serverCopies.a = { ...makeWorkspace('a', ['theirs']), version: 4 } as unknown as Workspace;
    const first = await save(['one']);
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    const behind = await save(['two']); // queued while the first PUT is in flight
    await act(async () => {
      puts[0].succeed(); // 409 VERSION_CONFLICT
    });
    expect(await first.result()).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await behind.result()).toMatchObject({ ok: false, reason: 'conflict' });
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    expect(ids()).toEqual(['two']);
  });

  it('edits merged into one request all resolve with that request', async () => {
    await mount();
    const a = await save(['one']);
    const b = await save(['two']);
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    await act(async () => {
      puts[0].succeed();
    });
    const [ra, rb] = await Promise.all([a.result(), b.result()]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(serverCopies.a.activeEntryIds).toEqual(['two']);
  });

  it('an edit behind one in flight resolves with its own request, not the first', async () => {
    await mount();
    const first = await save(['one']);
    await waitForDebounce();
    expect(puts).toHaveLength(1);
    const second = await save(['two']);
    await act(async () => {
      puts[0].succeed();
    });
    expect((await first.result()).ok).toBe(true);
    expect(second.settled()).toBe(false); // waits for its own PUT
    await waitForDebounce();
    expect(puts).toHaveLength(2);
    await act(async () => {
      puts[1].fail();
    });
    expect(await second.result()).toMatchObject({ ok: false, reason: 'error' });
  });

  it('Reload resolves a queued edit as "discarded" instead of leaving the caller waiting', async () => {
    await mount();
    const s = await save(['mine']); // debounce has not fired
    await act(async () => {
      await ctx!.reloadWorkspace('a');
    });
    expect(await s.result()).toMatchObject({ ok: false, reason: 'discarded' });
    await waitForDebounce();
    expect(puts).toHaveLength(0);
  });

  it('updateWorkspace still resolves before the PUT runs', async () => {
    await mount();
    let done = false;
    await act(async () => {
      await ctx!.updateWorkspace({ activeEntryIds: ['mine'] }).then(() => {
        done = true;
      });
    });
    expect(done).toBe(true);
    expect(puts).toHaveLength(0);
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
