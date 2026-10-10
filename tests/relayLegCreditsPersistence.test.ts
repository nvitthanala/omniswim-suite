/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * relayLegCredits_roundTripSqliteAndPg
 *
 * `Workspace.relayLegCredits` survives a save and a load through both
 * `WorkspaceService` (SQLite) and `PgWorkspaceService` (PostgreSQL): every field
 * kept, an absent optional field still absent, order kept, and a re-save that
 * shrinks the collection leaves no stale row behind.
 *
 * SQLite uses a real temp database file (`node:sqlite`). PostgreSQL needs a live
 * server: set `PG_TEST_URL` (or `DATABASE_URL`) to a THROWAWAY database to run
 * it. Without either variable that block is skipped, and the skip reason is in
 * the test name. The structural guard that needs no database is
 * `scripts/test_persistence_parity.mjs`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gender } from '@omniswim/core/types';
import type { RelayLegCredit, Workspace } from '@omniswim/core/types';
import { WorkspaceService } from '../packages/db/src/WorkspaceService';
import { PgWorkspaceService } from '../packages/db/src/PgWorkspaceService';
import { CHILD_TABLES } from '../packages/db/src/workspacePersistence';
import { CREATE_PG_TABLES_SQL } from '../packages/db/src/pgSchema';
import { collectionCounts, DATA_LOSS_COLLECTIONS, detectSharpDrops } from '../apps/shell/lib/dataLossGuard';

/** Every optional field present. */
const FULL: RelayLegCredit = {
  swimCloudSwimId: '186273837',
  swimCloudSwimmerId: '1355764',
  meetId: '399227',
  eventRef: '2',
  name: 'Alan Gonzalez',
  team: 'Henderson State',
  gender: Gender.MEN,
  relayEvent: '200 MED-R',
  relayEventTitle: '200 Medley Relay Men',
  legLabel: 'Anchor',
  legPosition: 4,
  legPositionSource: 'leg-word',
  isLeadoff: false,
  split: '21.83',
  timeType: 'SCY',
  relayPlace: 6,
  relayLetter: 'A',
  meetLabel: 'NSISC Championships',
  date: 'Feb 11, 2026',
  sourceUrl: 'https://www.swimcloud.com/results/399227/swimmer/1355764/',
  retrievedAt: '2026-10-09T15:35:38.683Z',
};

/** Only the required fields: every optional one absent. */
const BARE: RelayLegCredit = {
  swimCloudSwimId: '186273838',
  swimCloudSwimmerId: '1355765',
  meetId: '399227',
  eventRef: '2',
  name: 'Second Swimmer',
  team: 'Henderson State',
  gender: Gender.MEN,
  relayEvent: '200 MED-R',
  isLeadoff: false,
  split: '22.01',
  sourceUrl: 'https://www.swimcloud.com/results/399227/swimmer/1355765/',
};

function workspace(id: string, relayLegCredits?: RelayLegCredit[]): Workspace {
  return {
    id,
    name: 'Relay credit round trip',
    createdAt: 1700000000000,
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    athleteHistory: [{ name: 'John Doe', team: 'A', gender: Gender.MEN, event: '100 Free', time: '44.0', source: 'paste' }],
    ...(relayLegCredits === undefined ? {} : { relayLegCredits }),
  } as Workspace;
}

