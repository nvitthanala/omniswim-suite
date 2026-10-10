import type { Workspace } from '../types';
import {
  SAVE_CLIENT_HEADER,
  SAVE_SEQ_HEADER,
  STALE_SAVE_CODE,
  type SaveToken,
} from './saveSequence';

const API_BASE = '';

/**
 * A failed request must never be indistinguishable from a successful one.
 *
 * `fetchWorkspaces` used to coerce any non-array body (i.e. every error
 * response) into `[]`, so a server hiccup made the query *succeed* with an
 * empty list: the sidebar blanked, the provider dropped the active selection,
 * and the next successful read re-picked `workspaces[0]` rather than the
 * workspace the user had chosen. `deleteWorkspaceApi` had the mirror-image
 * problem — it reported a rejected DELETE as a success, so the client removed a
 * workspace the server still held and the next read resurrected it.
 *
 * Absent is not empty. Every helper below raises on a non-OK response.
 */
async function raise(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  const message = typeof body.error === 'string' ? body.error : `${fallback} (${res.status})`;
  throw new Error(message);
}

/** Narrow an arbitrary JSON body to a Workspace, or raise. */
function asWorkspace(data: unknown, fallback: string): Workspace {
  if (!data || typeof data !== 'object' || typeof (data as Workspace).id !== 'string') {
    throw new Error(`${fallback} (malformed response)`);
  }
  return data as Workspace;
}

export async function fetchWorkspaces(): Promise<Workspace[]> {
  const res = await fetch(`${API_BASE}/api/workspaces`);
  if (!res.ok) await raise(res, 'Failed to load workspaces');
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('Failed to load workspaces (malformed response)');
  }
  return data as Workspace[];
}

export async function createWorkspace(name: string, body?: Partial<Workspace>): Promise<Workspace> {
  const res = await fetch(`${API_BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(body ?? {}) }),
  });
  if (!res.ok) await raise(res, 'Failed to create workspace');
  return asWorkspace(await res.json(), 'Failed to create workspace');
}

/**
 * The server refused a save because a newer save from this client was already
 * applied. The stored data is the newer one, so nothing is lost; the caller
 * must still tell the user rather than drop the refusal.
 */
export class StaleSaveError extends Error {
  readonly code = STALE_SAVE_CODE;
  constructor(
    message: string,
    readonly lastAppliedSeq?: number,
    readonly receivedSeq?: number
  ) {
    super(message);
    this.name = 'StaleSaveError';
  }
}

/**
 * Save a workspace patch. Pass `token` to let the server detect a save that
 * arrives after a newer one; without it the save still works but cannot be
 * checked (the server flags it).
 */
export async function updateWorkspaceApi(
  id: string,
  patch: Partial<Workspace>,
  token?: SaveToken
): Promise<Workspace> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers[SAVE_CLIENT_HEADER] = token.clientId;
    headers[SAVE_SEQ_HEADER] = String(token.seq);
  }
  const res = await fetch(`${API_BASE}/api/workspaces/${id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 409 && err.code === STALE_SAVE_CODE) {
      throw new StaleSaveError(
        err.error || 'A newer save was already applied.',
        typeof err.lastAppliedSeq === 'number' ? err.lastAppliedSeq : undefined,
        typeof err.receivedSeq === 'number' ? err.receivedSeq : undefined
      );
    }
    throw new Error(err.error || `Failed to update workspace (${res.status})`);
  }
  return res.json();
}

/**
 * Take a manual, on-demand backup of every workspace, before a caller runs a
 * change that can delete rows a coach cannot get back any other way (e.g. a
 * SwimCloud replace reimport). Same route the server takes at startup and
 * before a pre-shrink or pre-delete write; `'manual'` is this call's own
 * reason label. Throws on a non-OK response — a caller must never run a
 * destructive change believing an unwritten backup exists.
 */
export async function backupWorkspaces(): Promise<{ file: string }> {
  const res = await fetch(`${API_BASE}/api/workspaces/backup`, { method: 'POST' });
  if (!res.ok) await raise(res, 'Failed to back up workspaces');
  const data = (await res.json()) as { file?: string };
  if (typeof data.file !== 'string') {
    throw new Error('Failed to back up workspaces (malformed response)');
  }
  return { file: data.file };
}

export async function deleteWorkspaceApi(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/workspaces/${id}`, { method: 'DELETE' });
  if (!res.ok) await raise(res, 'Failed to delete workspace');
}
