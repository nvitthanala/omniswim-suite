import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * P3, client half: a tab that saves from a stale copy must not overwrite another tab's save,
 * must not silently adopt the newer copy, and must keep the user's edit on screen until Reload.
 *
 * Page A makes a change and saves. Page B was opened earlier, so it still holds the old version.
 * Page B then edits a different field. The server refuses that save (409 VERSION_CONFLICT) and
 * page B shows a persistent banner. Run against a COPY of the data (playwright.config.ts does
 * this by default).
 */
const BANNER_TEXT =
  'This workspace changed in another tab. Reload to see the latest version. ' +
  'Your changes in this tab since the last save are not saved.';

const created: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) await request.delete(`/api/workspaces/${id}`);
});

type Saved = { id: string; version: number; scoringView?: string; scoringSettings?: { scoringPoints?: number[] } };

async function createBlankWorkspace(request: APIRequestContext): Promise<string> {
  const stamp = Date.now();
  const id = `ui-p3-${stamp}`;
  const res = await request.post('/api/workspaces', {
    data: {
      id,
      name: `UI P3 ${stamp}`,
      createdAt: stamp,
      scoringView: 'merged',
      menResults: [],
      womenResults: [],
      recruits: [],
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  created.push(id);
  return id;
}

async function fromServer(request: APIRequestContext, id: string): Promise<Saved> {
  const res = await request.get('/api/workspaces');
  expect(res.ok()).toBeTruthy();
  const found = ((await res.json()) as Saved[]).find(w => w.id === id);
  expect(found, `workspace ${id} is on the server`).toBeTruthy();
  return found!;
}

async function openScoringDialog(page: Page) {
  await page.getByRole('button', { name: 'Configure Scoring Model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scoring rules' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a stale tab gets a banner, the server keeps the other tab\'s save, and the edit stays until Reload', async ({
  browser,
  request,
}) => {
  const id = await createBlankWorkspace(request);
  const url = `/manager?workspace=${id}&gender=Men`;
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    // Both tabs load the workspace at version 1. B then sits idle.
    await pageA.goto(url);
    await pageB.goto(url);
    await expect(pageA.getByRole('button', { name: 'Configure Scoring Model' })).toBeVisible();
    await expect(pageB.getByRole('button', { name: 'Configure Scoring Model' })).toBeVisible();
    expect((await fromServer(request, id)).version).toBe(1);

    // Tab A changes the scoring view. The control saves on its own after the autosave debounce.
    const dialogA = await openScoringDialog(pageA);
    await dialogA.getByRole('button', { name: 'Use PDF-only scoring view' }).click();
    await expect.poll(async () => (await fromServer(request, id)).scoringView, { timeout: 10_000 }).toBe('pdf_only');
    const afterA = await fromServer(request, id);
    expect(afterA.version).toBe(2);

    // Tab B edits a different field and saves, still holding version 1.
    const dialogB = await openScoringDialog(pageB);
    const places = dialogB.getByLabel('Number of scoring places').first();
    await expect(places).toBeEnabled();
    const before = await places.inputValue();
    const values = await places.locator('option').evaluateAll(opts => opts.map(o => (o as HTMLOptionElement).value));
    const target = values.find(v => v !== before)!;
    expect(target, 'the place-count select offers another value').toBeTruthy();
    await places.selectOption(target);
    await dialogB.getByRole('button', { name: 'Update scoring model' }).click();

    // The banner appears with the exact text and a Reload action.
    const banner = pageB.getByTestId('workspace-conflict-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(BANNER_TEXT);
    await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible();
    // Tab A never sees one.
    await expect(pageA.getByTestId('workspace-conflict-banner')).toHaveCount(0);

    // The server still holds A's save, and B's edit never landed.
    await pageB.waitForTimeout(1000);
    const held = await fromServer(request, id);
    expect(held.version).toBe(2);
    expect(held.scoringView).toBe('pdf_only');
    expect(held.scoringSettings?.scoringPoints?.length).not.toBe(Number(target));

    // B's edit is still on screen, and the banner is still there a moment later.
    const reopened = await openScoringDialog(pageB);
    await expect(reopened.getByLabel('Number of scoring places').first()).toHaveValue(target);
    await expect(banner).toBeVisible();
    await pageB.keyboard.press('Escape');

    // Reload is the only way out. It shows A's save and drops B's edit.
    await banner.getByRole('button', { name: 'Reload' }).click();
    await expect(banner).toHaveCount(0);
    const afterReload = await openScoringDialog(pageB);
    await expect(afterReload.getByLabel('Number of scoring places').first()).toHaveValue(before);
    await expect(afterReload.getByRole('button', { name: 'Use PDF-only scoring view' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  } finally {
    await context.close();
  }
});
