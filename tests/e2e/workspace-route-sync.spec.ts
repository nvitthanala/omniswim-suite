import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A1: `WorkspaceRouteSync` must not oscillate.
 *
 * A cold load of `/manager?workspace=<id>` used to swap the active workspace id and the URL param
 * about 30 times a second (two effects writing URL and state from stale snapshots, made worse by
 * StrictMode re-running the mount effects). This spec counts every history write and every write of
 * the persisted selection over a quiet window after the load.
 *
 * Run against a COPY of the data:
 *   OMNI_DATA_DIR=<copy> PORT=<free> npx playwright test tests/e2e/workspace-route-sync.spec.ts
 */
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/chart-workspace.json'), 'utf8')) as Record<string, unknown>;

const created: string[] = [];
test.afterEach(async ({ request }) => {
  // Leave no ui-* workspaces behind.
  for (const id of created.splice(0)) await request.delete(`/api/workspaces/${id}`);
});

const SETTLE_MS = 2000;
const MAX_CHANGES = 2;

async function createWorkspace(request: APIRequestContext, label: string): Promise<string> {
  return (await createNamedWorkspace(request, label)).id;
}

async function createNamedWorkspace(request: APIRequestContext, label: string): Promise<{ id: string; name: string }> {
  const stamp = Date.now();
  const id = `ui-a1-${label}-${stamp}`;
  const response = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI A1 ${label} ${stamp}`,
      createdAt: stamp,
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  created.push(id);
  return { id: (JSON.parse(body) as { id: string }).id, name: `UI A1 ${label} ${stamp}` };
}

/** Count history writes and writes of the persisted selection from the first script tick on. */
async function installCounters(page: Page, startId: string) {
  await page.addInitScript(id => {
    const w = window as unknown as { __urlWrites: string[]; __idWrites: string[] };
    w.__urlWrites = [];
    w.__idWrites = [];
    // Seed the stored selection, then count only later writes of a different value.
    if (!sessionStorage.getItem('__a1-seeded')) {
      localStorage.setItem('omni-active-workspace-id', id);
      sessionStorage.setItem('__a1-seeded', '1');
    }
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method].bind(history);
      history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
        w.__urlWrites.push(String(url ?? ''));
        original(data, unused, url);
      };
    }
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'omni-active-workspace-id') w.__idWrites.push(value);
      originalSetItem.call(this, key, value);
    };
  }, startId);
}

async function readCounters(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __urlWrites: string[]; __idWrites: string[] };
    return { urlWrites: [...w.__urlWrites], idWrites: [...w.__idWrites] };
  });
}

for (const applet of ['manager', 'matrix'] as const) {
  test(`cold /${applet}?workspace=<id> settles on the URL workspace and stays`, async ({ page, request }) => {
    const stored = await createWorkspace(request, 'stored');
    const target = await createWorkspace(request, 'target');
    await installCounters(page, stored);

    await page.goto(`/${applet}?workspace=${target}&gender=Men`);
    await expect(page.getByRole('tab').first()).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);

    const { urlWrites, idWrites } = await readCounters(page);
    // The selection settled on the URL's workspace.
    expect(new URL(page.url()).searchParams.get('workspace')).toBe(target);
    expect(await page.evaluate(() => localStorage.getItem('omni-active-workspace-id'))).toBe(target);
    // And it did not churn getting there. The old sync made 100+ of each in this window.
    expect(urlWrites.length, `history writes: ${JSON.stringify(urlWrites)}`).toBeLessThanOrEqual(MAX_CHANGES);
    expect(idWrites.length, `selection writes: ${JSON.stringify(idWrites)}`).toBeLessThanOrEqual(MAX_CHANGES);

    // Quiet afterwards: no further writes in a second window.
    const before = await readCounters(page);
    await page.waitForTimeout(1000);
    const after = await readCounters(page);
    expect(after.urlWrites.length).toBe(before.urlWrites.length);
    expect(after.idWrites.length).toBe(before.idWrites.length);
  });
}

test('an in-app workspace switch still updates the URL', async ({ page, request }) => {
  const first = await createWorkspace(request, 'switch-a');
  const secondWs = await createNamedWorkspace(request, 'switch-b');
  const second = secondWs.id;
  await installCounters(page, first);

  await page.goto(`/manager?workspace=${first}&gender=Men`);
  await expect(page.getByRole('tab').first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(new URL(page.url()).searchParams.get('workspace')).toBe(first);

  // Switch through the sidebar the way a user does.
  const row = page.getByRole('button', { name: new RegExp(secondWs.name) }).first();
  await row.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toBe(second);
  await page.waitForTimeout(SETTLE_MS);
  expect(new URL(page.url()).searchParams.get('workspace')).toBe(second);
  expect(await page.evaluate(() => localStorage.getItem('omni-active-workspace-id'))).toBe(second);

  const { urlWrites } = await readCounters(page);
  // Initial settle (at most 1) plus one write for the switch.
  expect(urlWrites.length, `history writes: ${JSON.stringify(urlWrites)}`).toBeLessThanOrEqual(MAX_CHANGES + 1);
});
