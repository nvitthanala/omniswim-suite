/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client API functions for workspace snapshots (SQLite backend).
 */

import type { Workspace } from '../types';

export type Snapshot = {
  id: string;
  workspaceId: string;
  label: string;
  createdAt: number;
};

const API_BASE = '';

export async function createSnapshot(workspaceId: string, label: string): Promise<Snapshot> {
  const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as Record<string, unknown>).error as string || `Snapshot create failed (${res.status})`);
  }
  return res.json() as Promise<Snapshot>;
}

export async function listSnapshots(workspaceId: string): Promise<Snapshot[]> {
  const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/snapshots`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? (data as Snapshot[]) : [];
}

export async function restoreSnapshot(snapshotId: string): Promise<Workspace> {
  const res = await fetch(`${API_BASE}/api/snapshots/${encodeURIComponent(snapshotId)}/restore`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as Record<string, unknown>).error as string || `Snapshot restore failed (${res.status})`);
  }
  return res.json() as Promise<Workspace>;
}