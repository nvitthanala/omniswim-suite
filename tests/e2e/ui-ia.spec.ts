import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/chart-workspace.json'), 'utf8')) as Record<string, unknown>;
const themes = ['midnight', 'deck-light', 'oled'] as const;
const widths = [1440, 800] as const;

async function captureScreenshot(page: import('@playwright/test').Page, name: string) {
  await page.screenshot({ path: `docs/reference/ui-phase-1/after/${name}.png`, fullPage: true });
  await page.screenshot({ path: `test-results/ui-ia/phase-1/${name}.png`, fullPage: true });
}

test('Phase 1 IA regressions and theme/width screenshots', async ({ page, request }) => {
  test.setTimeout(300_000);
  mkdirSync('docs/reference/ui-phase-1/after', { recursive: true });
  mkdirSync('test-results/ui-ia/phase-1', { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const stamp = Date.now();
  const id = `ui-ia-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI IA ${stamp}`,
      createdAt: stamp,
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  const createdBody = await created.text();
  expect(created.ok(), createdBody).toBeTruthy();
  const createdWorkspace = JSON.parse(createdBody) as { id: string };

  for (const theme of themes) {
    await page.addInitScript(value => {
      localStorage.setItem('omni-preferences', JSON.stringify({
        themePreset: value, colorMode: value === 'deck-light' ? 'light' : 'dark',
        textScale: 'default', reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
      }));
    }, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });

      await page.goto(`/matrix?workspace=${createdWorkspace.id}`);
      const standingsTab = page.getByRole('tab', { name: /Standings/ });
      await expect(standingsTab).toBeVisible();
      await expect(page.getByLabel('PDF column format')).toHaveCount(0);
      await standingsTab.click();
      const matrixGender = page.locator('nav[aria-label="Gender"] button[aria-pressed]').nth(1);
      await matrixGender.click();
      await expect(page.getByRole('tab', { name: /Standings/ })).toHaveAttribute('aria-selected', 'true');
      await page.reload();
      await expect(page.getByRole('tab', { name: /Standings/ })).toHaveAttribute('aria-selected', 'true');
      await captureScreenshot(page, `${theme}-${width}-matrix`);
      // Phase 5: scoring lives on the Meet step; there is no Score step.
      await expect(page.getByRole('tab')).toHaveCount(3);
      await expect(page.getByRole('tab', { name: /Score/ })).toHaveCount(0);
      await page.getByRole('tab', { name: /Meet/ }).click();
      await expect(page.getByLabel('PDF column format')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit scoring rules' })).toBeVisible();
      await captureScreenshot(page, `${theme}-${width}-matrix-meet`);
      await page.getByRole('tab', { name: /Analyze/ }).click();
      await captureScreenshot(page, `${theme}-${width}-matrix-analyze`);

      await startOnWorkspace(page, createdWorkspace.id);
      await page.goto('/manager');
      await expect(page.getByRole('tab', { name: /Athletes/ })).toBeVisible();
      await captureScreenshot(page, `${theme}-${width}-manager-athletes`);
      const genderButtons = page.locator('nav[aria-label="Gender"] button[aria-pressed]');
      await expect(genderButtons).toHaveCount(2);
      await expect(genderButtons.first()).toBeVisible();
      await expect(genderButtons.nth(1)).toBeVisible();
      await page.setViewportSize({ width: 700, height: 1000 });
      await expect(genderButtons.first()).toContainText('M');
      await expect(genderButtons.nth(1)).toContainText('W');
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole('tab', { name: /Optimize/ }).click();
      const whatIf = page.getByLabel('What-if');
      if (await whatIf.isChecked()) await whatIf.uncheck();
      // Phase 4: the all-teams optimizer lives on the Optimize step, not in the header.
      await expect(page.getByRole('button', { name: 'Batch optimizer' })).toHaveCount(0);
      const batchButton = page.getByRole('button', { name: 'All teams…' });
      await expect(batchButton).toBeDisabled();
      const recalc = page.getByRole('button', { name: 'Recalc' });
      await recalc.click();
      await expect(page.getByRole('tab', { name: /Optimize/ })).toHaveAttribute('aria-selected', 'true');
      await genderButtons.nth(1).click();
      await expect(page.getByRole('tab', { name: /Optimize/ })).toHaveAttribute('aria-selected', 'true');
      await captureScreenshot(page, `${theme}-${width}-manager`);
      // The fixture has no women's results, so Women shows "Bring in swimmers first" with no optimizer
      // action. Go back to Men, where the roster exists.
      await genderButtons.first().click();
      await expect(page.getByRole('tab', { name: /Optimize/ })).toHaveAttribute('aria-selected', 'true');
      if (!(await whatIf.isChecked())) await whatIf.check();
      await expect(batchButton).toBeEnabled();
      await batchButton.click();
      await expect(page.getByRole('dialog', { name: 'Optimize all teams' })).toBeVisible();
      await captureScreenshot(page, `${theme}-${width}-batch-optimizer`);
      await page.keyboard.press('Escape');

      await page.goto('/settings', { waitUntil: 'domcontentloaded' });
      const preview = page.locator('aside[aria-hidden="true"]');
      await expect(preview).toHaveAttribute('inert', '');
      const previewButton = preview.locator('button');
      await expect(previewButton).toBeVisible();
      await previewButton.evaluate(button => (button as HTMLElement).focus());
      expect(await previewButton.evaluate(button => document.activeElement === button)).toBe(false);
      await captureScreenshot(page, `${theme}-${width}-settings`);
    }
  }
  expect(pageErrors).toEqual([]);
});

/* ------------------------------------------------------------------------ */
/* Phase 3: Manager Athletes step and shared team bar                        */
/* ------------------------------------------------------------------------ */

type PhasePage = import('@playwright/test').Page;
type PhaseRequest = import('@playwright/test').APIRequestContext;

async function createPhaseWorkspace(
  request: PhaseRequest,
  label: string,
  phase: 3 | 4 | 5 = 3
): Promise<{ id: string; name: string }> {
  const stamp = Date.now();
  const id = `ui-p${phase}-${label}-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI Phase ${phase} ${label} ${stamp}`,
      createdAt: stamp,
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  const body = await created.text();
  expect(created.ok(), body).toBeTruthy();
  return { id: (JSON.parse(body) as { id: string }).id, name: `UI Phase ${phase} ${label} ${stamp}` };
}

/** Choose a team on whichever UI is present: the Phase 3 team bar, or the pre-Phase-3 per-step pickers. */
async function chooseTeam(page: PhasePage, team: string) {
  const bar = page.getByRole('combobox', { name: /^Team( to optimize)?$/ });
  const button = page.getByRole('button', { name: team, exact: true });
  // Scoring fills the team list asynchronously; wait for either control to offer the team.
  // The pre-Phase-3 Optimize step names its select "Team to optimize", so a step can offer no control at all
  // when the team was already chosen on an earlier step.
  const offered = bar.first().locator('option', { hasText: team }).or(button.first()).first();
  if (!(await offered.waitFor({ state: 'attached', timeout: 15_000 }).then(() => true, () => false))) return;
  if (await button.count()) {
    await button.first().click();
    return;
  }
  await bar.first().selectOption({ label: team });
}

/**
 * Make `id` the workspace the shell starts on, through the same storage key the
 * app reads. Before A1 (2026-10-03), a cold `/manager?workspace=<id>` load sent the
 * shell's workspace/URL sync into a swap loop; that is fixed and covered by
 * `workspace-route-sync.spec.ts`. This helper stays because many callers use it.
 */
async function startOnWorkspace(page: PhasePage, id: string) {
  await page.addInitScript(workspaceId => {
    localStorage.setItem('omni-active-workspace-id', workspaceId);
    localStorage.setItem('omni-active-gender', 'Men');
  }, id);
}

/** Open the Manager and wait until the header names the workspace. */
async function openManagerOn(page: PhasePage, id: string, name: string) {
  await startOnWorkspace(page, id);
  await page.goto('/manager');
  await expect(page.locator('header')).toContainText(name.slice(0, 18));
}

const PHASE3_SHOT_DIR = process.env.PHASE3_SHOT_DIR === 'before' ? 'before' : 'after';
// A team in the chart fixture's meet results.
const PHASE3_SHOT_TEAM = 'Alpha University';

test('Phase 3 Manager screenshots', async ({ page, request }) => {
  test.setTimeout(300_000);
  const dir = `docs/reference/ui-phase-3/${PHASE3_SHOT_DIR}`;
  mkdirSync(dir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id, name } = await createPhaseWorkspace(request, 'shots');
  const steps = [
    { tab: /Source|Athletes/, name: 'athletes', team: false },
    { tab: /Lineup/, name: 'lineup', team: true },
    { tab: /Relays/, name: 'relays', team: true },
    { tab: /Optimize/, name: 'optimize', team: true },
  ];
  for (const theme of themes) {
    await page.addInitScript(value => {
      localStorage.setItem('omni-preferences', JSON.stringify({
        themePreset: value, colorMode: value === 'deck-light' ? 'light' : 'dark',
        textScale: 'default', reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
      }));
    }, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await openManagerOn(page, id, name);
      for (const step of steps) {
        const tab = page.getByRole('tab', { name: step.tab });
        await tab.click();
        if (step.team) await chooseTeam(page, PHASE3_SHOT_TEAM);
        // Wait for a settled Manager on the right workspace, never a loading skeleton.
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('heading', { name: 'Team management' })).toBeVisible();
        await expect(page.locator('header')).toContainText(name.slice(0, 18));
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${dir}/${theme}-${width}-${step.name}.png`, fullPage: true });
        if (step.name === 'athletes' && PHASE3_SHOT_DIR === 'after') {
          // The Athletes step with every "More tools" disclosure open (no before equivalent).
          const panel = page.getByRole('tabpanel');
          await panel.getByRole('button', { name: /^More tools/ }).click();
          for (const tool of [/Copy meet and scoring rules/, /Changes from the loaded meet/, /Working copy changes/, /Import a scoring plan/]) {
            await panel.getByRole('button', { name: tool }).click();
          }
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${dir}/${theme}-${width}-athletes-tools-open.png`, fullPage: true });
          await panel.getByRole('button', { name: /^More tools/ }).click();
        }
      }
    }
  }
  expect(pageErrors).toEqual([]);
});

