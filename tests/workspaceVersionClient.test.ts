/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P3 client API: `updateWorkspaceApi` sends the expected version only through its
 * header, never in the body, and turns a 409 VERSION_CONFLICT into a typed error.
 * (The provider does not use this yet; see the report for the two open decisions.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  updateWorkspaceApi,
  VersionConflictError,
  StaleSaveError,
  workspaceVersion,
} from '../packages/core/src/api/workspaces';
import { EXPECTED_VERSION_HEADER, STALE_SAVE_CODE, VERSION_CONFLICT_CODE } from '../packages/core/src/api/saveSequence';
import type { Workspace } from '../packages/core/src/types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function reply(status: number, body: unknown) {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

describe('updateWorkspaceApi expected version', () => {
  it('sends the version in the header and never in the body', async () => {
    let seen: { headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(String(init?.body)),
      };
      return reply(200, { id: 'a', version: 4 });
    }) as typeof fetch;

    // A whole workspace spread into a patch carries `version`; it must not become the body's.
    const patch = { name: 'n', version: 2 } as unknown as Partial<Workspace>;
    await updateWorkspaceApi('a', patch, undefined, 3);
    expect(seen!.headers[EXPECTED_VERSION_HEADER]).toBe('3');
    expect(seen!.body).toEqual({ name: 'n' });
  });

  it('sends no header when no version is given (last writer wins, as before)', async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      headers = { ...(init?.headers as Record<string, string>) };
      return reply(200, { id: 'a' });
    }) as typeof fetch;
    await updateWorkspaceApi('a', { name: 'n' });
    expect(headers).not.toHaveProperty(EXPECTED_VERSION_HEADER);
  });

  it('turns 409 VERSION_CONFLICT into VersionConflictError, distinct from a stale-order refusal', async () => {
    globalThis.fetch = (async () =>
      reply(409, { error: 'Version conflict', code: VERSION_CONFLICT_CODE })) as typeof fetch;
    const conflict = await updateWorkspaceApi('a', {}, undefined, 1).catch(e => e);
    expect(conflict).toBeInstanceOf(VersionConflictError);
    expect(conflict).not.toBeInstanceOf(StaleSaveError);

    globalThis.fetch = (async () => reply(409, { error: 'old', code: STALE_SAVE_CODE })) as typeof fetch;
    const stale = await updateWorkspaceApi('a', {}, { clientId: 'client-aaaaaaaa', seq: 1 }).catch(e => e);
    expect(stale).toBeInstanceOf(StaleSaveError);
    expect(stale).not.toBeInstanceOf(VersionConflictError);
  });

  it('workspaceVersion reads a positive integer and nothing else', () => {
    expect(workspaceVersion({ version: 3 } as unknown as Workspace)).toBe(3);
    for (const bad of [undefined, null, {}, { version: 0 }, { version: 1.5 }, { version: '2' }]) {
      expect(workspaceVersion(bad as unknown as Workspace)).toBeUndefined();
    }
  });
});
