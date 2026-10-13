/**
 * The two server calls behind the error boundary's "Restore last backup" button.
 *
 * `GET /api/workspaces/backups` lists backups newest first (the server sorts on the
 * time parsed from the file name). `POST /api/workspaces/restore` replaces every
 * workspace with one file and takes its own `pre-restore` backup first. The same
 * endpoint backs the Restore action in `dataLossWatcher.ts`.
 *
 * Under AUTH_REQUIRED both calls answer 403 `ADMIN_REQUIRED` to a non-administrator.
 * The thrown error keeps `status` and `code` so the fallback can say so.
 */
import type { BackupChoice, BackupRestoreActions } from '@omniswim/ui';

export class BackupRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'BackupRequestError';
    this.status = status;
    this.code = code;
  }
}

async function requestError(res: Response, fallback: string): Promise<BackupRequestError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  const message = typeof body.error === 'string' && body.error ? body.error : fallback;
  const code = typeof body.code === 'string' ? body.code : null;
  return new BackupRequestError(message, res.status, code);
}

export async function findLastBackup(): Promise<BackupChoice | null> {
  const res = await fetch('/api/workspaces/backups');
  if (!res.ok) throw await requestError(res, `Could not list backups (${res.status}).`);
  const list = (await res.json()) as BackupChoice[];
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

export async function restoreBackupFile(file: string): Promise<void> {
  const res = await fetch('/api/workspaces/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  if (!res.ok) throw await requestError(res, `Restore failed (${res.status}).`);
}

export const lastBackupActions: BackupRestoreActions = {
  findLast: findLastBackup,
  restore: restoreBackupFile,
};