test('Phase 3 Athletes step, shared team bar and Export entries menu', async ({ page, request }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const stamp = Date.now();
  const id = `ui-p3-ia-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI Phase 3 IA ${stamp}`,
      createdAt: stamp,
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
      // One planned entry so both exports have something to write.
      meetEntryPlans: [{
        id: `${id}-plan-1`, name: 'Test Swimmer', team: 'Alpha University', gender: 'Men',
        classYear: 'FR', event: '50 Freestyle', time: '21.50', timeType: 'SCY', source: 'manual', active: true,
      }],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.addInitScript(() => {
    localStorage.setItem('omni-preferences', JSON.stringify({
      themePreset: 'midnight', colorMode: 'dark', textScale: 'default',
      reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
    }));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await startOnWorkspace(page, id);
  await page.goto('/manager');

  // The first step is Athletes, not Source.
  await expect(page.getByRole('tab', { name: /Athletes/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /Source/ })).toHaveCount(0);

  // At most 8 buttons above the fold inside the Athletes step.
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('button', { name: 'Edit scoring rules' })).toBeVisible();
  const aboveTheFold = await panel.evaluate(el => {
    const fold = window.innerHeight;
    return Array.from(el.querySelectorAll('button'))
      .filter(button => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < fold;
      })
      .map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim().slice(0, 40));
  });
  console.log('Athletes buttons above the fold:', JSON.stringify(aboveTheFold));
  expect(aboveTheFold.length).toBeLessThanOrEqual(8);

  // "More tools" starts collapsed and holds four disclosures, each collapsed, each toggling aria-expanded.
  const moreTools = panel.getByRole('button', { name: /^More tools/ });
  await expect(moreTools).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByRole('button', { name: /Import a scoring plan/ })).toHaveCount(0);
  await moreTools.click();
  await expect(moreTools).toHaveAttribute('aria-expanded', 'true');
  const toolNames = [
    /Copy meet and scoring rules from another workspace/,
    /Changes from the loaded meet/,
    /Working copy changes/,
    /Import a scoring plan/,
  ];
  for (const name of toolNames) {
    const trigger = panel.getByRole('button', { name });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const controlled = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
    await expect(controlled).toBeVisible();
    await trigger.click();
    await expect(controlled).toBeHidden();
  }

  // The two copy-meet paths say what each copies.
  await panel.getByRole('button', { name: toolNames[0] }).click();
  await expect(panel.getByText(/Does not copy a psych sheet/)).toBeVisible();

  // Exactly one team select on Lineup, Relays and Optimize, before and after choosing a team.
  const teamSelects = page.getByRole('combobox', { name: /team/i });
  for (const step of ['Lineup', 'Relays', 'Optimize']) {
    await page.getByRole('tab', { name: new RegExp(step) }).click();
    await expect(teamSelects).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Alpha University', exact: true })).toHaveCount(0);
    await chooseTeam(page, 'Alpha University');
    await expect(teamSelects).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: 'Team', exact: true })).toHaveValue('Alpha University');
  }

  // One Export entries menu; both formats download.
  await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export HyTek' })).toHaveCount(0);
  const menu = page.getByRole('button', { name: 'Export entries' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  for (const [item, suffix] of [['CSV (spreadsheet)', '.csv'], ['HyTek entry list', '']] as const) {
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: item }).click(),
    ]);
    expect(download.suggestedFilename()).toContain('entries');
    if (suffix) expect(download.suggestedFilename().endsWith(suffix)).toBe(true);
  }

  expect(pageErrors).toEqual([]);
});

