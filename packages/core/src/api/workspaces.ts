import type { Workspace } from '../types';
import {
  EXPECTED_VERSION_HEADER,
  SAVE_CLIENT_HEADER,
  SAVE_SEQ_HEADER,
  STALE_SAVE_CODE,
  VERSION_CONFLICT_CODE,
  type SaveToken,
} from './saveSequence';

/**
 * A workspace as the server returns it: `version` is the stored revision. The
 * server owns it; send it back as `expectedVersion` on a save to be refused
 * (409 `VERSION_CONFLICT`) when somebody else changed the workspace since.
 * `Workspace` itself has no `version` field, so this is the type to read it from.
 */
export type VersionedWorkspace = Workspace & { version?: number };

/** The version a workspace came back with, or undefined when the server sent none. */
export function workspaceVersion(ws: Workspace | undefined | null): number | undefined {
  const v = (ws as VersionedWorkspace | undefined | null)?.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;
}

/**
 * The server refused a save because the stored workspace is no longer the version
 * this client last saw (another tab, another user, a script). Nothing was written.
 * The caller must refetch and tell the user; it must not retry blindly, because a
 * retry with the same version would be refused again and a retry without one would
 * overwrite the other change.
 */
export class VersionConflictError extends Error {
  readonly code = VERSION_CONFLICT_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'VersionConflictError';
  }
}

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
 * A `version` riding along in a patch (a whole workspace spread into one) would be read
 * by the server as the expected version. The header is the only way to ask for that check.
 */
function withoutVersion(patch: Partial<Workspace>): Partial<Workspace> {
  if (!('version' in patch)) return patch;
  const { version: _version, ...rest } = patch as Partial<Workspace> & { version?: unknown };
  return rest;
}

/**
 * Save a workspace patch. Pass `token` to let the server detect a save that
 * arrives after a newer one; without it the save still works but cannot be
 * checked (the server flags it). Pass `expectedVersion` (the `version` of the
 * workspace this patch was made against) to be refused with
 * {@link VersionConflictError} when the stored copy has moved on; without it the
 * save is last-writer-wins, as before.
 */
export async function updateWorkspaceApi(
  id: string,
  patch: Partial<Workspace>,
  token?: SaveToken,
  expectedVersion?: number
): Promise<VersionedWorkspace> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers[SAVE_CLIENT_HEADER] = token.clientId;
    headers[SAVE_SEQ_HEADER] = String(token.seq);
  }
  if (expectedVersion !== undefined) headers[EXPECTED_VERSION_HEADER] = String(expectedVersion);
  const res = await fetch(`${API_BASE}/api/workspaces/${id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(withoutVersion(patch)),
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
    if (res.status === 409 && err.code === VERSION_CONFLICT_CODE) {
      throw new VersionConflictError(err.error || 'This workspace changed somewhere else.');
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
