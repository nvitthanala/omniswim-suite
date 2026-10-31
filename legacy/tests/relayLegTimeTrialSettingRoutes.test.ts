/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `ScoringSettings.relayLegsAllowTimeTrials` (user decision D9) lives on the
 * scoring preset and on the workspace scoring settings, like
 * `entryCapCountsTimeTrials`. This file covers the two persistence paths:
 *
 * - the preset write schema is `.strict()`: it accepts the key, and it still
 *   refuses an unknown key and a non-boolean value
 * - a preset saved with the key comes back with it, and loads into settings
 * - a workspace saved with the key keeps it
 *
 * Mutation map (revert the fix, the named case turns red):
 *  - the key is missing from the preset schema -> "accepts the key" cases
 *  - the schema stops being strict             -> "refuses an unknown key"
 *  - the key is typed loosely                  -> "refuses a value that is not a boolean"
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerScoringPresetRoutes } from '../apps/shell/lib/routes/scoringPresetRoutes';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { JsonRepo } from '../apps/shell/lib/workspaceRepo';
import {
  relayLegsAllowTimeTrials,
  settingsFromPresetPayload,
} from '../../packages/core/src/lib/scoringDefaults';
import type { ScoringSettings } from '../../packages/core/src/types';

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function listen(app: express.Express, cleanup: () => Promise<void>): Promise<string> {
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  open.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
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

const baseSettings = {
  scoringPoints: [9, 4, 3, 2, 1, 0],
  relayMultiplier: 2,
  halfRateRelaySwimmer: false,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 2,
};

describe('scoring preset routes carry relayLegsAllowTimeTrials', () => {
  async function boot() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-relay-tt-preset-'));
    const app = express();
    app.use(express.json());
    registerScoringPresetRoutes(app, { scoringPresetsDir: path.join(dir, 'presets') });
    return listen(app, () => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined));
  }

  const body = (id: string, settings: Record<string, unknown>) => ({ id, label: 'Relay TT', settings });

  it('accepts the key, and a preset saved with it comes back with it', async () => {
    const url = await boot();
    const post = await http(`${url}/api/scoring-presets`, 'POST', {
      ...body('relay-tt-on', { ...baseSettings, relayLegsAllowTimeTrials: true }),
    });
    expect(post.status).toBe(201);
    const got = await http(`${url}/api/scoring-presets/relay-tt-on`, 'GET');
    expect(got.status).toBe(200);
    expect(got.json.relayLegsAllowTimeTrials).toBe(true);
    const settings = settingsFromPresetPayload(got.json);
    expect(settings.relayLegsAllowTimeTrials).toBe(true);
    expect(relayLegsAllowTimeTrials(settings)).toBe(true);
  });

  it('an explicit false is kept, not dropped', async () => {
    const url = await boot();
    const post = await http(`${url}/api/scoring-presets`, 'POST', {
      ...body('relay-tt-off', { ...baseSettings, relayLegsAllowTimeTrials: false }),
    });
    expect(post.status).toBe(201);
    const got = await http(`${url}/api/scoring-presets/relay-tt-off`, 'GET');
    expect(got.json).toHaveProperty('relayLegsAllowTimeTrials', false);
  });

  it('a PUT changes the stored value', async () => {
    const url = await boot();
    await http(`${url}/api/scoring-presets`, 'POST', body('relay-tt-put', baseSettings));
    const before = await http(`${url}/api/scoring-presets/relay-tt-put`, 'GET');
    expect(before.json).not.toHaveProperty('relayLegsAllowTimeTrials');
    const put = await http(
      `${url}/api/scoring-presets/relay-tt-put`,
      'PUT',
      body('relay-tt-put', { ...baseSettings, relayLegsAllowTimeTrials: true })
    );
    expect(put.status).toBe(200);
    const after = await http(`${url}/api/scoring-presets/relay-tt-put`, 'GET');
    expect(after.json.relayLegsAllowTimeTrials).toBe(true);
  });

  it('still refuses an unknown key', async () => {
    const url = await boot();
    const res = await http(`${url}/api/scoring-presets`, 'POST', body('relay-tt-typo', {
      ...baseSettings,
      relayLegsAllowTimeTrial: true,
    }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('relayLegsAllowTimeTrial');
  });

  it('refuses a value that is not a boolean', async () => {
    const url = await boot();
    for (const value of ['yes', 1, null]) {
      const res = await http(`${url}/api/scoring-presets`, 'POST', body('relay-tt-bad', {
        ...baseSettings,
        relayLegsAllowTimeTrials: value,
      }));
      expect(res.status).toBe(400);
    }
  });
});

describe('workspace save keeps relayLegsAllowTimeTrials', () => {
  async function boot() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-relay-tt-ws-'));
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
    return listen(app, () => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined));
  }

  const ws = { id: 'rt', name: 'HSU', menResults: [], womenResults: [], recruits: [], createdAt: 1000 };

  it('a PUT with the key reads back with it, true and false', async () => {
    const url = await boot();
    await http(`${url}/api/workspaces`, 'POST', ws);
    const on = await http(`${url}/api/workspaces/rt`, 'PUT', {
      scoringSettings: { ...baseSettings, relayLegsAllowTimeTrials: true },
    });
    expect(on.status).toBe(200);
    const afterOn = (await http(`${url}/api/workspaces`, 'GET')).json[0];
    expect(afterOn.scoringSettings.relayLegsAllowTimeTrials).toBe(true);

    const off = await http(`${url}/api/workspaces/rt`, 'PUT', {
      scoringSettings: { ...baseSettings, relayLegsAllowTimeTrials: false },
    });
    expect(off.status).toBe(200);
    const afterOff = (await http(`${url}/api/workspaces`, 'GET')).json[0];
    expect(afterOff.scoringSettings.relayLegsAllowTimeTrials).toBe(false);
  });

  it('a workspace created with the key keeps it', async () => {
    const url = await boot();
    const created = await http(`${url}/api/workspaces`, 'POST', {
      ...ws,
      id: 'rt2',
      scoringSettings: { ...baseSettings, relayLegsAllowTimeTrials: true },
    });
    expect([200, 201]).toContain(created.status);
    const list = (await http(`${url}/api/workspaces`, 'GET')).json as Array<{ id: string; scoringSettings: ScoringSettings }>;
    expect(list.find(w => w.id === 'rt2')?.scoringSettings.relayLegsAllowTimeTrials).toBe(true);
  });
});
