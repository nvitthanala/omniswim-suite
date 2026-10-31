import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvalidPresetIdError,
  registerScoringPresetRoutes,
  userPresetFilePathIn,
} from '../apps/shell/lib/routes/scoringPresetRoutes';

const BAD_IDS = ['../x', '..\\x', '../../outside', '/etc/passwd', 'C:\\Windows\\x', '/abs/path', '', 'a/b', 'A', 'x.json'];

describe('userPresetFilePathIn', () => {
  const dir = path.join(os.tmpdir(), 'omni-preset-unit');

  it('returns a path inside the presets directory for a valid id', () => {
    expect(userPresetFilePathIn(dir, 'my-rules_2')).toBe(path.resolve(dir, 'my-rules_2.json'));
  });

  it.each(BAD_IDS)('throws InvalidPresetIdError for %j', id => {
    expect(() => userPresetFilePathIn(dir, id)).toThrow(InvalidPresetIdError);
  });

  it('throws for a non-string id', () => {
    expect(() => userPresetFilePathIn(dir, undefined as unknown as string)).toThrow(InvalidPresetIdError);
  });
});

describe('scoring preset write routes refuse path-shaped ids', () => {
  let sandbox: string;
  let presetsDir: string;
  let server: import('node:http').Server;
  let base: string;

  const validBody = (id: string) => ({
    id,
    label: 'Path test',
    settings: {
      scoringPoints: [9, 4, 3, 2, 1, 0],
      relayPoints: [11, 4, 2, 0],
      relayMultiplier: 2,
      halfRateRelaySwimmer: true,
      maxIndividualScorersPerTeam: 999,
      maxRelaysScoringPerTeam: 2,
      maxIndividualScorersPerTeamPerEvent: 3,
      aFinalBracketSize: 6,
      scorerCapScope: 'event',
      diverScorerWeight: 1,
      relayEligibleFromScorerPool: false,
      diverEventPattern: ['DIVING', 'DIVE'],
    },
  });

  /** Every file anywhere under the sandbox, so an escape is visible wherever it lands. */
  const filesUnder = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );

  beforeAll(async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preset-routes-'));
    presetsDir = path.join(sandbox, 'presets');
    fs.mkdirSync(presetsDir);
    const app = express();
    app.use(express.json());
    registerScoringPresetRoutes(app, { scoringPresetsDir: presetsDir });
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each(BAD_IDS)('POST with id %j is rejected and writes nothing', async id => {
    const res = await fetch(`${base}/api/scoring-presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody(id)),
    });
    expect(res.status).toBe(400);
    expect(filesUnder(sandbox)).toEqual([]);
  });

  it.each(['..%2Fx', '%2Fetc%2Fpasswd', '..%5Cx', 'UPPER'])('PUT /%s is rejected and writes nothing', async urlId => {
    const res = await fetch(`${base}/api/scoring-presets/${urlId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody(decodeURIComponent(urlId))),
    });
    expect([400, 404]).toContain(res.status);
    expect(filesUnder(sandbox)).toEqual([]);
  });

  it('a valid id still creates exactly one file inside the presets directory', async () => {
    const res = await fetch(`${base}/api/scoring-presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody('zz-path-test')),
    });
    expect(res.status).toBe(201);
    expect(filesUnder(sandbox)).toEqual([path.join(presetsDir, 'zz-path-test.json')]);
    fs.rmSync(path.join(presetsDir, 'zz-path-test.json'));
  });
});
