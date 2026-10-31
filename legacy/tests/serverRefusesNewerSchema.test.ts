/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P7, server half: a database stamped by a newer build stops the server.
 *
 * `server.ts` used to catch ANY SqliteRepo failure and fall back to `meets.json`,
 * so the schema refusal in `packages/db` turned into a silent switch to an older,
 * separate copy of the data. This runs the real server as a child process on an
 * ephemeral port against a throwaway data directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { promises as fsp, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaVersionError } from '../packages/db/src/schemaGuard';
import { decideSqliteStartupFailure } from '../apps/shell/lib/sqliteStartup';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('decideSqliteStartupFailure', () => {
  it('stops for a newer or unreadable schema, with the guard message', () => {
    const newer = new SchemaVersionError('SCHEMA_TOO_NEW', '99', 8, 'x.db');
    const d = decideSqliteStartupFailure(newer);
    expect(d.action).toBe('exit');
    // The guard's own message, verbatim: not the generic wrapper that blames a corrupt file.
    expect(d.message).toBe(newer.message);
    expect(d.message).toMatch(/newer build/);

    const unreadable = new SchemaVersionError('SCHEMA_VERSION_UNREADABLE', 'eight', 8, 'x.db');
    expect(decideSqliteStartupFailure(unreadable).action).toBe('exit');
  });

  it('falls back to JSON only when SQLite itself cannot load', () => {
    for (const code of ['ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_DLOPEN_FAILED', 'ERR_MODULE_NOT_FOUND']) {
      const err = Object.assign(new Error('cannot load sqlite'), { code });
      const d = decideSqliteStartupFailure(err);
      expect(d.action, code).toBe('fallback-to-json');
      expect(d.message).toMatch(/meets\.json/);
    }
  });

  it('stops for every other failure instead of serving a different copy of the data', () => {
    for (const err of [new Error('file is not a database'), new Error('database is locked'), 'weird']) {
      expect(decideSqliteStartupFailure(err).action).toBe('exit');
    }
  });
});

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-newer-schema-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe('the server process', () => {
  it('exits non-zero with the schema message, and does not fall back to meets.json', async () => {
    const dbPath = path.join(dir, 'omniswim.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', '99');
    db.close();

    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('legacy', 'apps', 'shell', 'server.ts')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OMNI_DATA_DIR: dir,
        OMNI_DB: 'sqlite',
        PORT: String(port),
        OMNI_PORT: String(port),
        OMNI_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => (log += d.toString()));
    child.stderr.on('data', d => (log += d.toString()));

    const code = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 150_000);
      child.once('exit', c => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    expect(code, `server did not exit on its own. Log:\n${log}`).not.toBeNull();
    expect(code, `server exited 0. Log:\n${log}`).not.toBe(0);
    expect(log).toMatch(/newer build/);
    expect(log).toMatch(/schema version 99/);
    expect(log).not.toMatch(/falling back to (data\/)?meets\.json|Storage backend: JSON/);
    // The fallback would have created and seeded a JSON store next to the database.
    expect(existsSync(path.join(dir, 'meets.json'))).toBe(false);

    // And the refusal left the database alone.
    const after = new DatabaseSync(dbPath);
    const row = after.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    after.close();
    expect(row.value).toBe('99');
  }, 180_000);
});
