/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The committed seed must be invented, and `data/meets.json` must stay out of
 * git.
 *
 * ## Why
 *
 * `data/meets.json` is this machine's live working store. It was also tracked,
 * so cloning the repo handed you somebody else's real roster as your starting
 * data: ~170 named athletes, ~1,900 history entries and ~500 recruits, in a
 * 3 MB file, in a public repository. Fine for one person's own checkout, wrong
 * for anybody else's, and a privacy problem the moment the repo is shared.
 *
 * The two roles are now separate files. `meets.json` is local and untracked;
 * `demo-seed.json` is committed, small, and entirely made up.
 *
 * These cases exist because the failure is silent and easy to reintroduce:
 * someone regenerates the seed from their own workspace, commits it, and every
 * future clone ships real names again with nothing to say so.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SEED = path.join(REPO_ROOT, 'data', 'demo-seed.json');

function trackedByGit(relPath: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--error-unmatch', relPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

describe('data/meets.json is not shipped', () => {
  it('is not tracked by git', () => {
    // The whole point. If this fails, someone re-added the live store and every
    // clone is about to ship real athlete data again.
    expect(
      trackedByGit('data/meets.json'),
      'data/meets.json is the live working store and must stay untracked — use data/demo-seed.json for what a fresh install starts from',
    ).toBe(false);
  });

  it('is listed in .gitignore, so it cannot be re-added by accident', () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf-8');
    expect(ignore.split('\n').map(l => l.trim())).toContain('data/meets.json');
  });
});

describe('data/demo-seed.json', () => {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf-8')) as Array<Record<string, unknown>>;

  it('is tracked, because a fresh install needs it', () => {
    expect(trackedByGit('data/demo-seed.json')).toBe(true);
  });

  it('parses as a non-empty workspace array', () => {
    expect(Array.isArray(seed)).toBe(true);
    expect(seed.length).toBeGreaterThan(0);
    for (const ws of seed) {
      expect(typeof ws.id).toBe('string');
      expect(typeof ws.name).toBe('string');
    }
  });

  it('says in its own name that it is not real', () => {
    // A coach must never mistake a demo row for a result. The name is the only
    // thing carrying that on every screen the workspace appears in.
    for (const ws of seed) {
      expect(String(ws.name).toLowerCase()).toMatch(/sample|demo|example/);
    }
  });

  it('stays small enough to be a seed rather than a data set', () => {
    // 3 MB was the old behaviour. A seed that grows back toward that is a sign
    // somebody exported their real workspace into it.
    const bytes = fs.statSync(SEED).size;
    expect(bytes).toBeLessThan(200 * 1024);
  });

  it('contains no athlete or team from the live store', () => {
    // Skipped rather than failed when meets.json is absent: a clean clone will
    // not have one, and that is the expected state, not a problem.
    const live = path.join(REPO_ROOT, 'data', 'meets.json');
    if (!fs.existsSync(live)) return;

    const liveWorkspaces = JSON.parse(fs.readFileSync(live, 'utf-8')) as Array<Record<string, any>>;
    const liveNames = new Set<string>();
    const liveTeams = new Set<string>();
    for (const ws of liveWorkspaces) {
      for (const row of [...(ws.menResults ?? []), ...(ws.womenResults ?? [])]) {
        if (row?.name) liveNames.add(String(row.name));
        if (row?.team) liveTeams.add(String(row.team));
      }
      for (const key of Object.keys(ws.athleteHistory ?? {})) liveNames.add(key);
      for (const r of ws.recruits ?? []) if (r?.name) liveNames.add(String(r.name));
    }

    const seedNames = new Set<string>();
    const seedTeams = new Set<string>();
    for (const ws of seed) {
      for (const row of [...((ws.menResults as any[]) ?? []), ...((ws.womenResults as any[]) ?? [])]) {
        if (row?.name) seedNames.add(String(row.name));
        if (row?.team) seedTeams.add(String(row.team));
      }
    }

    const leakedNames = [...seedNames].filter(n => liveNames.has(n));
    const leakedTeams = [...seedTeams].filter(t => liveTeams.has(t));
    expect(leakedNames, `demo seed contains real athlete name(s): ${leakedNames.join(', ')}`).toStrictEqual([]);
    expect(leakedTeams, `demo seed contains real team(s): ${leakedTeams.join(', ')}`).toStrictEqual([]);
  });
});
