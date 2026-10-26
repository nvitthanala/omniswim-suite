/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The S3 harness (plans/2026-10-25/D3-STORAGE-AND-BUILD.md section 3, "The harness that settles S3").
 *
 * It loads apps/extension/dist-harness (the harness build, which has the osxHarness probe) unpacked in Chromium and opens a SYNTHETIC simulator page that the
 * route serves from tests/extension-harness/fixtures/simulator. Every other request is aborted, and
 * `--host-resolver-rules` blocks every host but 127.0.0.1, so nothing reaches swimcloud.com.
 *
 * Two variants: the page has no CSP header, or `default-src 'self'; script-src 'self'`. Per variant:
 *   1. the docked iframe renders;
 *   2. its worker loads highs.wasm and solves a 2-variable LP and MIP;
 *   3. the iframe and the dashboard tab read the same IndexedDB record, written through the repo;
 *   4. the overlay <-> iframe port delivers a message each way;
 *   5. the page's styleSheets.length and one element's computed style match a page the extension
 *      did not inject into.
 *
 * Each assertion is recorded on its own, so one failure does not hide the others. A variant-2
 * failure is a finding (D3 section 3, CSP decision table), not something to retry or weaken.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Frame, Page } from '@playwright/test';

const root = join(import.meta.dirname, '..', '..');
/** The harness build (scripts/run-extension-harness.mjs makes it), not the production dist/. */
const DIST = join(root, 'apps', 'extension', 'dist-harness');
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'simulator');
const ORIGIN = 'https://www.swimcloud.com';
/** The page the content scripts match. */
const SIM_PATH = '/meetsimulator/';
/** The same fixture where no content script matches: the baseline for assertion 5. */
const BASELINE_PATH = '/harness-baseline/';

const VARIANTS = [
  { name: 'variant 1 (no CSP header)', csp: null },
  { name: "variant 2 (CSP default-src 'self'; script-src 'self')", csp: "default-src 'self'; script-src 'self'" },
] as const;

const ASSETS: Record<string, { file: string; type: string }> = {
  '': { file: 'page.html', type: 'text/html; charset=utf-8' },
  'fixture.css': { file: 'fixture.css', type: 'text/css; charset=utf-8' },
  'fixture.js': { file: 'fixture.js', type: 'text/javascript; charset=utf-8' },
};

/** What the test reads from the dashboard's `globalThis.osxHarness` (apps/extension/src/dashboard/harness.ts). */
interface Harness {
  solveLp(lp: string): Promise<{ status: string; objective: number; columns: Record<string, number>; loadMs: number; solveMs: number }>;
  probeUnsupported(): Promise<string>;
  putSetting(key: 'cutCloseThresholdPct', value: number): Promise<unknown>;
  getSetting(key: 'cutCloseThresholdPct'): Promise<{ found: boolean; value?: { key: string; value: number; rev: number; updatedAt: string } }>;
  panel(): { accepted: number; rejected: number; pings: number } | null;
}
type WithHarness = { osxHarness: Harness };

const MODEL_HEAD = 'Maximize\n obj: x + y\nSubject To\n c1: 2 x + 2 y <= 5\nBounds\n 0 <= x <= 3\n 0 <= y <= 3\n';
/** The relaxation peaks at 2.5. With x and y integer the optimum is 2. */
const LP = `${MODEL_HEAD}End\n`;
const MIP = `${MODEL_HEAD}General\n x y\nEnd\n`;

const STYLE_PROBE = () => {
  const props = ['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'marginTop', 'marginLeft', 'paddingTop', 'display', 'borderTopWidth'] as const;
  const read = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, cs[p]]));
  };
  return {
    styleSheets: document.styleSheets.length,
    title: read('#fixture-title'),
    simulator: read('#simulator'),
    button: read('#fixture-button'),
    body: read('body'),
  };
};

interface Result {
  readonly ok: boolean;
  readonly detail: string;
}

