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
 *      did not inject into;
 *   6. nothing left the fake network;
 *   7. at 1280, 800 and 390 px the docked panel stays in the viewport and never covers the page's
 *      narrow-layout "Options" button (a synthetic copy of SwimCloud's measured geometry).
 *   11. (D5 12.10, the AutoBuilder panel) the docked iframe runs a build on simulator config C in the autobuilder worker, Cancel ends a
 *      second build, and the page panel on the simulator page shows both statuses. A screenshot of the panel is attached per theme.
 *      (Numbers 8 to 10 are the snapshot checks above; the next free number is 11.)
 *
 * Each assertion is recorded on its own, so one failure does not hide the others. A variant-2
 * failure is a finding (D3 section 3, CSP decision table), not something to retry or weaken.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Frame, Page } from '@playwright/test';
import { buildSnapshot } from '../helpers/simulatorFixtures';
import { withNumericSwimmerIds } from '../helpers/numericSnapshot';

const root = join(import.meta.dirname, '..', '..');
/** The harness build (scripts/run-extension-harness.mjs makes it), not the production dist/. */
const DIST = join(root, 'apps', 'extension', 'dist-harness');
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'simulator');
const ORIGIN = 'https://www.swimcloud.com';
const UE_SHOT_DIR = join(tmpdir(), 'omniswim-u-e-screenshots');
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

interface MipReply {
  status: string;
  objective: number;
  columns: Record<string, number>;
  incumbent: { objective: number; columns: Record<string, number> } | null;
  dualBound: number | null;
  solveMs: number;
}

/** What the test reads from the dashboard's `globalThis.osxHarness` (apps/extension/src/dashboard/harness.ts). */
interface Harness {
  solveLp(lp: string): Promise<{ status: string; objective: number; columns: Record<string, number>; loadMs: number; solveMs: number }>;
  solveMip(lp: string, options?: Record<string, string | number | boolean>): Promise<MipReply>;
  probeUnsupported(): Promise<string>;
  putSetting(key: 'cutCloseThresholdPct' | 'theme' | 'accent', value: number | string): Promise<unknown>;
  getSetting(key: 'cutCloseThresholdPct'): Promise<{ found: boolean; value?: { key: string; value: number; rev: number; updatedAt: string } }>;
  panel(): { accepted: number; rejected: number; pings: number } | null;
  seedAutoBuild(snapshot: unknown, ownTeamId: string, scorerIds: readonly string[]): Promise<string>;
  lineupCount(): Promise<number>;
  clearSetting(key: 'cutCloseThresholdPct' | 'theme' | 'accent'): Promise<void>;
  lineupIds(): Promise<readonly string[]>;
  storeCounts(): Promise<Readonly<Record<string, number>>>;
  deleteLineupExternally(lineupId: string): Promise<void>;
  workerStarts(): readonly string[];
}
type WithHarness = { osxHarness: Harness };

/**
 * What a page shows that a coach cannot read or reach: text under 4.5:1 against its effective background (3:1 for large text), and a page or the open
 * tab panel that scrolls sideways. Runs inside the page or frame. Disabled controls and hidden elements are skipped.
 */
const VISUAL_AUDIT = (): { low: string[]; sideways: string[] } => {
  type Rgba = { r: number; g: number; b: number; a: number };
  const parse = (value: string): Rgba | null => {
    const srgb = /^color\(srgb ([^)]+)\)$/.exec(value);
    if (srgb) {
      const [rgb = '', alpha = '1'] = (srgb[1] ?? '').split('/');
      const [r = 0, g = 0, b = 0] = rgb.trim().split(/\s+/).map(Number);
      return { r: r * 255, g: g * 255, b: b * 255, a: Number(alpha) };
    }
    const m = /^rgba?\(([^)]+)\)$/.exec(value);
    if (!m) return null;
    const [r = 0, g = 0, b = 0, a = 1] = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c: Rgba): number => { const f = (v: number): number => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const backdrop = (el: Element): Rgba => {
    const chain: Rgba[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) chain.push(c); if (c && c.a === 1) break; }
    let acc: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of chain.reverse()) acc = over(c, acc);
    return acc;
  };
  const low: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    const el = node.parentElement;
    if (!text || !el || el.closest('[hidden], script, style, title, .osx-score-hidden') || (el as HTMLButtonElement).disabled) continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    const fg = parse(el instanceof SVGElement ? style.fill : style.color);
    if (!fg) continue;
    const bg = backdrop(el);
    const fgOver = over(fg, bg);
    const [l1, l2] = [lum(fgOver), lum(bg)].sort((a, b) => b - a) as [number, number];
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const px = parseFloat(style.fontSize);
    const large = px >= 24 || (px >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) low.push(`${ratio.toFixed(2)} "${text.slice(0, 28)}" <${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}>`);
  }
  const sideways: string[] = [];
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    const wide = [...document.body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && getComputedStyle(el).position !== 'fixed');
    sideways.push(`page: ${wide.slice(0, 3).map((el) => `<${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''}> right ${Math.round(el.getBoundingClientRect().right)}`).join(', ')}`);
  }
  for (const panel of document.querySelectorAll('.osx-tabpanel:not([hidden]), .osx-hostpanel')) if (panel.scrollWidth > panel.clientWidth + 1) sideways.push(panel.getAttribute('data-testid') ?? 'panel');
  return { low: [...new Set(low)].slice(0, 8), sideways };
};

