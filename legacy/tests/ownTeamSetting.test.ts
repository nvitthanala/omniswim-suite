/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * E11: the workspace own team lives in the existing settings object
 * (`ScoringSettings.ownTeam`), as an optional field. No column, no migration.
 */
import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScoringSettings, Workspace } from '../../packages/core/src/types';
import {
  WORKSPACE_ONLY_SETTINGS_KEYS,
  keepOwnTeam,
  withOwnTeam,
  withoutWorkspaceOnlySettings,
  workspaceOwnTeam,
} from '../../packages/core/src/lib/ownTeam';
import { DEFAULT_SCORING_SETTINGS, mergeScoringSettings } from '../../packages/core/src/lib/scoringDefaults';
import { SqliteRepo } from '../apps/shell/lib/workspaceRepo';
import { updateWorkspaceSchema } from '../../packages/core/src/schemas/workspace';

const ws = (scoringSettings?: Partial<ScoringSettings>) => ({ scoringSettings }) as Pick<Workspace, 'scoringSettings'>;

describe('workspaceOwnTeam', () => {
  it('is the trimmed team, or null when unset, blank or absent', () => {
    expect(workspaceOwnTeam(ws({ ownTeam: ' Henderson State ' }))).toBe('Henderson State');
    expect(workspaceOwnTeam(ws({ ownTeam: '' }))).toBeNull();
    expect(workspaceOwnTeam(ws({ ownTeam: '  ' }))).toBeNull();
    expect(workspaceOwnTeam(ws({}))).toBeNull();
    expect(workspaceOwnTeam(ws(undefined))).toBeNull();
    expect(workspaceOwnTeam(null)).toBeNull();
  });
});

describe('withOwnTeam', () => {
  it('sets the team and keeps every other setting', () => {
    const next = withOwnTeam({ ...DEFAULT_SCORING_SETTINGS, relayMultiplier: 2 }, ' Alpha U ');
    expect(next.ownTeam).toBe('Alpha U');
    expect(next.relayMultiplier).toBe(2);
    expect(next.scoringPoints).toEqual(DEFAULT_SCORING_SETTINGS.scoringPoints);
  });
  it('clears with an explicit blank, which keeps the key so a later save does not bring the team back', () => {
    const cleared = withOwnTeam({ ...DEFAULT_SCORING_SETTINGS, ownTeam: 'Alpha U' }, null);
    expect(cleared.ownTeam).toBe('');
    expect(workspaceOwnTeam({ scoringSettings: cleared })).toBeNull();
  });
  it('starts from the generic defaults when the workspace has no settings', () => {
    expect(withOwnTeam(undefined, 'Alpha U').scoringPoints).toEqual(DEFAULT_SCORING_SETTINGS.scoringPoints);
  });
  it('does not change the object it was given', () => {
    const before = { ...DEFAULT_SCORING_SETTINGS };
    withOwnTeam(before, 'Alpha U');
    expect(before).toEqual(DEFAULT_SCORING_SETTINGS);
  });
});

describe('keepOwnTeam: a save of the rules does not unset the team', () => {
  const current = ws({ ownTeam: 'Alpha U' });

  it('carries the current team into settings that do not name it', () => {
    const preset = mergeScoringSettings({ relayMultiplier: 3 });
    expect('ownTeam' in preset).toBe(false);
    expect(keepOwnTeam(preset, current).ownTeam).toBe('Alpha U');
    expect(keepOwnTeam(preset, current).relayMultiplier).toBe(3);
  });
  it('lets settings that name it win, including an explicit blank', () => {
    expect(keepOwnTeam({ ...DEFAULT_SCORING_SETTINGS, ownTeam: 'Beta U' }, current).ownTeam).toBe('Beta U');
    expect(keepOwnTeam({ ...DEFAULT_SCORING_SETTINGS, ownTeam: '' }, current).ownTeam).toBe('');
  });
  it('adds nothing when no team is set', () => {
    expect('ownTeam' in keepOwnTeam(DEFAULT_SCORING_SETTINGS, ws({}))).toBe(false);
    expect('ownTeam' in keepOwnTeam(DEFAULT_SCORING_SETTINGS, undefined)).toBe(false);
  });
});

describe('a scoring preset never carries the own team', () => {
  it('strips the workspace-only keys', () => {
    const stripped = withoutWorkspaceOnlySettings({ ...DEFAULT_SCORING_SETTINGS, ownTeam: 'Alpha U' });
    for (const key of WORKSPACE_ONLY_SETTINGS_KEYS) expect(key in stripped).toBe(false);
    expect(stripped.scoringPoints).toEqual(DEFAULT_SCORING_SETTINGS.scoringPoints);
  });
});

describe('persistence: no schema change', () => {
  it('a PUT patch carries ownTeam through the workspace schema', () => {
    const parsed = updateWorkspaceSchema.parse({ scoringSettings: { ...DEFAULT_SCORING_SETTINGS, ownTeam: 'Alpha U' } });
    expect((parsed.scoringSettings as { ownTeam?: string }).ownTeam).toBe('Alpha U');
  });

  it('SQLite stores it in the settings column and reads it back, and an unset one stays absent', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-own-team-'));
    try {
      const repo = new SqliteRepo(path.join(dir, 'omniswim.db'), path.join(dir, 'backups'), () => []);
      await repo.init();
      const base = { name: 'W', menResults: [], womenResults: [], recruits: [], createdAt: 1 };
      await repo.create({ ...base, id: 'with', scoringSettings: { ...DEFAULT_SCORING_SETTINGS, ownTeam: 'Alpha U' } } as Workspace);
      await repo.create({ ...base, id: 'without', scoringSettings: { ...DEFAULT_SCORING_SETTINGS } } as Workspace);
      const all = await repo.list();
      const get = (id: string) => all.find(w => w.id === id)!;
      expect(workspaceOwnTeam(get('with'))).toBe('Alpha U');
      expect(workspaceOwnTeam(get('without'))).toBeNull();
      expect('ownTeam' in get('without').scoringSettings!).toBe(false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