test.describe('S3 workers and the docked iframe', () => {
  for (const variant of VARIANTS) {
    test(variant.name, async () => {
      const testInfo = test.info();
      const userDataDir = mkdtempSync(join(tmpdir(), 'omniswim-s3-profile-'));
      let context: BrowserContext | undefined;
      const results = new Map<number, Result>();
      const record = async (n: number, label: string, body: () => Promise<string>): Promise<void> => {
        try {
          results.set(n, { ok: true, detail: await body() });
        } catch (e) {
          results.set(n, { ok: false, detail: e instanceof Error ? e.message.split('\n')[0] ?? String(e) : String(e) });
        }
        const r = results.get(n)!;
        console.log(`[s3] ${variant.name} | ${n}. ${label}: ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail}`);
      };

      try {
        context = await chromium.launchPersistentContext(userDataDir, {
          channel: 'chromium',
          headless: true,
          args: [
            `--disable-extensions-except=${DIST}`,
            `--load-extension=${DIST}`,
            '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
          ],
        });
        const aborted: string[] = [];
        const unexpected: string[] = [];
        const served: string[] = [];
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          // Extension pages are not part of the fake network.
          if (url.protocol === 'chrome-extension:') {
            await route.continue();
            return;
          }
          if (url.origin === ORIGIN && (url.pathname.startsWith(SIM_PATH) || url.pathname.startsWith(BASELINE_PATH))) {
            const base = url.pathname.startsWith(SIM_PATH) ? SIM_PATH : BASELINE_PATH;
            const asset = ASSETS[url.pathname.slice(base.length)];
            if (!asset) {
              unexpected.push(url.href);
              await route.fulfill({ status: 404, contentType: 'text/plain', body: 'no such synthetic asset' });
              return;
            }
            served.push(url.pathname);
            await route.fulfill({
              status: 200,
              contentType: asset.type,
              headers: variant.csp && asset.file === 'page.html' ? { 'Content-Security-Policy': variant.csp } : {},
              body: readFileSync(join(FIXTURE_DIR, asset.file)),
            });
            return;
          }
          aborted.push(url.href);
          await route.abort();
        });

        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
        const extensionId = new URL(worker.url()).host;
        const extensionBase = `chrome-extension://${extensionId}`;

        // Baseline for assertion 5: the same fixture and header on a path no content script matches.
        const isProblem = (type: string, text: string): boolean => type === 'error' || /Content Security Policy|Refused to/i.test(text);
        const baselinePage = await context.newPage();
        const baselineProblems: string[] = [];
        baselinePage.on('console', (m) => {
          if (isProblem(m.type(), m.text())) baselineProblems.push(m.text().slice(0, 240));
        });
        await baselinePage.goto(`${ORIGIN}${BASELINE_PATH}`);
        await baselinePage.waitForSelector('html[data-fixture-ready]');
        const baseline = await baselinePage.evaluate(STYLE_PROBE);
        // The baseline is only a baseline if no content script ran on it.
        const baselineInjected = await baselinePage.locator('[data-osx-host]').count();
        await baselinePage.close();

        const page = await context.newPage();
        const consoleProblems: string[] = [];
        page.on('console', (m) => {
          if (isProblem(m.type(), m.text())) consoleProblems.push(m.text().slice(0, 240));
        });
        await page.goto(`${ORIGIN}${SIM_PATH}`);
        await page.waitForSelector('html[data-fixture-ready]');

        const dockedFrame = (): Frame | undefined => page.frames().find((f) => f.url().startsWith(`${extensionBase}/dashboard.html?host=docked`));
        let frame: Frame | undefined;
        let tab: Page | undefined;

        await record(1, 'docked iframe renders', async () => {
          await expect.poll(() => dockedFrame() !== undefined, { timeout: 15_000, message: `no frame at ${extensionBase}/dashboard.html?host=docked` }).toBe(true);
          frame = dockedFrame()!;
          const box = await page.locator('[data-osx-host] iframe').boundingBox();
          if (!box || box.width < 100 || box.height < 100) throw new Error(`the iframe has no size (${JSON.stringify(box)})`);
          await expect(frame.locator('[data-testid="host"]')).toHaveText('host: docked');
          if (!/#[0-9a-f]{32}$/.test(frame.url())) throw new Error(`the iframe URL has no 32-hex nonce: ${frame.url()}`);
          return `${Math.round(box.width)}x${Math.round(box.height)} px, ${frame.url().replace(/#.*/, '#<nonce>')}`;
        });

        await record(2, 'worker loads highs.wasm and solves', async () => {
          if (!frame) throw new Error('no iframe, so no worker');
          const lp = await frame.evaluate((model) => (globalThis as unknown as WithHarness).osxHarness.solveLp(model), LP);
          const mip = await frame.evaluate((model) => (globalThis as unknown as WithHarness).osxHarness.solveLp(model), MIP);
          const refused = await frame.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.probeUnsupported());
          expect(lp.status).toBe('Optimal');
          expect(lp.objective).toBeCloseTo(2.5, 6);
          expect(mip.status).toBe('Optimal');
          expect(mip.objective).toBeCloseTo(2, 6);
          expect(Number.isInteger(mip.columns.x) && Number.isInteger(mip.columns.y)).toBe(true);
          expect(refused).toMatch(/^optimizer not available/);
          return `LP ${lp.objective}, MIP ${mip.objective} (x=${mip.columns.x}, y=${mip.columns.y}); wasm load ${lp.loadMs.toFixed(0)} ms, solve ${lp.solveMs.toFixed(1)} ms (LP) and ${mip.solveMs.toFixed(1)} ms (MIP); unsupported request refused`;
        });

        await record(3, 'iframe and tab read the same IndexedDB record', async () => {
          if (!frame) throw new Error('no iframe');
          const written = (await frame.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.putSetting('cutCloseThresholdPct', 1.5))) as { rev: number; value: number; updatedAt: string };
          tab = await context!.newPage();
          await tab.goto(`${extensionBase}/dashboard.html?host=tab`);
          await expect(tab.locator('[data-testid="host"]')).toHaveText('host: tab');
          const fromTab = await tab.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.getSetting('cutCloseThresholdPct'));
          expect(fromTab.found).toBe(true);
          expect(fromTab.value).toStrictEqual(written);
          // And back: the tab writes at the rev it read, the iframe reads the new record.
          const rewritten = await tab.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.putSetting('cutCloseThresholdPct', 2.25));
          const fromFrame = await frame.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.getSetting('cutCloseThresholdPct'));
          expect(fromFrame.value).toStrictEqual(rewritten);
          expect(fromFrame.value?.rev).toBe(2);
          return `iframe wrote rev ${written.rev} (${written.value}), tab read it; tab wrote rev 2 (2.25), iframe read it`;
        });

        await record(4, 'overlay <-> iframe port delivers a message', async () => {
          if (!frame) throw new Error('no iframe');
          const hostLoc = page.locator('[data-osx-host]');
          await expect(hostLoc).toHaveAttribute('data-osx-panel', 'connected', { timeout: 10_000 });
          const via = await hostLoc.getAttribute('data-osx-panel-via');
          const attempts = Number(await hostLoc.getAttribute('data-osx-panel-attempts'));
          const pongs = Number(await hostLoc.getAttribute('data-osx-panel-pongs'));
          const stats = await frame.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.panel());
          expect(stats?.accepted).toBeGreaterThanOrEqual(1);
          expect(stats?.pings).toBeGreaterThanOrEqual(1);
          expect(pongs).toBeGreaterThanOrEqual(1);
          // A port with another name is heard by the iframe and left alone.
          if (!tab) throw new Error('no tab');
          await tab.evaluate(() => {
            const c = (globalThis as unknown as { chrome: { runtime: { connect(i: { name: string }): { postMessage(m: unknown): void } } } }).chrome;
            c.runtime.connect({ name: `osx-panel:${'0'.repeat(32)}` }).postMessage({ kind: 'ping', n: 99 });
          });
          await expect
            .poll(async () => (await frame!.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.panel()))?.rejected ?? 0)
            .toBeGreaterThanOrEqual(1);
          const after = await frame.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.panel());
          expect(after?.pings).toBe(stats?.pings);
          expect(await tab.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.panel())).toBeNull();
          if (via !== 'direct') throw new Error(`connect reached the iframe via "${via}", not directly`);
          return `chrome.runtime.connect reached the iframe DIRECTLY (no service-worker relay) on connect attempt ${attempts}: ping -> pong x${pongs}; foreign port name rejected, not answered`;
        });

        await record(5, 'injection leaves styleSheets and computed style unchanged', async () => {
          expect(baselineInjected, 'the baseline page must hold no OmniSwim host').toBe(0);
          expect(await page.locator('[data-osx-host]').count(), 'the simulator page must hold the OmniSwim host').toBe(1);
          const after = await page.evaluate(STYLE_PROBE);
          expect(after.styleSheets).toBe(baseline.styleSheets);
          expect(after.title).toStrictEqual(baseline.title);
          expect(after.simulator).toStrictEqual(baseline.simulator);
          expect(after.button).toStrictEqual(baseline.button);
          expect(after.body).toStrictEqual(baseline.body);
          // P1.shadow: the tokens live in the shadow root, not on the page's :root.
          const shadow = await page.evaluate(() => {
            const root = document.querySelector('[data-osx-host]')?.shadowRoot;
            const wrapper = root?.querySelector('.osx-root');
            return {
              styles: root?.querySelectorAll('style').length ?? 0,
              theme: wrapper?.getAttribute('data-osx-theme') ?? null,
              bg: wrapper ? getComputedStyle(wrapper).getPropertyValue('--osx-bg').trim() : null,
              pageBg: getComputedStyle(document.documentElement).getPropertyValue('--osx-bg').trim(),
            };
          });
          expect(shadow).toStrictEqual({ styles: 1, theme: 'light', bg: '#FAFAFA', pageBg: '' });
          return `styleSheets.length ${after.styleSheets} = baseline ${baseline.styleSheets}; computed style of #fixture-title, #simulator, #fixture-button and body equal; shadow root holds 1 style, theme light, --osx-bg ${shadow.bg}, page :root has no --osx-bg`;
        });

        await record(6, 'nothing left the fake network', async () => {
          expect(aborted, 'aborted requests').toStrictEqual([]);
          expect(unexpected, 'unknown synthetic asset requests').toStrictEqual([]);
          return `${served.length} synthetic responses served, 0 aborted`;
        });

        // Console problems the injection added: those on the simulator page that the baseline page lacks.
        const extra = consoleProblems.filter((m) => !baselineProblems.includes(m));
        console.log(
          `[s3] ${variant.name} | console problems: ${baselineProblems.length} on the baseline page (fixture only), ` +
            `${consoleProblems.length} on the simulator page, ${extra.length} added by the injection${extra.length ? `:\n  ${extra.join('\n  ')}` : ''}`,
        );
        await testInfo.attach('s3-results.json', {
          body: JSON.stringify(Object.fromEntries([...results].map(([n, r]) => [n, r])), null, 2),
          contentType: 'application/json',
        });
      } finally {
        await context?.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }

      const failed = [...results].filter(([, r]) => !r.ok).map(([n, r]) => `${n}: ${r.detail}`);
      expect(failed, 'failed assertions').toStrictEqual([]);
      expect(results.size).toBe(6);
    });
  }
});