describe('relayLegCredits_roundTripSqliteAndPg', () => {
  it('names the table in CHILD_TABLES and in both schemas', () => {
    expect(CHILD_TABLES).toContain('relay_leg_credits');
    expect(CREATE_PG_TABLES_SQL).toContain('CREATE TABLE IF NOT EXISTS relay_leg_credits');
  });

  describe('SQLite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-relay-credits-'));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('keeps every field, keeps absent fields absent, and survives a reopen', () => {
      const dbPath = path.join(dir, 'a.db');
      const service = new WorkspaceService(dbPath);
      service.createWorkspace(workspace('ws-1', [FULL, BARE]));
      service.close();

      const reopened = new WorkspaceService(dbPath);
      const got = reopened.getWorkspace('ws-1');
      reopened.close();
      expect(got?.relayLegCredits).toStrictEqual([FULL, BARE]);
      const bare = got?.relayLegCredits?.[1] as Record<string, unknown>;
      for (const optional of ['relayEventTitle', 'legLabel', 'legPosition', 'legPositionSource', 'timeType', 'relayPlace', 'relayLetter', 'meetLabel', 'date', 'retrievedAt']) {
        expect(optional in bare).toBe(false);
      }
      // Kept apart from history, not folded into it.
      expect(got?.athleteHistory).toHaveLength(1);
    });

    it('a re-save with fewer credits leaves no stale row', () => {
      const service = new WorkspaceService(path.join(dir, 'b.db'));
      service.createWorkspace(workspace('ws-2', [FULL, BARE]));
      service.updateWorkspace('ws-2', { relayLegCredits: [BARE] });
      expect(service.getWorkspace('ws-2')?.relayLegCredits).toStrictEqual([BARE]);
      service.updateWorkspace('ws-2', { relayLegCredits: [] });
      expect(service.getWorkspace('ws-2')?.relayLegCredits).toStrictEqual([]);
      service.close();
    });

    it('a workspace saved without credits loads with an empty collection (never a stale one)', () => {
      const service = new WorkspaceService(path.join(dir, 'c.db'));
      service.createWorkspace(workspace('ws-3'));
      expect(service.getWorkspace('ws-3')?.relayLegCredits ?? []).toStrictEqual([]);
      service.close();
    });

    it('is stored in a table of its own, one row per credit, and copied by a snapshot', () => {
      const service = new WorkspaceService(path.join(dir, 'd.db'));
      service.createWorkspace(workspace('ws-4', [FULL, BARE]));
      const snap = service.createSnapshot('ws-4', 'with credits');
      expect(snap).toBeDefined();
      service.updateWorkspace('ws-4', { relayLegCredits: [] });
      service.restoreSnapshot(snap!.id);
      expect(service.getWorkspace('ws-4')?.relayLegCredits).toStrictEqual([FULL, BARE]);
      service.close();
    });

    it('every table in CHILD_TABLES exists in a fresh database', () => {
      const dbPath = path.join(dir, 'e.db');
      const service = new WorkspaceService(dbPath);
      service.createWorkspace(workspace('ws-5', [FULL]));
      // getWorkspace reads every child table; a missing table would throw.
      expect(service.getWorkspace('ws-5')).toBeDefined();
      service.close();
    });
  });

  const pgUrl = process.env.PG_TEST_URL || process.env.DATABASE_URL;
  describe.skipIf(!pgUrl)(
    pgUrl ? 'PostgreSQL' : 'PostgreSQL (SKIPPED: set PG_TEST_URL to a throwaway database to run)',
    () => {
      it('keeps every field, keeps absent fields absent, and replaces on re-save', async () => {
        const service = new PgWorkspaceService({ connectionString: pgUrl as string });
        await service.init();
        const id = `ws-pg-relay-credits-${Date.now()}`;
        try {
          await service.createWorkspace(workspace(id, [FULL, BARE]));
          expect((await service.getWorkspace(id))?.relayLegCredits).toStrictEqual([FULL, BARE]);
          await service.updateWorkspace(id, { relayLegCredits: [BARE] });
          expect((await service.getWorkspace(id))?.relayLegCredits).toStrictEqual([BARE]);
        } finally {
          await service.deleteWorkspace(id);
          await service.close();
        }
      });
    },
  );
});

describe('relayLegCredits in the data-loss guard', () => {
  const many = (n: number): RelayLegCredit[] => Array.from({ length: n }, (_, i) => ({ ...BARE, swimCloudSwimId: String(i) }));

  it('is a watched collection', () => {
    expect(DATA_LOSS_COLLECTIONS).toContain('relayLegCredits');
  });

  it('reports a sharp drop of credits, and ignores a patch that does not mention them', () => {
    const before = collectionCounts(workspace('w', many(40)));
    expect(before.relayLegCredits).toBe(40);
    expect(detectSharpDrops(before, collectionCounts({ relayLegCredits: [] }))).toStrictEqual([
      { collection: 'relayLegCredits', from: 40, to: 0 },
    ]);
    expect(detectSharpDrops(before, collectionCounts({ name: 'renamed' }))).toStrictEqual([]);
  });
});
