import type { Workspace } from '../types';

const API_BASE = '';

export async function fetchWorkspaces(): Promise<Workspace[]> {
  const res = await fetch(`${API_BASE}/api/workspaces`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function createWorkspace(name: string, body?: Partial<Workspace>): Promise<Workspace> {
  const res = await fetch(`${API_BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(body ?? {}) }),
  });
  return res.json();
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
  await fetch(`${API_BASE}/api/workspaces/${id}`, { method: 'DELETE' });
}
