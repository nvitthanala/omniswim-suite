/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P7: a build refuses a database stamped with a newer schema version, and the
 * refusal leaves the file untouched (the old behaviour re-stamped it back down).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../packages/db/src/WorkspaceService';
import { SCHEMA_VERSION } from '../packages/db/src/schema';
import {
  SchemaVersionError,
  SCHEMA_TOO_NEW_CODE,
  SCHEMA_UNREADABLE_CODE,
  assertSchemaNotNewer,
} from '../packages/db/src/schemaGuard';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-schema-guard-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function stamp(file: string, value: string | null) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  if (value !== null) db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('schema_version', value);
  db.close();
}
function storedVersion(file: string): string | undefined {
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  db.close();
  return row?.value;
}
function tableNames(file: string): string[] {
  const db = new DatabaseSync(file);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  db.close();
  return rows.map(r => r.name);
}

describe('assertSchemaNotNewer', () => {
  it('accepts absent, equal and older; refuses newer and unreadable', () => {
    expect(() => assertSchemaNotNewer(null, 8, 'x')).not.toThrow();
    expect(() => assertSchemaNotNewer(undefined, 8, 'x')).not.toThrow();
    expect(() => assertSchemaNotNewer('8', 8, 'x')).not.toThrow();
    expect(() => assertSchemaNotNewer('3', 8, 'x')).not.toThrow();
    expect(() => assertSchemaNotNewer('9', 8, 'x')).toThrow(SchemaVersionError);
    for (const junk of ['', 'eight', '8.5', '-1', '0', '9 ; DROP']) {
      try {
        assertSchemaNotNewer(junk, 8, 'x');
        throw new Error(`accepted ${JSON.stringify(junk)}`);
      } catch (err) {
        expect((err as SchemaVersionError).code).toBe(SCHEMA_UNREADABLE_CODE);
      }
    }
  });
});

describe('WorkspaceService opening a SQLite file', () => {
  it('refuses a newer schema, leaves the stamp and tables alone, and releases the file', async () => {
    const file = path.join(dir, 'newer.db');
    stamp(file, String(SCHEMA_VERSION + 1));
    const tablesBefore = tableNames(file);

    let caught: unknown;
    try {
      new WorkspaceService(file);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaVersionError);
    expect((caught as SchemaVersionError).code).toBe(SCHEMA_TOO_NEW_CODE);
    expect((caught as Error).message).toMatch(/newer build/);

    expect(storedVersion(file)).toBe(String(SCHEMA_VERSION + 1));
    expect(tableNames(file)).toEqual(tablesBefore);
    // Windows keeps a closed-late handle locked; deleting proves the guard closed it.
    await fsp.rm(file, { force: true });
    await expect(fsp.stat(file)).rejects.toThrow();
  });

  it('opens a fresh file, an unstamped one, and an equal or older one, and stamps the current version', () => {
    const fresh = path.join(dir, 'fresh.db');
    new WorkspaceService(fresh).close();
    expect(storedVersion(fresh)).toBe(String(SCHEMA_VERSION));

    const unstamped = path.join(dir, 'unstamped.db');
    stamp(unstamped, null);
    new WorkspaceService(unstamped).close();
    expect(storedVersion(unstamped)).toBe(String(SCHEMA_VERSION));

    const older = path.join(dir, 'older.db');
    stamp(older, '5');
    new WorkspaceService(older).close();
    expect(storedVersion(older)).toBe(String(SCHEMA_VERSION));
  });

  it('a real database from this build reopens (no false refusal)', () => {
    const file = path.join(dir, 'roundtrip.db');
    const a = new WorkspaceService(file);
    a.createWorkspace({ id: 'w', name: 'W', menResults: [], womenResults: [], recruits: [], createdAt: 1 });
    a.close();
    const b = new WorkspaceService(file);
    expect(b.getWorkspace('w')?.name).toBe('W');
    b.close();
  });
});
