/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * X1: the shell's two backup calls behind the error boundary. The list is newest
 * first; a 403 ADMIN_REQUIRED keeps its status and code so the fallback can say
 * an administrator must restore.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackupRequestError,
  findLastBackup,
  restoreBackupFile,
} from '../apps/shell/src/lib/restoreLastBackup';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('restoreLastBackup', () => {
  it('returns the first backup of the list, which the server sorts newest first', async () => {
    const list = [
      { file: 'meets-manual-20261012T150000Z.json', bytes: 10, writtenAt: '2026-10-12T15:00:00.000Z', label: 'manual' },
      { file: 'meets-startup-20261001T080000Z.json', bytes: 9, writtenAt: '2026-10-01T08:00:00.000Z', label: 'startup' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, list)));
    expect((await findLastBackup())?.file).toBe('meets-manual-20261012T150000Z.json');
  });

  it('returns null for an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, [])));
    expect(await findLastBackup()).toBeNull();
  });

  it('keeps status and code from a 403 ADMIN_REQUIRED on the list call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(403, { error: 'Backups are limited to administrators.', code: 'ADMIN_REQUIRED' }))
    );
    const err = await findLastBackup().catch(e => e);
    expect(err).toBeInstanceOf(BackupRequestError);
    expect(err).toMatchObject({ status: 403, code: 'ADMIN_REQUIRED' });
  });

  it('posts the file name to the restore endpoint and keeps the code on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(403, { error: 'No.', code: 'ADMIN_REQUIRED' }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await restoreBackupFile('meets-manual-a.json').catch(e => e);
    expect(err).toMatchObject({ status: 403, code: 'ADMIN_REQUIRED' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/workspaces/restore');
    expect(JSON.parse(init.body)).toEqual({ file: 'meets-manual-a.json' });
  });
});