/* ------------------------------------------------------------------------ */
/* Phase 4: Optimize owns all optimizers                                     */
/* ------------------------------------------------------------------------ */

const PHASE4_SHOT_DIR = process.env.PHASE4_SHOT_DIR === 'before' ? 'before' : 'after';

test('Phase 4 Optimize and Lineup screenshots', async ({ page, request }) => {
  test.setTimeout(300_000);
  const dir = `docs/reference/ui-phase-4/${PHASE4_SHOT_DIR}`;
  mkdirSync(dir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id, name } = await createPhaseWorkspace(request, 'shots', 4);
  for (const theme of themes) {
    await page.addInitScript(value => {
      localStorage.setItem('omni-preferences', JSON.stringify({
        themePreset: value, colorMode: value === 'deck-light' ? 'light' : 'dark',
        textScale: 'default', reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
      }));
    }, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await openManagerOn(page, id, name);
      for (const step of [{ tab: /Lineup/, name: 'lineup' }, { tab: /Optimize/, name: 'optimize' }]) {
        const tab = page.getByRole('tab', { name: step.tab });
        await tab.click();
        await chooseTeam(page, PHASE3_SHOT_TEAM);
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('heading', { name: 'Team management' })).toBeVisible();
        await expect(page.locator('header')).toContainText(name.slice(0, 18));
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${dir}/${theme}-${width}-${step.name}.png`, fullPage: true });
        if (step.name === 'optimize' && PHASE4_SHOT_DIR === 'after') {
          // "More options" open, then the All teams dialog (neither exists before Phase 4).
          await page.getByRole('button', { name: 'More options' }).click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${dir}/${theme}-${width}-optimize-more-options.png`, fullPage: true });
          await page.getByRole('button', { name: 'All teams…' }).click();
          await expect(page.getByRole('dialog', { name: 'Optimize all teams' })).toBeVisible();
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${dir}/${theme}-${width}-optimize-all-teams-dialog.png`, fullPage: true });
          await page.keyboard.press('Escape');
        }
      }
    }
  }
  expect(pageErrors).toEqual([]);
});

test('Phase 4 Optimize owns the optimizers and Lineup only links to it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id, name } = await createPhaseWorkspace(request, 'ia', 4);
  await page.addInitScript(() => {
    localStorage.setItem('omni-preferences', JSON.stringify({
      themePreset: 'midnight', colorMode: 'dark', textScale: 'default',
      reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
    }));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openManagerOn(page, id, name);

  // The header no longer carries a Batch optimizer button on any step.
  for (const step of ['Athletes', 'Lineup', 'Relays', 'Optimize']) {
    await page.getByRole('tab', { name: new RegExp(step) }).click();
    await expect(page.getByRole('button', { name: /Batch optimizer/i })).toHaveCount(0);
  }

  // Lineup: one "Optimize this lineup" link; the old optimizer buttons are gone.
  await page.getByRole('tab', { name: /Lineup/ }).click();
  await chooseTeam(page, PHASE3_SHOT_TEAM);
  const lineupPanel = page.getByRole('tabpanel');
  await expect(lineupPanel.getByRole('button', { name: 'Optimize this lineup' })).toHaveCount(1);
  await expect(lineupPanel.getByRole('button', { name: 'Best roster' })).toHaveCount(0);
  await expect(lineupPanel.getByRole('button', { name: 'All teams', exact: true })).toHaveCount(0);
  await lineupPanel.getByRole('button', { name: 'Optimize this lineup' }).click();
  await expect(page.getByRole('tab', { name: /Optimize/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Team', exact: true })).toHaveValue(PHASE3_SHOT_TEAM);

  // Optimize: This team primary, All teams dialog, Quick optimize under More options.
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('button', { name: 'Optimize team' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Classic' })).toHaveCount(0);
  const more = panel.getByRole('button', { name: 'More options' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByRole('button', { name: 'Quick optimize (greedy)' })).toBeHidden();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('button', { name: 'Quick optimize (greedy)' })).toBeVisible();

  // The All teams dialog opens from here, names Drop seniors, and closes on Escape.
  await panel.getByRole('button', { name: 'All teams…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Optimize all teams' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Drop seniors is off');
  await expect(dialog.getByRole('button', { name: 'Apply to workspace' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Keyboard access: the All teams action takes focus and opens with Enter.
  await panel.getByRole('button', { name: 'All teams…' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');

  expect(pageErrors).toEqual([]);
});

/* ------------------------------------------------------------------------ */
/* Phase 5: Matrix Meet / Standings / Analyze                                */
/* ------------------------------------------------------------------------ */

const PHASE5_SHOT_DIR = process.env.PHASE5_SHOT_DIR === 'before' ? 'before' : 'after';

test('Phase 5 Matrix screenshots', async ({ page, request }) => {
  test.setTimeout(300_000);
  const dir = `docs/reference/ui-phase-5/${PHASE5_SHOT_DIR}`;
  mkdirSync(dir, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id } = await createPhaseWorkspace(request, 'shots', 5);
  // Before Phase 5 the first step is Load and a Score step sits between it and Standings.
  const steps = [
    { tab: /\d\. (Load|Meet)/, name: 'meet', optional: false },
    { tab: /\d\. Score/, name: 'score', optional: true },
    { tab: /\d\. Standings/, name: 'standings', optional: false },
    { tab: /\d\. Analyze/, name: 'analyze', optional: false },
  ];
  for (const theme of themes) {
    await page.addInitScript(value => {
      localStorage.setItem('omni-preferences', JSON.stringify({
        themePreset: value, colorMode: value === 'deck-light' ? 'light' : 'dark',
        textScale: 'default', reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
      }));
    }, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await startOnWorkspace(page, id);
      await page.goto('/matrix');
      await expect(page.getByRole('tab', { name: /Standings/ })).toBeVisible();
      for (const step of steps) {
        const tab = page.getByRole('tab', { name: step.tab });
        if (step.optional && (await tab.count()) === 0) continue;
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${dir}/${theme}-${width}-${step.name}.png`, fullPage: true });
      }
    }
  }
  expect(pageErrors).toEqual([]);
});

