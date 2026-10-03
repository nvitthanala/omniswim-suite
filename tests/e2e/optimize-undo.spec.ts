import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';

// Generated once from `buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] })` in
// tests/optimizerStepFixtures.ts: a meet where the optimizer really gains. Synthetic data.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/optimize-undo-workspace.json'), 'utf8')) as Record<string, unknown>;
const HOME_TEAM = 'Henderson State University';

type Arrays = { scorerRosterOverrides: unknown[]; meetEntryPlans: unknown[]; activeEntryIds: unknown[] };

/** Absent reads as empty, the same reading the app uses. */
function arraysOf(source: Record<string, unknown>): Arrays {
  return {
    scorerRosterOverrides: (source.scorerRosterOverrides as unknown[] | undefined) ?? [],
    meetEntryPlans: (source.meetEntryPlans as unknown[] | undefined) ?? [],
    activeEntryIds: (source.activeEntryIds as unknown[] | undefined) ?? [],
  };
}

/** The saved copy. The server has no GET-by-id route, so read the list and pick the workspace. */
async function savedArrays(request: APIRequestContext, id: string): Promise<Arrays> {
  const res = await request.get('/api/workspaces');
  expect(res.ok(), await res.text()).toBeTruthy();
  const list = (await res.json()) as Array<Record<string, unknown>>;
  const found = list.find(w => w.id === id);
  expect(found, `workspace ${id} in the saved list`).toBeTruthy();
  return arraysOf(found!);
}

/**
 * A3, against the real app and the real save round trip.
 *
 * Undo compares the live lineup arrays to a fingerprint taken right after the run. This spec
 * checks, end to end through the server, that:
 *  - the apply is saved, and the arrays the app holds still match the fingerprint, so Undo
 *    writes at once and shows no "Lineup changed" message;
 *  - the Undo is saved too, and the saved arrays equal the arrays from before the apply.
 * The edit-after-apply side is covered by tests/optimizerUndoTrackA.test.ts.
 *
 * Run against a COPY of the data (playwright.config.ts makes one unless OMNI_DATA_DIR is set):
 *   PORT=<free> npx playwright test tests/e2e/optimize-undo.spec.ts
 */
test('Undo after an All-teams apply restores the saved lineup arrays', async ({ page, request }) => {
  const stamp = Date.now();
  const id = `ui-a3-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI A3 ${stamp}`,
      createdAt: stamp,
      // Result ids are unique across workspaces, so make this copy's own.
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  try {
    // The arrays as the server holds them before the apply. This is what Undo must restore.
    const preApply = await savedArrays(request, id);

    await page.addInitScript(workspaceId => {
      localStorage.setItem('omni-active-workspace-id', workspaceId);
      localStorage.setItem('omni-active-gender', 'Men');
    }, id);
    await page.goto('/manager');
    await page.getByRole('tab', { name: /Optimize/ }).click();

    const whatIf = page.getByLabel('What-if');
    if (!(await whatIf.isChecked())) await whatIf.check();
    const team = page.getByRole('combobox', { name: 'Team', exact: true }).first();
    await team.selectOption({ label: HOME_TEAM });

    await page.getByRole('button', { name: 'All teams…' }).click();
    await page.getByRole('button', { name: /Run optimizer/ }).click();
    const apply = page.getByRole('button', { name: /Apply to workspace/ });
    await expect(apply).toBeEnabled({ timeout: 30_000 });

    // The debounced save sends the applied arrays. Capture that request, so the spec knows what
    // "applied" means without guessing it.
    const isSave = (r: { method(): string; url(): string }) => r.method() === 'PUT' && r.url().endsWith(`/api/workspaces/${id}`);
    const applySave = page.waitForRequest(isSave);
    await apply.click();
    // A patch holds only the fields it changed; the rest stay as they were saved.
    const applied = arraysOf({ ...preApply, ...((await applySave).postDataJSON() as Record<string, unknown>) });
    // The run really changed something, or the rest of this spec proves nothing.
    expect(applied).not.toEqual(preApply);

    const undo = page.getByRole('button', { name: 'Undo this optimize' });
    await expect(undo).toBeVisible();
    // Wait for the saved arrays to equal the applied arrays. No fixed sleep.
    await expect.poll(() => savedArrays(request, id), { timeout: 15_000 }).toEqual(applied);

    const undoSave = page.waitForRequest(isSave);
    await undo.click();
    await undoSave;

    await expect(page.getByText('Lineup changed since the run. Undo would discard later edits.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo anyway' })).toHaveCount(0);
    // Undone: the summary (and with it the Undo button) is gone, and the app said so.
    await expect(undo).toHaveCount(0);
    await expect(page.getByText('Undid: All teams optimize')).toBeVisible();

    // The saved arrays are the arrays from before the apply.
    await expect.poll(() => savedArrays(request, id), { timeout: 15_000 }).toEqual(preApply);
  } finally {
    await request.delete(`/api/workspaces/${id}`);
  }
});
