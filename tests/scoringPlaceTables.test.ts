/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The place-table contract (user decision U5, 2026-10-12): a stored table is
 * `number[]`; a blank cell exists only in a UI draft; a draft becomes settings
 * only through `finalizeScoringDraft`; and the workspace save refuses a null or
 * non-finite cell while letting every legacy table through unchanged.
 *
 * Mutation map (revert the fix, the named case turns red):
 *  - finalize reads `null` as 0                  -> the blanks cases
 *  - finalize drops the table-name field         -> "names each blank by table and place"
 *  - light check accepts null                    -> the 400 cases
 *  - light check applies non-increasing          -> the legacy cases
 *  - light check stops requiring one entry       -> the empty-table case
 *  - pointsTableSchema loses non-increasing      -> the preset rule case
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { JsonRepo } from '../apps/shell/lib/workspaceRepo';
import { updateWorkspaceSchema } from '../packages/core/src/schemas/workspace';
import {
  finalizeScoringDraft,
  pointsTableSchema,
  type ScoringSettingsDraft,
} from '../packages/core/src/lib/scoringPlaceTables';
import * as coreIndex from '../packages/core/src/index';
import { GENERIC_TOP16_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import type { ScoringSettings } from '../packages/core/src/types';

const draftOf = (over: Partial<ScoringSettingsDraft> = {}): ScoringSettingsDraft => ({
  ...(GENERIC_TOP16_SETTINGS as ScoringSettings),
  scoringPoints: [...GENERIC_TOP16_SETTINGS.scoringPoints],
  ...over,
});

describe('finalizeScoringDraft', () => {
  it('a draft with every cell filled becomes plain number[] settings, values as entered', () => {
    const r = finalizeScoringDraft(
      draftOf({ scoringPoints: [9, 4, 3, 2, 1, 0], relayPoints: [11, 4, 2, 0], divingPoints: [7, 5, 4] })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.scoringPoints).toStrictEqual([9, 4, 3, 2, 1, 0]);
    expect(r.settings.relayPoints).toStrictEqual([11, 4, 2, 0]);
    expect(r.settings.divingPoints).toStrictEqual([7, 5, 4]);
    // Every other setting rides through untouched.
    expect(r.settings.relayMultiplier).toBe(GENERIC_TOP16_SETTINGS.relayMultiplier);
  });

  it('a real 0 is a value, not a blank', () => {
    const r = finalizeScoringDraft(draftOf({ scoringPoints: [5, 0, 0], relayPoints: [0] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.scoringPoints).toStrictEqual([5, 0, 0]);
      expect(r.settings.relayPoints).toStrictEqual([0]);
    }
  });

  it('names each blank by table and 1-based place, in table then place order, and returns no settings', () => {
    const r = finalizeScoringDraft(
      draftOf({
        scoringPoints: [9, null, 3, null],
        relayPoints: [null, 4],
        divingPoints: [7, 5, null],
      })
    );
    expect(r).toStrictEqual({
      ok: false,
      blanks: [
        { table: 'scoringPoints', place: 2 },
        { table: 'scoringPoints', place: 4 },
        { table: 'relayPoints', place: 1 },
        { table: 'divingPoints', place: 3 },
      ],
    });
  });

  it('a blank is never read as 0: one null in a table that is otherwise zeros still blocks', () => {
    const r = finalizeScoringDraft(draftOf({ scoringPoints: [0, 0, null] }));
    expect(r.ok).toBe(false);
  });

  it('a NaN or Infinity cell is a blank, not a number', () => {
    const r = finalizeScoringDraft(draftOf({ scoringPoints: [9, Number.NaN, Number.POSITIVE_INFINITY] }));
    expect(r).toStrictEqual({
      ok: false,
      blanks: [
        { table: 'scoringPoints', place: 2 },
        { table: 'scoringPoints', place: 3 },
      ],
    });
  });

  it('an optional table with no cells is "not enabled" and stays out of the settings', () => {
    const r = finalizeScoringDraft(draftOf({ relayPoints: [], divingPoints: undefined }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings).not.toHaveProperty('relayPoints');
      expect(r.settings).not.toHaveProperty('divingPoints');
    }
  });

  it('does not mutate the draft it is given', () => {
    const draft = draftOf({ scoringPoints: [9, 4, 3], relayPoints: [11, 4, 2] });
    const before = JSON.stringify(draft);
    finalizeScoringDraft(draft);
    expect(JSON.stringify(draft)).toBe(before);
  });
});

describe('pointsTableSchema (moved from the shell, unchanged)', () => {
  it('accepts a non-increasing table', () => {
    expect(pointsTableSchema('t').safeParse([9, 4, 3, 2, 1, 0]).success).toBe(true);
  });
  it('rejects a table that rises as places get worse, a negative value, and an empty table', () => {
    expect(pointsTableSchema('t').safeParse([9, 10]).success).toBe(false);
    expect(pointsTableSchema('t').safeParse([9, -1]).success).toBe(false);
    expect(pointsTableSchema('t').safeParse([]).success).toBe(false);
  });
});

describe('core index exports the draft contract additively', () => {
  it('exposes finalizeScoringDraft and pointsTableSchema', () => {
    expect(typeof coreIndex.finalizeScoringDraft).toBe('function');
    expect(typeof coreIndex.pointsTableSchema).toBe('function');
  });
});

describe('the workspace save checks place tables lightly', () => {
  const parse = (scoringSettings: unknown) => updateWorkspaceSchema.safeParse({ scoringSettings });

  it('a null cell in scoringPoints, relayPoints or divingPoints is refused', () => {
    expect(parse({ scoringPoints: [9, null, 3] }).success).toBe(false);
    expect(parse({ scoringPoints: [9], relayPoints: [null] }).success).toBe(false);
    expect(parse({ scoringPoints: [9], divingPoints: [7, null] }).success).toBe(false);
  });

  it('a negative, non-numeric or empty table is refused', () => {
    expect(parse({ scoringPoints: [9, -1] }).success).toBe(false);
    expect(parse({ scoringPoints: [9, '4'] }).success).toBe(false);
    expect(parse({ scoringPoints: [] }).success).toBe(false);
    expect(parse({ scoringPoints: 'nine' }).success).toBe(false);
  });

  it('a legacy 16-place table that ends 0, 0 passes unchanged', () => {
    const legacy = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 0, 0];
    const r = parse({ scoringPoints: legacy, relayMultiplier: 2, anyFutureKey: { kept: true } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.scoringSettings?.scoringPoints).toStrictEqual(legacy);
      expect(r.data.scoringSettings).toHaveProperty('anyFutureKey');
    }
  });

  it('a legacy seeded [0] relay table passes unchanged', () => {
    const r = parse({ scoringPoints: [20, 17], relayPoints: [0] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scoringSettings?.relayPoints).toStrictEqual([0]);
  });

  it('the non-increasing rule is a preset rule and does not block a workspace save', () => {
    expect(parse({ scoringPoints: [1, 2, 3] }).success).toBe(true);
  });

  it('a patch that leaves scoringSettings out, or sends settings with no tables, is unaffected', () => {
    expect(updateWorkspaceSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(parse({ relayMultiplier: 2 }).success).toBe(true);
  });
});

describe('PUT /api/workspaces/:id with a blank place cell', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (open.length) await open.pop()!();
  });

  async function boot() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-place-tables-'));
    const repo = new JsonRepo(path.join(dir, 'meets.json'), path.join(dir, 'backups'), () => []);
    await repo.init();
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    const pass: express.RequestHandler = (_q, _s, n) => n();
    registerWorkspaceRoutes(app, {
      repo,
      auth: null,
      shareLinks: null,
      AUTH_REQUIRED: false,
      requireAuth: pass,
      optionalAuth: pass,
      defaultScoringSettings: {} as ScoringSettings,
    });
    const server: Server = await new Promise(r => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    open.push(async () => {
      await new Promise<void>(r => server.close(() => r()));
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });
    return `http://127.0.0.1:${addr.port}`;
  }

  async function http(url: string, method: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }

  const ws = { id: 'pt', name: 'HSU', menResults: [], womenResults: [], recruits: [], createdAt: 1000 };

  it('a null in scoringPoints is a 400 and the stored settings do not change', async () => {
    const url = await boot();
    await http(`${url}/api/workspaces`, 'POST', ws);
    const ok = await http(`${url}/api/workspaces/pt`, 'PUT', { scoringSettings: { scoringPoints: [9, 4, 3] } });
    expect(ok.status).toBe(200);
    const bad = await http(`${url}/api/workspaces/pt`, 'PUT', { scoringSettings: { scoringPoints: [9, null, 3] } });
    expect(bad.status).toBe(400);
    const after = (await http(`${url}/api/workspaces`, 'GET')).json[0];
    expect(after.scoringSettings.scoringPoints).toStrictEqual([9, 4, 3]);
  });

  it('a legacy [20, ..., 0, 0] table and a [0] relay table save and read back exactly as sent', async () => {
    const url = await boot();
    await http(`${url}/api/workspaces`, 'POST', ws);
    const legacy = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 0, 0];
    const put = await http(`${url}/api/workspaces/pt`, 'PUT', {
      scoringSettings: { scoringPoints: legacy, relayPoints: [0] },
    });
    expect(put.status).toBe(200);
    const after = (await http(`${url}/api/workspaces`, 'GET')).json[0];
    expect(after.scoringSettings.scoringPoints).toStrictEqual(legacy);
    expect(after.scoringSettings.relayPoints).toStrictEqual([0]);
  });
});
