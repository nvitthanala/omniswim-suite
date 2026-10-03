import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

// Generated once from `buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] })` in
// tests/optimizerStepFixtures.ts: a meet where the optimizer really gains. Synthetic data.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/optimize-undo-workspace.json'), 'utf8')) as Record<string, unknown>;
const HOME_TEAM = 'Henderson State University';

/**
 * A3, against the real app and the real save round trip.
 *
 * Undo compares the live lineup arrays to a fingerprint taken right after the run. This spec
 * checks the false-positive side: after a run is applied and saved, the arrays the app holds
 * still match the fingerprint, so Undo writes at once and shows no "Lineup changed" message.
 * The edit-after-apply side is covered by tests/optimizerUndoTrackA.test.ts.
 *
 * Run against a COPY of the data:
 *   OMNI_DATA_DIR=<copy> PORT=<free> npx playwright test tests/e2e/optimize-undo.spec.ts
 */
test('Undo right after an All-teams apply writes at once, with no changed-lineup message', async ({ page, request }) => {
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
  await apply.click();

  const undo = page.getByRole('button', { name: 'Undo this optimize' });
  await expect(undo).toBeVisible();
  // Let the debounced save and its server response land before Undo reads the arrays.
  await page.waitForTimeout(2500);
  await undo.click();

  await expect(page.getByText('Lineup changed since the run. Undo would discard later edits.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo anyway' })).toHaveCount(0);
  // Undone: the summary (and with it the Undo button) is gone.
  await expect(undo).toHaveCount(0);

  } finally {
    await request.delete(`/api/workspaces/${id}`);
  }
});
