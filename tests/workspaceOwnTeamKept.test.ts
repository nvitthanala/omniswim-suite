// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * E11: the own team lives in the workspace settings object, and several saves replace that whole
 * object (a preset load, the rules dialog). The provider carries the team across such a save, so
 * changing a scoring rule cannot unset it. Only an explicit blank clears it.
 *
 * Drives the real provider against a fake fetch, as workspaceSaveSequencing.test.ts does.
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
import type { ScoringSettings, Workspace } from '@omniswim/core/types';
import { DEFAULT_SCORING_SETTINGS } from '@omniswim/core/lib/scoringDefaults';
import { withOwnTeam, workspaceOwnTeam } from '@omniswim/core/lib/ownTeam';
import { workspaceFixture } from './helpers/typedFixtures';

type Ctx = ReturnType<typeof useSuiteWorkspace>;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeWorkspace(id: string, settings: Partial<ScoringSettings>): Workspace {
  return workspaceFixture({
    id,
    name: id,
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    createdAt: 1,
    scoringSettings: { ...DEFAULT_SCORING_SETTINGS, ...settings },
  });
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

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/api/workspaces') && method === 'GET') {
      return jsonResponse(200, Object.values(serverCopies));
    }
    const put = /\/api\/workspaces\/([^/]+)$/.exec(url);
    if (put && method === 'PUT') {
      const id = put[1]!;
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
  // Wait for the list to land and a workspace to be selected; two bare ticks drop the first edit on a busy machine.
  for (let i = 0; i < 200 && !ctx?.activeWorkspace; i += 1) await tick(10);
  expect(ctx?.activeWorkspace, 'the workspace list loaded').toBeTruthy();
  await tick();
}

const settingsOnServer = () => serverCopies.a!.scoringSettings!;
const waitForDebounce = () => tick(380);

beforeEach(() => {
  window.localStorage.clear();
  ctx = null;
  puts = [];
  serverCopies = { a: makeWorkspace('a', { ownTeam: 'Alpha U' }) };
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

async function save(patch: Partial<Workspace>) {
  await act(async () => {
    await ctx!.updateWorkspace(patch);
  });
  await waitForDebounce();
  expect(puts.length).toBeGreaterThan(0);
  await act(async () => {
    puts[puts.length - 1]!.succeed();
  });
  await tick();
}

describe('a save that replaces the settings object keeps the own team', () => {
  it('a preset or dialog save with no ownTeam key: the team stays, in the cache and on the wire', async () => {
    await mount();
    expect(workspaceOwnTeam(ctx!.activeWorkspace)).toBe('Alpha U');

    const { ownTeam: _dropped, ...presetLike } = { ...DEFAULT_SCORING_SETTINGS, relayMultiplier: 3, ownTeam: '' };
    await save({ scoringSettings: presetLike });

    expect(puts[0]!.patch.scoringSettings!.ownTeam).toBe('Alpha U');
    expect(puts[0]!.patch.scoringSettings!.relayMultiplier).toBe(3);
    expect(workspaceOwnTeam(ctx!.activeWorkspace)).toBe('Alpha U');
    expect(ctx!.activeWorkspace!.scoringSettings!.relayMultiplier).toBe(3);
    expect(settingsOnServer().ownTeam).toBe('Alpha U');
  });

  it('an explicit change wins: setting another team, then clearing with a blank', async () => {
    await mount();
    await save({ scoringSettings: withOwnTeam(ctx!.activeWorkspace!.scoringSettings, 'Beta U') });
    expect(workspaceOwnTeam(ctx!.activeWorkspace)).toBe('Beta U');
    expect(settingsOnServer().ownTeam).toBe('Beta U');

    await save({ scoringSettings: withOwnTeam(ctx!.activeWorkspace!.scoringSettings, null) });
    expect(workspaceOwnTeam(ctx!.activeWorkspace)).toBeNull();
    expect(settingsOnServer().ownTeam).toBe('');
  });

  it('a save that does not touch the settings sends no settings', async () => {
    await mount();
    await save({ name: 'Renamed' });
    expect('scoringSettings' in puts[0]!.patch).toBe(false);
    expect(workspaceOwnTeam(ctx!.activeWorkspace)).toBe('Alpha U');
  });

  it('a workspace with no own team gains none from a rules save', async () => {
    serverCopies = { a: makeWorkspace('a', {}) };
    await mount();
    await save({ scoringSettings: { ...DEFAULT_SCORING_SETTINGS, relayMultiplier: 2 } });
    expect('ownTeam' in puts[0]!.patch.scoringSettings!).toBe(false);
    expect(workspaceOwnTeam(ctx!.activeWorkspace)).toBeNull();
  });
});
