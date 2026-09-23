/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client-side half of the `PUT /api/workspaces/:id` data-loss guard
 * (see `apps/shell/lib/dataLossGuard.ts` for the server-side detection).
 *
 * On 2026-09-22 a workspace's men's results went from 550 to 0 between two
 * saves and nobody was told, even though a backup existed on disk the whole
 * time. The server now takes a `pre-shrink` backup and reports a
 * `dataLossWarning` on the PUT response when a save sharply shrinks
 * menResults/womenResults/athleteHistory. This module is what makes that
 * warning visible.
 *
 * ## Why this patches `fetch` instead of wiring through the provider
 *
 * `SuiteWorkspaceProvider` (packages/core) is what actually issues the PUT
 * and already has an `onNotify` sink wired to this app's toasts. It would be
 * the natural place to read `dataLossWarning` off the response — except:
 *
 *   1. `onNotify` is typed `(kind, message) => void`; it has no channel for a
 *      backup filename or an inline "Restore" action.
 *   2. `packages/core` is out of scope for this change (another agent is
 *      editing it concurrently) and the fix must be additive, not a rewire
 *      of the mutation's `onSuccess` path.
 *
 * Patching `fetch` observes the exact same HTTP response the provider reads,
 * without touching how the provider consumes it — additive at the network
 * layer instead of the component layer. It targets one URL shape
 * (`PUT /api/workspaces/:id`) and fails silently on anything it can't parse,
 * so it can never turn a real save into a broken one.
 */
import type { ToastKind, ToastOptions } from '@omniswim/ui';

type Notify = (kind: ToastKind, message: string, options?: ToastOptions) => string;

/** Matches `/api/workspaces/<id>` but not `/api/workspaces`, `/backup(s)`, `/restore`, or `/:id/snapshots`. */
const WORKSPACE_BY_ID_RE = /\/api\/workspaces\/[^/?]+(?:[?#]|$)/;
const RESERVED_SUFFIXES = new Set(['backup', 'backups', 'restore']);

interface DataLossDrop {
  collection: string;
  from: number;
  to: number;
}

interface DataLossWarning {
  drops: DataLossDrop[];
  backupFile: string | null;
  backupError?: string;
}

const COLLECTION_LABELS: Record<string, string> = {
  menResults: "Men's results",
  womenResults: "Women's results",
  athleteHistory: 'Athlete history',
};

function collectionLabel(collection: string): string {
  return COLLECTION_LABELS[collection] ?? collection;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

function isWorkspaceByIdPut(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (requestMethod(input, init) !== 'PUT') return false;
  const url = requestUrl(input);
  const match = WORKSPACE_BY_ID_RE.exec(url);
  if (!match) return false;
  const id = match[0].replace(/^\/api\/workspaces\//, '').replace(/[?#].*$/, '');
  return !RESERVED_SUFFIXES.has(id);
}

async function restoreBackup(file: string): Promise<void> {
  const res = await fetch('/api/workspaces/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error || `Restore failed (${res.status})`);
  }
}

function warningMessage(warning: DataLossWarning): string {
  const parts = warning.drops.map(
    d => `${collectionLabel(d.collection)} dropped from ${d.from} to ${d.to}`
  );
  if (warning.backupFile) {
    return `${parts.join('; ')}. A backup was saved before this change: ${warning.backupFile}.`;
  }
  const reason = warning.backupError ? ` (${warning.backupError})` : '';
  return `${parts.join('; ')}. The backup could not be saved${reason} — check disk space.`;
}

function handleWarning(notify: Notify, warning: DataLossWarning): void {
  const backupFile = warning.backupFile;
  notify('error', warningMessage(warning), {
    persistent: true,
    action: backupFile
      ? {
          label: 'Restore',
          onClick: () => {
            const confirmed = window.confirm(
              `Restore ${backupFile}? This replaces every workspace with the contents of that backup.`
            );
            if (!confirmed) return;
            restoreBackup(backupFile)
              .then(() => {
                notify('success', `Restored from ${backupFile}. Reloading…`);
                window.location.reload();
              })
              .catch(err => {
                notify('error', err instanceof Error ? err.message : 'Restore failed');
              });
          },
        }
      : undefined,
  });
}

let installed = false;

/**
 * Install the fetch watcher once per page load. Idempotent — safe to call
 * from a component that can re-render or remount (e.g. React StrictMode).
 */
export function installDataLossWatcher(notify: Notify): void {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    try {
      if (response.ok && isWorkspaceByIdPut(input, init)) {
        const body = (await response.clone().json().catch(() => null)) as
          | { dataLossWarning?: DataLossWarning }
          | null;
        const warning = body?.dataLossWarning;
        if (warning && Array.isArray(warning.drops) && warning.drops.length > 0) {
          handleWarning(notify, warning);
        }
      }
    } catch {
      // Never let inspecting the response break the save it already completed.
    }
    return response;
  };
}