/** Size the page, read the expanded docked panel and the fixture Options button, and refuse a panel outside the viewport, over the button, or no larger than the compact one. */
async function expandedGeometry(page: Page, width: number, compact: { width: number; height: number } | null): Promise<string> {
  await page.setViewportSize({ width, height: 800 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const g = await page.evaluate(() => {
    const f = document.querySelector('[data-osx-host]')?.shadowRoot?.querySelector('iframe');
    const fab = document.getElementById('fixture-fab');
    const box = (el: Element | null | undefined) => {
      if (!el || getComputedStyle(el).display === 'none') return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return { panel: box(f), fab: box(fab), vw: document.documentElement.clientWidth, vh: innerHeight };
  });
  const { panel, fab } = g;
  if (!panel) throw new Error(`no expanded panel at ${width} px`);
  if (panel.left < 0 || panel.right > g.vw || panel.top < 0 || panel.bottom > g.vh) throw new Error(`the expanded panel leaves the viewport at ${width} px: ${JSON.stringify(panel)}`);
  if (fab && panel.left < fab.right && fab.left < panel.right && panel.top < fab.bottom && fab.top < panel.bottom) throw new Error(`the expanded panel covers the Options button at ${width} px`);
  const w = panel.right - panel.left;
  const h = panel.bottom - panel.top;
  if (width === 1280 && compact && (w <= compact.width || h <= compact.height)) throw new Error('the expanded panel is not larger than the compact one');
  return `${width} px: ${Math.round(w)}x${Math.round(h)}`;
}

const MODEL_HEAD = 'Maximize\n obj: x + y\nSubject To\n c1: 2 x + 2 y <= 5\nBounds\n 0 <= x <= 3\n 0 <= y <= 3\n';
/** The relaxation peaks at 2.5. With x and y integer the optimum is 2. */
const LP = `${MODEL_HEAD}End\n`;
const MIP = `${MODEL_HEAD}General\n x y\nEnd\n`;

/**
 * A packing model (140 binaries, 12 rows, from a fixed generator) that HiGHS cannot finish in 50 ms: the time limit must stop it.
 * The numbers are synthetic and carry no competition meaning.
 */
function hardMip(): string {
  let seed = 12345;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const n = 140;
  const vars = Array.from({ length: n }, (_, i) => `v${i}`);
  const lines = ['Maximize', ` obj: ${vars.map((v) => `+ ${20 + next(80)} ${v}`).join(' ')}`, 'Subject To'];
  for (let r = 0; r < 12; r++) lines.push(` c${r}: ${vars.map((v) => `+ ${10 + next(60)} ${v}`).join(' ')} <= ${n * 11}`);
  lines.push('Binary', ` ${vars.join(' ')}`, 'End');
  return lines.join('\n');
}

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
      // Variant 1 also runs the record 14 visual sweep, which needs more than the 120 s default.
      if (variant.csp === null) test.setTimeout(360_000);
      const testInfo = test.info();
      const userDataDir = mkdtempSync(join(tmpdir(), 'omniswim-s3-profile-'));
      let context: BrowserContext | undefined;
      const results = new Map<number, Result>();
      const record = async (n: number, label: string, body: () => Promise<string>): Promise<void> => {
        try {
          results.set(n, { ok: true, detail: await body() });
        } catch (e) {
          results.set(n, { ok: false, detail: e instanceof Error ? e.message.split('\n').filter((line) => line.trim() !== '').slice(0, 14).join(' | ') : String(e) });
        }
        const r = results.get(n)!;
        console.log(`[s3] ${variant.name} | ${n}. ${label}: ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail}`);
      };

      try {
        context = await chromium.launchPersistentContext(userDataDir, {
          channel: 'chromium',
          headless: true,
          acceptDownloads: true,
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
          // solve-mip (D5 section 11): the Model API in the same worker. An Optimal MIP returns its columns; a run cut by a 50 ms
          // time limit returns the status, no columns, and a finite dual bound.
          const mipOptimal = await frame.evaluate((model) => (globalThis as unknown as WithHarness).osxHarness.solveMip(model), MIP);
          expect(mipOptimal.status).toBe('Optimal');
          expect(mipOptimal.objective).toBeCloseTo(2, 6);
          expect(Number.isInteger(mipOptimal.columns.x) && Number.isInteger(mipOptimal.columns.y)).toBe(true);
          expect(mipOptimal.incumbent).toBeNull();
          const limited = await frame.evaluate((model) => (globalThis as unknown as WithHarness).osxHarness.solveMip(model, { time_limit: 0.05 }), hardMip());
          expect(limited.status).toBe('Time limit reached');
          expect(limited.columns).toEqual({});
          expect(limited.solveMs).toBeLessThan(5000);
          return `LP ${lp.objective}, MIP ${mip.objective} (x=${mip.columns.x}, y=${mip.columns.y}); wasm load ${lp.loadMs.toFixed(0)} ms, solve ${lp.solveMs.toFixed(1)} ms (LP) and ${mip.solveMs.toFixed(1)} ms (MIP); unsupported request refused; solve-mip Optimal (objective ${mipOptimal.objective}) and cut at 50 ms (${limited.status}, ${limited.solveMs.toFixed(0)} ms, incumbent ${limited.incumbent === null ? 'none' : limited.incumbent.objective}, dual bound ${limited.dualBound})`;
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

        await record(8, 'simulator snapshot re-scores in the docked panel', async () => {
          if (!frame) throw new Error('no iframe');
          const snapshot = buildSnapshot('A').snapshot;
          await page.evaluate((value) => window.postMessage({ source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: value }, location.origin), snapshot);
          await expect(frame.locator('[data-testid="parity"]')).toContainText('Matches SwimCloud');
          const expected = Object.values(buildSnapshot('A').config.totalScores).map((score) => score.points);
          await expect(frame.locator('[data-testid="team-results"] tbody tr')).toHaveCount(expected.length);
          for (const points of expected) await expect(frame.locator('[data-testid="team-results"]')).toContainText(String(points));
          return 'config-A table and parity line rendered';
        });

        await record(9, 'entry point difference renders a mismatch event', async () => {
          if (!frame) throw new Error('no iframe');
          const snapshot = structuredClone(buildSnapshot('A').snapshot);
          if (!snapshot.splashes?.length) throw new Error('config-A has no splashes');
          const entry = snapshot.splashes[0]!;
          snapshot.splashes[0] = { ...entry, points: (entry.points ?? 0) + 1 };
          await page.evaluate((value) => window.postMessage({ source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: value }, location.origin), snapshot);
          await expect(frame.locator('[data-testid="parity"]')).toContainText('differing events');
          await expect(frame.locator('[data-testid="parity"] li').first()).toContainText('engine');
          return 'per-event entry mismatch shown';
        });

        await record(10, 'AdapterError renders not compared with reason', async () => {
          if (!frame) throw new Error('no iframe');
          const snapshot = structuredClone(buildSnapshot('A').snapshot);
          snapshot.settings.eventCourse = 'LCM';
          await page.evaluate((value) => window.postMessage({ source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: value }, location.origin), snapshot);
          await expect(frame.locator('[data-testid="parity"]')).toContainText('Not compared: unsupported_course');
          return 'unsupported LCM case shows AdapterError reason';
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

        await record(7, "panel stays clear of the page's narrow-layout Options button", async () => {
          const seen: string[] = [];
          for (const width of [1280, 800, 390]) {
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const geometry = await page.evaluate(() => {
              const frameEl = document.querySelector('[data-osx-host]')?.shadowRoot?.querySelector('iframe');
              const fab = document.getElementById('fixture-fab');
              const box = (el: Element | null | undefined) => {
                if (!el || getComputedStyle(el).display === 'none') return null;
                const r = el.getBoundingClientRect();
                return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
              };
              return { panel: box(frameEl), fab: box(fab), vw: document.documentElement.clientWidth, vh: innerHeight };
            });
            const { panel, fab, vw, vh } = geometry;
            if (!panel) throw new Error(`no panel at ${width} px`);
            if (panel.left < 0 || panel.right > vw || panel.top < 0 || panel.bottom > vh) throw new Error(`the panel leaves the viewport at ${width} px: ${JSON.stringify(panel)}`);
            if (width < 992 && !fab) throw new Error(`the fixture Options button is hidden at ${width} px, so the check would pass vacuously`);
            if (fab) {
              const overlaps = panel.left < fab.right && fab.left < panel.right && panel.top < fab.bottom && fab.top < panel.bottom;
              if (overlaps) throw new Error(`the panel covers the Options button at ${width} px: panel ${JSON.stringify(panel)}, button ${JSON.stringify(fab)}`);
            }
            seen.push(`${width} px: panel x ${Math.round(panel.left)}-${Math.round(panel.right)}${fab ? `, button x ${Math.round(fab.left)}-${Math.round(fab.right)}` : ', button hidden'}`);
          }
          return seen.join('; ');
        });

        await record(11, 'AutoBuilder runs in its worker, Cancel ends it, the page panel shows the status', async () => {
          if (!frame) throw new Error('no iframe');
          await page.setViewportSize({ width: 1280, height: 800 });
          // Config C, men: own team 58. The fixture names swimmers "T58-S01"; the store takes numeric ids, so they are renamed.
          const snapshot = withNumericSwimmerIds(buildSnapshot('C').snapshot);
          const ownTeamId = '58';
          const scorerIds = [...new Set(JSON.stringify(snapshot).match(/"158\d{3}"/g) ?? [])].map((id) => id.slice(1, -1)).sort().slice(0, 3);
          if (scorerIds.length !== 3) throw new Error(`config C has ${scorerIds.length} swimmers on team 58, not 3`);
          await frame.evaluate(([value, team, ids]) => (globalThis as unknown as WithHarness).osxHarness.seedAutoBuild(value, team, ids), [snapshot, ownTeamId, scorerIds] as const);
          await page.evaluate((value) => window.postMessage({ source: 'osx-bridge', v: 1, kind: 'snapshot', snapshot: value }, location.origin), snapshot);
          await frame.locator('[data-testid="tab-build"]').click();
          const panel = frame.locator('[data-testid="autobuilder-panel"]');
          await expect(panel).toBeVisible({ timeout: 20_000 });
          const status = panel.locator('[data-testid="ab-status"]');
          const pagePanel = page.locator('[data-osx-page-panel]');
          const limit = panel.locator('[data-testid="ab-limit"]');
          await limit.fill('60');

          const starts = (): Promise<readonly string[]> => frame!.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.workerStarts());
          const count = (urls: readonly string[], name: string): number => urls.filter((u) => u.endsWith(name)).length;
          const optimizerBefore = count(await starts(), 'optimizer.worker.js');
          expect(count(await starts(), 'autobuilder.worker.js'), 'no AutoBuilder worker before the first run').toBe(0);

          // Run 1 finishes: the result view shows and the page panel reads "done".
          await panel.locator('[data-testid="ab-run"]').click();
          await expect(panel.locator('[data-testid="ab-result"]')).toBeVisible({ timeout: 90_000 });
          await expect(status).toHaveAttribute('data-phase', 'done');
          await expect(pagePanel).toHaveAttribute('data-osx-auto-build', 'done', { timeout: 10_000 });
          const headline = (await panel.locator('[data-testid="ab-headline"]').innerText()).replace(/\s+/g, ' ');
          // The build ran in its own worker: that script was started, the optimizer worker was reused, and no other worker took the job.
          const afterRun1 = await starts();
          expect(count(afterRun1, 'autobuilder.worker.js'), 'AutoBuilder workers started by run 1').toBe(1);
          expect(count(afterRun1, 'optimizer.worker.js'), 'the optimizer worker is the same instance').toBe(Math.max(optimizerBefore, 1));
          expect(afterRun1.filter((u) => !/(autobuilder|optimizer)\.worker\.js$/.test(u)), 'no other worker').toStrictEqual([]);

          // One screenshot per theme of the panel with a result in it.
          for (const theme of ['light', 'dark'] as const) {
            await frame.evaluate((t) => document.documentElement.setAttribute('data-osx-theme', t), theme);
            await panel.locator('[data-testid="ab-result"]').scrollIntoViewIfNeeded();
            const shot = await page.screenshot();
            const name = `autobuilder-${theme}-${variant.csp === null ? 'v1' : 'v2'}.png`;
            await testInfo.attach(name, { body: shot, contentType: 'image/png' });
            // A passing test drops its attachments; OSX_SHOT_DIR keeps the screenshots for a look.
            if (process.env.OSX_SHOT_DIR) writeFileSync(join(process.env.OSX_SHOT_DIR, name), shot);
          }
          await frame.evaluate(() => document.documentElement.setAttribute('data-osx-theme', 'light'));

          // Run 2 is cancelled as soon as it runs: the worker is stopped and the page panel reads "cancelled".
          await panel.locator('[data-testid="ab-run"]').click();
          await expect(panel.locator('[data-testid="ab-cancel"]')).toBeEnabled({ timeout: 60_000 });
          // Progress arrives from the worker: the solve count rises above 0 while the build runs.
          await expect(status).toHaveText(/Running: [1-9]\d* solves? done/, { timeout: 60_000 });
          // The optimizer worker still answers during the build: a solve resolves while the panel is still in the running phase.
          const during = await frame.evaluate((model) => (globalThis as unknown as WithHarness).osxHarness.solveLp(model), LP);
          expect(during.status).toBe('Optimal');
          expect(during.objective).toBeCloseTo(2.5, 6);
          await expect(status).toHaveAttribute('data-phase', 'running');
          expect(count(await starts(), 'autobuilder.worker.js'), 'the run-1 AutoBuilder worker serves run 2').toBe(1);
          await panel.locator('[data-testid="ab-cancel"]').click();
          await expect(status).toHaveAttribute('data-phase', 'cancelled', { timeout: 10_000 });
          await expect(pagePanel).toHaveAttribute('data-osx-auto-build', 'cancelled', { timeout: 10_000 });
          await expect(panel.locator('[data-testid="ab-result"]')).toHaveCount(0);
          return `run 1 in autobuilder.worker.js (one start; the optimizer worker reused): "${headline}", page panel data-osx-auto-build=done; run 2 showed worker progress, an optimizer.worker solve (${during.objective}) resolved during it, then Cancel: page panel data-osx-auto-build=cancelled (the status text is in a closed shadow root: its wording is covered by tests/extensionAutoBuilderPanel.test.ts)`;
        });

        await record(12, 'docked tabs, the theme reaches the page panel, expanded size, tab host Meets', async () => {
          if (!frame) throw new Error('no iframe');
          await page.setViewportSize({ width: 1280, height: 800 });
          const pagePanel = page.locator('[data-osx-page-panel]');
          const frameEl = page.locator('[data-osx-host] iframe');
          const keep = async (name: string, body: Buffer): Promise<void> => {
            await testInfo.attach(name, { body, contentType: 'image/png' });
            if (process.env.OSX_SHOT_DIR) writeFileSync(join(process.env.OSX_SHOT_DIR, name), body);
          };
          const suffix = variant.csp === null ? 'v1' : 'v2';
          const putSetting = (key: 'theme' | 'accent', value: string): Promise<unknown> =>
            frame!.evaluate(([k, v]) => (globalThis as unknown as WithHarness).osxHarness.putSetting(k as 'theme', v), [key, value] as const);

          // One chart shot per theme at a size. Only the first variant writes them: the CSP header does not change the chart.
          const chartShots = async (size: 'compact' | 'expanded'): Promise<void> => {
            await frame!.locator('[data-testid="tab-chart"]').click();
            for (const theme of ['light', 'dark'] as const) {
              await putSetting('theme', theme);
              await expect(frame!.locator('html')).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
              await expect(frame!.locator('[data-testid="chart"]')).toBeVisible();
              if (suffix === 'v1') await keep(`chart-${size}-${theme}-v3.png`, await frameEl.screenshot());
            }
          };

          // Nothing a tab computes runs before the tab opens: records 8 to 11 opened Score and Build only.
          for (const id of ['chart', 'plan', 'save']) await expect(frame.locator(`[data-testid="panel-${id}"]`), `the ${id} tab is not rendered before it opens`).toHaveCount(0);

          // Each tab shows its own body, in each theme, and the theme reaches the page panel (a closed shadow root: its host mirrors the theme).
          const bodies: Readonly<Record<string, string>> = { score: 'team-results', chart: 'chart', build: 'autobuilder-panel', plan: 'session-planner-editor', save: 'save' };
          for (const theme of ['light', 'dark'] as const) {
            await putSetting('theme', theme);
            await expect(frame.locator('html')).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
            await expect(pagePanel).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
            for (const [id, marker] of Object.entries(bodies)) {
              await frame.locator(`[data-testid="tab-${id}"]`).click();
              await expect(frame.locator(`[data-testid="tab-${id}"]`)).toHaveAttribute('aria-selected', 'true');
              await expect(frame.locator(`[data-testid="panel-${id}"]`)).toBeVisible();
              await expect(frame.locator(`[data-testid="${marker}"]`).first(), `${id} shows ${marker}`).toBeVisible({ timeout: 20_000 });
              await keep(`docked-${id}-${theme}-${suffix}.png`, await frameEl.screenshot());
            }
            await keep(`pagepanel-${theme}-${suffix}.png`, await page.screenshot());
          }
          // Hidden tabs stay mounted: the Build tab kept its panel while the others were shown.
          await expect(frame.locator('[data-testid="autobuilder-panel"]')).toHaveCount(1);

          // The chart at the compact width, in both themes (the ScoreChart review shots, -v3).
          await chartShots('compact');
          // Expanded size: larger, inside the viewport and clear of the Options button at each width.
          await frame.locator('[data-testid="tab-score"]').click();
          const compact = await frameEl.boundingBox();
          await frame.locator('[data-testid="size-toggle"]').click();
          await expect(frameEl).toHaveAttribute('data-osx-size', 'expanded', { timeout: 10_000 });
          const seen: string[] = [];
          for (const width of [1280, 800, 390]) seen.push(await expandedGeometry(page, width, compact));
          await page.setViewportSize({ width: 1280, height: 800 });
          await chartShots('expanded');
          await frame.locator('[data-testid="size-toggle"]').click();
          await expect(frameEl).toHaveAttribute('data-osx-size', 'compact', { timeout: 10_000 });

          // Save: a real config with dive entries is stored, and the store holds one more lineup.
          const lineupCount = (): Promise<number> => frame!.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.lineupCount());
          const before = await lineupCount();
          await frame.locator('[data-testid="tab-save"]').click();
          await frame.locator('[data-testid="snapshot-save"]').click();
          const status = frame.locator('[data-testid="snapshot-status"]');
          await expect(status).not.toHaveAttribute('data-phase', /^(idle|saving)$/, { timeout: 90_000 });
          await expect(status).toHaveAttribute('data-phase', 'saved');
          await expect(status).toContainText(/Saved snapshot "Snapshot /);
          if ((await lineupCount()) !== before + 1) throw new Error('Save reported saved but the store did not gain one lineup');
          const saveNote = 'Save stored one snapshot of config C with its dive scores';
          await expect(frame.locator('a[data-testid="open-in-tab"]')).toHaveAttribute('href', `${extensionBase}/dashboard.html?host=tab`);

          // The tab host: Meets opens a report; a theme chosen in the tab's Settings reaches the docked frame and the page panel.
          const tabPage = await context!.newPage();
          try {
            await tabPage.goto(`${extensionBase}/dashboard.html?host=tab`);
            await expect(tabPage.locator('[data-testid="host-shell"]')).toBeVisible({ timeout: 15_000 });
            await expect(tabPage.locator('[data-testid="host"]')).toHaveText('host: tab');
            for (const theme of ['dark', 'light'] as const) {
              await tabPage.locator('[data-testid="tab-settings"]').click();
              await tabPage.locator(`[data-testid="theme-${theme}"]`).click();
              await expect(tabPage.locator('html')).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
              await expect(frame.locator('html')).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
              await expect(pagePanel).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
              await tabPage.locator('[data-testid="tab-meets"]').click();
              const idsBeforeSecond = await tabPage.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.lineupIds());
              await frame.locator('[data-testid="tab-save"]').click();
              await frame.locator('[data-testid="snapshot-save"]').click();
              await expect(status).toHaveAttribute('data-phase', 'saving');
              await expect(status).toHaveAttribute('data-phase', 'saved', { timeout: 90_000 });
              const idsAfterSecond = await tabPage.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.lineupIds());
              const freshId = idsAfterSecond.find((id) => !idsBeforeSecond.includes(id));
              if (!freshId) throw new Error('Second snapshot was not stored');
              await tabPage.locator('[data-testid="meets-refresh"]').click();
              await expect(tabPage.locator('[data-testid="diff-pick"]')).toHaveCount(2, { timeout: 15_000 });
              const picks = tabPage.locator('[data-testid="diff-pick"]');
              await picks.nth(0).check();
              await picks.nth(1).check();
              await expect(tabPage.locator('[data-testid="diff-view"]')).toBeVisible({ timeout: 15_000 });
              await tabPage.locator('html').evaluate((el, value) => el.setAttribute('data-osx-theme', value), theme);
              await keep(`uc-diff-${theme}-${suffix}.png`, await tabPage.screenshot());
              await frame.locator('[data-testid="undo"]').click();
              await expect(frame.locator('[data-testid="undo-status"]')).toHaveText('Undone.');
              await frame.locator('[data-testid="snapshot-save"]').click();
              await expect(status).toHaveAttribute('data-phase', 'saving');
              await expect(status).toHaveAttribute('data-phase', 'saved', { timeout: 90_000 });
              const latestId = (await tabPage.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.lineupIds())).find((id) => !idsBeforeSecond.includes(id));
              if (!latestId) throw new Error('Snapshot for cross-context undo was not stored');
              await tabPage.evaluate((id) => (globalThis as unknown as WithHarness).osxHarness.deleteLineupExternally(id), latestId);
              await frame.locator('[data-testid="undo"]').click();
              await expect(frame.locator('[data-testid="undo-status"]')).toHaveText('This record changed in another tab. Nothing was undone.');
              await tabPage.locator('[data-testid="record-open"]').first().click();
              await expect(tabPage.locator('[data-testid="record-view"]')).toContainText('(you)', { timeout: 15_000 });
              await expect(tabPage.locator('[data-testid="record-error"]')).toHaveCount(0);
              await keep(`tabhost-meets-${theme}-${suffix}.png`, await tabPage.screenshot());
            }
          } finally {
            await tabPage.close();
          }
          // A custom accent: the docked chrome carries the hex in light and the lightened mix in dark, and the page panel follows the same theme.
          await putSetting('accent', '#aa5500');
          const accentOf = (): Promise<string> => frame!.evaluate(() => document.documentElement.style.getPropertyValue('--osx-accent'));
          for (const theme of ['light', 'dark'] as const) {
            await putSetting('theme', theme);
            await expect(frame.locator('html')).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
            await expect(pagePanel).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
            await expect.poll(accentOf, { timeout: 10_000 }).toBe(theme === 'light' ? '#aa5500' : 'color-mix(in srgb, #aa5500 65%, CanvasText)');
            await frame.locator('[data-testid="tab-chart"]').click();
            await expect(frame.locator('[data-testid="chart"]')).toBeVisible();
            await keep(`docked-chart-accent-${theme}-${suffix}.png`, await frameEl.screenshot());
            await keep(`pagepanel-accent-${theme}-${suffix}.png`, await page.screenshot());
          }
          await putSetting('theme', 'light');
          return `all five docked tabs rendered in both themes (lazy until opened), the stored theme reached the docked chrome, the page panel host and a second tab; a custom accent applied in both themes; expanded sizes ${seen.join(', ')} clear of the Options button; ${saveNote}; Meets opened the snapshot Save stored, with its report, in both themes`;
        });

        await record(13, 'U-e Settings and Presets, backup round trip, cache safety, theme screenshots', async () => {
          mkdirSync(UE_SHOT_DIR, { recursive: true });
          const tabPage = await context!.newPage();
          try {
            await tabPage.goto(`${extensionBase}/dashboard.html?host=tab`);
            await expect(tabPage.locator('[data-testid="host-shell"]')).toBeVisible({ timeout: 15_000 });
            const harness = () => tabPage.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.storeCounts());
            const screenshots: string[] = [];
            for (const theme of ['light', 'dark'] as const) {
              await tabPage.locator('[data-testid="tab-settings"]').click();
              await tabPage.locator(`[data-testid="theme-${theme}"]`).click();
              await expect(tabPage.locator('html')).toHaveAttribute('data-osx-theme', theme, { timeout: 10_000 });
              await tabPage.locator('[data-testid="accent-input"]').fill('#335577');
              await tabPage.locator('[data-testid="cut-threshold"]').fill('1.5');
              await tabPage.locator('[data-testid="cut-threshold"]').blur();
              await expect.poll(() => tabPage.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.getSetting('cutCloseThresholdPct'))).toMatchObject({ found: true, value: { value: 1.5 } });
              const settingsShot = join(UE_SHOT_DIR, `settings-${theme}.png`);
              await tabPage.screenshot({ path: settingsShot, fullPage: true }); screenshots.push(settingsShot);
              await tabPage.locator('[data-testid="tab-presets"]').click();
              await expect(tabPage.locator('[data-testid="presets-slot"] li').first()).toBeVisible();
              const presetsShot = join(UE_SHOT_DIR, `presets-${theme}.png`);
              await tabPage.screenshot({ path: presetsShot, fullPage: true }); screenshots.push(presetsShot);
            }
            await tabPage.locator('[data-testid="tab-settings"]').click();
            const before = await harness();
            await expect(tabPage.locator('[data-testid="backup-include-swimcloud"]')).not.toBeChecked();
            await expect(tabPage.locator('[data-testid="backup-conflict"]')).toHaveValue('skip');
            const downloadWait = tabPage.waitForEvent('download');
            await tabPage.locator('[data-testid="backup-export"]').click();
            const download = await downloadWait;
            const backupPath = await download.path();
            if (!backupPath) throw new Error('Backup download has no readable file path');
            const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as { stores: Record<string, unknown[]> };
            if (!Array.isArray(backup.stores.settings)) throw new Error('Default backup omitted settings');
            if ('swimmerHistory' in backup.stores || 'rosters' in backup.stores) throw new Error('Default backup included SwimCloud cache stores');
            const recordCount = Object.values(backup.stores).reduce((sum, rows) => sum + rows.length, 0);
            if (recordCount < 1) throw new Error('Default backup exported no user records');
            await tabPage.locator('[data-testid="backup-include-swimcloud"]').check();
            const fullDownloadWait = tabPage.waitForEvent('download');
            await tabPage.locator('[data-testid="backup-export"]').click();
            const fullDownload = await fullDownloadWait;
            const fullPath = await fullDownload.path();
            if (!fullPath) throw new Error('SwimCloud backup download has no readable file path');
            const fullBackup = JSON.parse(readFileSync(fullPath, 'utf8')) as { includesSwimCloudData: boolean; stores: Record<string, unknown[]> };
            if (!fullBackup.includesSwimCloudData || !Array.isArray(fullBackup.stores.swimmerHistory) || !Array.isArray(fullBackup.stores.rosters)) {
              throw new Error('Checked SwimCloud option did not export both fetched-data stores');
            }
            await tabPage.locator('[data-testid="backup-include-swimcloud"]').uncheck();
            await tabPage.locator('[data-testid="backup-import"]').setInputFiles(backupPath);
            await expect(tabPage.locator('[data-testid="settings-status"]')).toContainText(`Added 0; replaced 0; skipped`, { timeout: 15_000 });
            const statusText = await tabPage.locator('[data-testid="settings-status"]').innerText();
            const skipped = (statusText.match(/exists/g) ?? []).length;
            if (skipped !== recordCount) throw new Error(`Expected ${recordCount} existing records to skip, reported ${skipped}: ${statusText}`);
            await tabPage.locator('[data-testid="clear-cache"]').click();
            await expect(tabPage.getByText(/Clear all fetched SwimCloud data\?/)).toBeVisible();
            await tabPage.getByRole('button', { name: 'Confirm clear' }).click();
            await expect(tabPage.locator('[data-testid="settings-status"]')).toContainText('Deleted', { timeout: 15_000 });
            const after = await harness();
            for (const store of ['settings', 'rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides']) {
              if (before[store] !== after[store]) throw new Error(`Clear cache changed user store ${store}: ${before[store]} -> ${after[store]}`);
            }
            return `theme, accent and threshold changed; ${recordCount} exported records were skipped as existing; cache clear preserved all user-store counts; screenshots: ${screenshots.join(', ')}`;
          } finally { await tabPage.close(); }
        });

        await record(14, 'F visual sweep: every view in light, dark and a custom accent, with a contrast and sideways-scroll audit', async () => {
          if (variant.csp !== null) return 'swept in the first variant only: the views do not depend on the page CSP';
          if (!frame) throw new Error('no iframe');
          const dir = process.env.OSX_SHOT_DIR ?? join(tmpdir(), 'omniswim-f1-screenshots');
          mkdirSync(dir, { recursive: true });
          await page.setViewportSize({ width: 1280, height: 800 });
          const frameEl = page.locator('[data-osx-host] iframe');
          const pagePanel = page.locator('[data-osx-page-panel]');
          const putSetting = (key: 'theme' | 'accent', value: string): Promise<unknown> =>
            frame!.evaluate(([k, v]) => (globalThis as unknown as WithHarness).osxHarness.putSetting(k as 'theme', v), [key, value] as const);
          const findings: string[] = [];
          let shots = 0;
          const audit = async (where: Frame | Page, label: string): Promise<void> => {
            const found = await where.evaluate(VISUAL_AUDIT);
            for (const item of found.low) findings.push(`${label}: contrast ${item}`);
            for (const item of found.sideways) findings.push(`${label}: scrolls sideways (${item})`);
          };
          const shoot = async (name: string, take: () => Promise<Buffer>): Promise<void> => {
            try {
              writeFileSync(join(dir, name), await take());
            } catch (cause) {
              throw new Error(`screenshot ${name}: ${cause instanceof Error ? (cause.message.split('\n')[0] ?? '') : String(cause)}`);
            }
            shots += 1;
          };

          // Two snapshots of the meet, so the tab can compare them.
          await frame.locator('[data-testid="tab-save"]').click();
          for (const name of ['Sweep earlier', 'Sweep later']) {
            await frame.locator('[data-testid="snapshot-name"]').fill(name);
            await frame.locator('[data-testid="snapshot-save"]').click();
            await expect(frame.locator('[data-testid="snapshot-status"]')).toHaveAttribute('data-phase', 'saved', { timeout: 90_000 });
          }

          const tabPage = await context!.newPage();
          const tabLog: string[] = [];
          tabPage.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') tabLog.push(m.text().slice(0, 160)); });
          tabPage.on('pageerror', (e) => tabLog.push(`pageerror ${e.message.slice(0, 160)}`));
          try {
            await tabPage.setViewportSize({ width: 1280, height: 800 });
            await tabPage.goto(`${extensionBase}/dashboard.html?host=tab`);
            await expect(tabPage.locator('[data-testid="host-shell"]')).toBeVisible({ timeout: 15_000 });
            const variants = [
              { id: 'light', theme: 'light', accent: false },
              { id: 'dark', theme: 'dark', accent: false },
              { id: 'light-accent', theme: 'light', accent: true },
              { id: 'dark-accent', theme: 'dark', accent: true },
            ] as const;
            for (const v of variants) {
              // Earlier records left an accent in the store: the plain variants start without one.
              if (v.accent) await putSetting('accent', '#aa5500');
              else await frame.evaluate(() => (globalThis as unknown as WithHarness).osxHarness.clearSetting('accent'));
              await putSetting('theme', v.theme);
              for (const target of [frame.locator('html'), tabPage.locator('html'), pagePanel]) await expect(target).toHaveAttribute('data-osx-theme', v.theme, { timeout: 10_000 });
              // Docked: five tabs at the compact and the expanded size.
              for (const size of ['compact', 'expanded'] as const) {
                const expanded = (await frameEl.getAttribute('data-osx-size')) === 'expanded';
                if ((size === 'expanded') !== expanded) await frame.locator('[data-testid="size-toggle"]').click();
                await expect(frameEl).toHaveAttribute('data-osx-size', size, { timeout: 10_000 });
                for (const id of ['score', 'chart', 'build', 'plan', 'save']) {
                  await frame.locator(`[data-testid="tab-${id}"]`).click();
                  await expect(frame.locator(`[data-testid="panel-${id}"]`)).toBeVisible();
                  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
                  await shoot(`docked-${id}-${size}-${v.id}-f1.png`, () => frameEl.screenshot());
                  await audit(frame, `docked ${id} ${size} ${v.id}`);
                }
              }
              await frame.locator('[data-testid="size-toggle"]').click();
              await expect(frameEl).toHaveAttribute('data-osx-size', 'compact', { timeout: 10_000 });
              await shoot(`pagepanel-${v.id}-f1.png`, async () => {
                // An element screenshot of the host fails on its closed shadow root: clip the page to the host's box instead.
                await pagePanel.scrollIntoViewIfNeeded();
                const box = await pagePanel.boundingBox();
                if (!box) throw new Error('the page panel has no box');
                return page.screenshot({ clip: { ...box, width: Math.min(box.width, 340) } });
              });
              // Tab: Meets with a report and with a comparison, Presets, Settings.
              await tabPage.locator('[data-testid="tab-meets"]').click();
              await tabPage.locator('[data-testid="record-open"]').first().click();
              await expect(tabPage.locator('[data-testid="record-view"]')).toContainText('(you)', { timeout: 15_000 });
              await shoot(`tab-meets-report-${v.id}-f1.png`, () => tabPage.screenshot({ fullPage: true }));
              await audit(tabPage, `tab meets report ${v.id}`);
              const picks = tabPage.locator('[data-testid="diff-pick"]');
              await picks.nth(0).check();
              await picks.nth(1).check();
              await expect(tabPage.locator('[data-testid="diff-view"]')).toBeVisible({ timeout: 15_000 });
              await shoot(`tab-meets-diff-${v.id}-f1.png`, () => tabPage.screenshot({ fullPage: true }));
              await audit(tabPage, `tab meets diff ${v.id}`);
              await picks.nth(0).uncheck();
              await picks.nth(1).uncheck();
              for (const id of ['presets', 'settings']) {
                await tabPage.locator(`[data-testid="tab-${id}"]`).click();
                await expect(tabPage.locator(`[data-testid="${id === 'presets' ? 'presets-slot' : 'settings'}"]`)).toBeVisible();
                await shoot(`tab-${id}-${v.id}-f1.png`, () => tabPage.screenshot({ fullPage: true }));
                await audit(tabPage, `tab ${id} ${v.id}`);
              }
            }
          } catch (cause) {
            throw new Error(`${cause instanceof Error ? cause.message.split('\n').slice(0, 3).join(' ') : String(cause)} | tab console: ${tabLog.join(' ; ') || 'none'}`);
          } finally {
            await tabPage.close();
          }
          await putSetting('theme', 'light');
          if (findings.length > 0) {
            writeFileSync(join(dir, 'sweep-findings-f1.txt'), findings.join('\n'));
            throw new Error(`${findings.length} findings, listed in sweep-findings-f1.txt: ${findings.slice(0, 4).join(' || ')}`);
          }
          return `${shots} screenshots in ${dir}, no contrast below 4.5:1 and no sideways scroll`;
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
      expect(results.size).toBe(14);
    });
  }
});