test('Phase 5 Matrix has three steps and scoring lives on Meet', async ({ page, request }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id } = await createPhaseWorkspace(request, 'ia', 5);
  await page.addInitScript(() => {
    localStorage.setItem('omni-preferences', JSON.stringify({
      themePreset: 'midnight', colorMode: 'dark', textScale: 'default',
      reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
    }));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await startOnWorkspace(page, id);
  await page.goto('/matrix');

  // Three tabs, in order; no Score or Load step.
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toContainText('Meet');
  await expect(tabs.nth(1)).toContainText('Standings');
  await expect(tabs.nth(2)).toContainText('Analyze');
  await expect(page.getByRole('tab', { name: /\d\. (Score|Load)/ })).toHaveCount(0);

  // A workspace with a meet opens on Standings, with the new wording.
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Team standings' })).toBeVisible();
  await expect(page.getByText('Performance Matrix')).toHaveCount(0);
  const chartGroup = page.getByRole('group', { name: 'Points chart grouping' }).first();
  await expect(chartGroup.locator('xpath=..')).toContainText('Chart:');
  await expect(chartGroup.getByRole('button')).toHaveText(['By event', 'By class']);
  const listGroup = page.getByRole('group', { name: 'Team matrix grouping' }).first();
  await expect(listGroup.locator('xpath=..')).toContainText('List:');
  await expect(listGroup.getByRole('button')).toHaveText(['By event', 'By swimmer']);
  await expect(page.getByText(/\bBase [+-]/)).toHaveCount(0);

  // Meet holds the files, the scoring summary and the full scoring-rules dialog.
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('PDF column format')).toBeVisible();
  await expect(page.getByText('Scoring rules', { exact: true })).toBeVisible();
  const edit = page.getByRole('button', { name: 'Edit scoring rules' });
  await edit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Scoring rules' });
  await expect(dialog).toBeVisible();
  for (const field of ['Scorer eligibility', 'Number of scoring places', 'Scoring view', 'Scorer cap scope', 'Relay multiplier']) {
    await expect(dialog.getByLabel(field).first()).toBeAttached();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // A stored pre-Phase-5 step lands on Meet, and the current id is written back.
  await tabs.nth(2).click();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(workspaceId => sessionStorage.setItem(`matrix-step:${workspaceId}`, 'score'), id);
  await page.reload();
  await expect(page.getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(workspaceId => sessionStorage.getItem(`matrix-step:${workspaceId}`), id)).toBe('meet');

  // The step survives a gender switch and a reload (Phase 1 behaviour, now with three steps).
  await page.getByRole('tab').nth(1).click();
  await page.locator('nav[aria-label="Gender"] button[aria-pressed]').nth(1).click();
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');

  expect(pageErrors).toEqual([]);
});
