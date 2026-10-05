/**
 * Launch the REAL built extension in real Chromium, against the fake SwimCloud and the real app.
 *
 * Isolation:
 * - `context.route('**\/*')` answers https://www.swimcloud.com from the fake, lets the app origin
 *   through, and ABORTS everything else. Every abort is recorded and the test fails on any.
 * - `--host-resolver-rules` maps every host except 127.0.0.1 to "not found", so even a request that
 *   Playwright cannot see (the extension's service worker) cannot leave the machine.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type APIRequestContext, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { FAKE_ORIGIN, FakeSwimCloud } from './fakeSwimCloud';

export const EXTENSION_DIR = join(import.meta.dirname, '..', '..', 'extensions', 'swimcloud-companion');
export const APP_PORT = Number(process.env.HARNESS_PORT ?? 3711);
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const TOKEN_KEY = 'omniswimPairingToken';
const PORT_KEY = 'omniswimAppPort';

export const PANEL = '#omniswim-multiteam-panel';

export interface Harness {
  readonly context: BrowserContext;
  readonly fake: FakeSwimCloud;
  /** Requests the route handler refused. A test must end with this empty. */
  readonly aborted: string[];
  readonly worker: Worker;
  newTeamPage(teamId?: string): Promise<Page>;
  close(): Promise<void>;
}

export async function launchHarness(request: APIRequestContext): Promise<Harness> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'omniswim-harness-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    ],
  });
  const fake = new FakeSwimCloud();
  const aborted: string[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === FAKE_ORIGIN) {
      const reply = fake.answer(route.request().url());
      await route.fulfill({
        status: reply.status,
        contentType: reply.contentType ?? 'text/html',
        headers: reply.headers,
        body: reply.body,
      });
      return;
    }
    if (url.origin === APP_ORIGIN) {
      await route.continue();
      return;
    }
    aborted.push(route.request().url());
    await route.abort();
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  const token = await pairingToken(request);
  await worker.evaluate(
    async ([tokenKey, portKey, value, port]) => {
      await (globalThis as unknown as { chrome: { storage: { local: { set(items: object): Promise<void> } } } }).chrome.storage.local.set({ [tokenKey]: value, [portKey]: port });
    },
    [TOKEN_KEY, PORT_KEY, token, APP_PORT] as const
  );

  return {
    context,
    fake,
    aborted,
    worker,
    async newTeamPage(teamId = '412') {
      const page = await context.newPage();
      await page.goto(`${FAKE_ORIGIN}/team/${teamId}/`);
      return page;
    },
    async close() {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function pairingToken(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${APP_ORIGIN}/api/swimcloud/pairing-token`);
  expect(res.ok(), 'the app serves a pairing token').toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

/* -------------------------------------------------------------------------- */
/* The app's capture store, read through its own routes                         */
/* -------------------------------------------------------------------------- */

export interface StoredCapture {
  captureId: string;
  label?: string;
  teamName?: string;
  completeness: string;
  plannedPageCount: number;
  pages: Array<{ canonicalUrl: string; resourceKind: string; outcome: string }>;
}

export async function listCaptures(request: APIRequestContext): Promise<StoredCapture[]> {
  const token = await pairingToken(request);
  const res = await request.get(`${APP_ORIGIN}/api/swimcloud/captures`, { headers: { 'X-Omniswim-Capture-Token': token } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as StoredCapture[];
}

/** Remove every capture the harness made, so each scenario starts with an empty store. */
export async function clearCaptures(request: APIRequestContext): Promise<void> {
  const token = await pairingToken(request);
  for (const c of await listCaptures(request)) {
    await request.delete(`${APP_ORIGIN}/api/swimcloud/captures/${encodeURIComponent(c.captureId)}`, { headers: { 'X-Omniswim-Capture-Token': token } });
  }
}

/* -------------------------------------------------------------------------- */
/* Driving the Multi-team crawl panel                                           */
/* -------------------------------------------------------------------------- */

export async function openPanel(page: Page): Promise<void> {
  // The button's aria-label replaces its visible text as its accessible name, so find it by id.
  await page.locator('#omniswim-multiteam-button').click();
  await expect(page.locator(PANEL)).toBeVisible();
}

/** Paste the links, parse them and read the season lists. Waits for the season choice. */
export async function pasteAndRead(page: Page, links: readonly string[], teamIds: readonly string[]): Promise<void> {
  const panel = page.locator(PANEL);
  await panel.getByRole('textbox').fill(links.join('\n'));
  await panel.getByRole('button', { name: 'Parse links' }).click();
  await expect(panel.getByText(`Teams to read: ${teamIds.join(', ')}`)).toBeVisible();
  await panel.getByRole('button', { name: 'Read season lists' }).click();
}

export async function waitForSeasonChoice(page: Page, teamIds: readonly string[]): Promise<void> {
  for (const id of teamIds) await expect(page.locator(`${PANEL}-season-${id}`)).toBeVisible({ timeout: 60_000 });
}

export async function startCrawl(page: Page): Promise<void> {
  await page.locator(PANEL).getByRole('button', { name: 'Start crawl' }).click();
}

/** The run is over when the Cancel button has turned back into Close and is enabled. */
export async function waitForRunEnd(page: Page, timeout = 300_000): Promise<void> {
  await expect(page.locator(PANEL).getByRole('button', { name: 'Close', exact: true })).toBeEnabled({ timeout });
}

export async function panelText(page: Page): Promise<string> {
  return (await page.locator(PANEL).innerText()).replace(/\s+/g, ' ');
}

/** The whole path for one run: paste, read, choose (the default season), start. */
export async function runToStart(page: Page, teamIds: readonly string[]): Promise<void> {
  await openPanel(page);
  await pasteAndRead(page, teamIds.map(id => `${FAKE_ORIGIN}/team/${id}/`), teamIds);
  await waitForSeasonChoice(page, teamIds);
  await startCrawl(page);
}
