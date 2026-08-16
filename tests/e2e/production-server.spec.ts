import { test, expect } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

/**
 * Regression guard for the "production server never tested" defect.
 *
 * playwright.config.ts's webServer runs `npm run dev` (tsx server.ts), so
 * every other e2e spec in this suite exercises the DEV code path only. The
 * PRODUCTION path — `node dist/server.js` with NODE_ENV=production, which is
 * what Start-OmniSwim-Suite-Prod.bat runs and what a freshly synced laptop
 * runs — had no coverage at all.
 *
 * It shipped broken: PROJECT_ROOT was computed as `path.join(SHELL_ROOT,
 * '../..')`, which is correct for the dev entry file (apps/shell/server.ts)
 * but wrong for the built bundle at apps/shell/dist/server.js, one level
 * deeper. That resolved the root to `apps/` instead of the repo root, so
 * static files were served from a nonexistent `apps/dist` (404 on every
 * page) and the seed was read from a nonexistent `apps/data/meets.json`
 * (silently seeding an empty database). It is now fixed by walking up for a
 * directory containing both `package.json` and `packages/`. This test boots
 * the actual built bundle the way the launcher does and asserts both symptoms
 * stay fixed.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHELL_DIR = path.join(REPO_ROOT, 'apps', 'shell');
const PROD_PORT = 3201;
const BASE = `http://127.0.0.1:${PROD_PORT}`;

let serverProcess: ChildProcess | undefined;

function waitForPort(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, res => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${url} to answer`));
          return;
        }
        setTimeout(attempt, 300);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    attempt();
  });
}

test.describe('production server (dist/server.js)', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);

    // Build the real production bundle, matching what the launcher runs.
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: true,
    });
    if (build.status !== 0) {
      throw new Error('npm run build failed — cannot verify the production server without a build');
    }

    serverProcess = spawn('node', ['dist/server.js'], {
      cwd: SHELL_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(PROD_PORT),
        OMNI_DB: 'sqlite',
      },
      stdio: 'inherit',
    });

    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        // eslint-disable-next-line no-console
        console.error(`production server exited early with code ${code} (signal ${signal})`);
      }
    });

    await waitForPort(`${BASE}/`, 60_000);
  });

  test.afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
      // Give it a moment to release the port; force-kill if it doesn't.
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          serverProcess?.kill('SIGKILL');
          resolve();
        }, 5_000);
        serverProcess?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  test('GET / serves the real app shell, not a 404 from a missing dist dir', async ({ request }) => {
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain('<div id="root"');
  });

  test('GET /api/workspaces finds the seed, not an empty freshly-seeded db', async ({ request }) => {
    const res = await request.get(`${BASE}/api/workspaces`);
    expect(res.status()).toBe(200);
    const workspaces = (await res.json()) as Array<{
      id: string;
      menResults?: unknown[];
      recruits?: unknown[];
    }>;
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces.length).toBeGreaterThan(0);

    // A seed that ran against the wrong (nonexistent) data file can still
    // produce a non-empty array of empty-shell workspaces. Require at least
    // one workspace to carry real seeded content.
    const hasRealContent = workspaces.some(
      ws => (ws.menResults && ws.menResults.length > 0) || (ws.recruits && ws.recruits.length > 0)
    );
    expect(hasRealContent).toBe(true);
  });
});
