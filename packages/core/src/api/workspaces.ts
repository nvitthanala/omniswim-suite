import type { Workspace } from '../types';

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

export async function updateWorkspaceApi(id: string, patch: Partial<Workspace>): Promise<Workspace> {
  const res = await fetch(`${API_BASE}/api/workspaces/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update workspace (${res.status})`);
  }
  return res.json();
}

export async function deleteWorkspaceApi(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/workspaces/${id}`, { method: 'DELETE' });
  if (!res.ok) await raise(res, 'Failed to delete workspace');
}
