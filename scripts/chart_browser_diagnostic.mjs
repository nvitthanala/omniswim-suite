/**
 * One-shot browser diagnostic for Matrix chart sizing (Phase 0 checklist).
 * Run: node scripts/chart_browser_diagnostic.mjs
 * Requires dev server on http://localhost:3000
 */
import { chromium } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

async function main() {
  const consoleMessages = [];
  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on('console', msg => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });

  const workspaces = await page.request.get(`${BASE}/api/workspaces`).then(r => r.json());
  const withData = workspaces.find(
    ws => Array.isArray(ws.menResults) && ws.menResults.length > 0
  );
  if (!withData) {
    console.error('No workspace with menResults found — create one or POST fixture first');
    process.exit(1);
  }

  const url = `${BASE}/matrix?workspace=${withData.id}`;
  console.log(`Navigating to ${url} (workspace: ${withData.name})`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Chronological Team Score Timeline', { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  const pageTitle = await page.title();
  const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 500));

  const diag = await page.evaluate(() => {
    const shell = document.querySelector('.chart-shell');
    const rc = document.querySelector('.recharts-responsive-container');
    const wrapper = document.querySelector('.recharts-wrapper');
    const surface = document.querySelector('svg.recharts-surface');
    const grid = document.querySelectorAll('.recharts-cartesian-grid line, .recharts-cartesian-grid path');
    const lines = document.querySelectorAll('.recharts-line path, path.recharts-curve');
    const shellRect = shell?.getBoundingClientRect();
    const wrapperRect = wrapper?.getBoundingClientRect();
    const surfaceRect = surface?.getBoundingClientRect();
    return {
      shell: shell
        ? {
            ready: shell.getAttribute('data-chart-ready'),
            liveReady: shell.getAttribute('data-chart-live-ready'),
            w: shell.getAttribute('data-chart-w'),
            h: shell.getAttribute('data-chart-h'),
            rect: shellRect ? { width: shellRect.width, height: shellRect.height } : null,
          }
        : null,
      responsiveContainer: rc ? { count: document.querySelectorAll('.recharts-responsive-container').length } : null,
      wrapper: wrapperRect ? { width: wrapperRect.width, height: wrapperRect.height } : null,
      surface: surfaceRect
        ? {
            width: surface.getAttribute('width') ?? surfaceRect.width,
            height: surface.getAttribute('height') ?? surfaceRect.height,
          }
        : null,
      gridCount: grid.length,
      lineCount: lines.length,
    };
  });

  const minusOneWarnings = consoleMessages.filter(m =>
    /width\(-1\).*height\(-1\)/.test(m.text)
  );

  console.log('\n=== Page ===');
  console.log('title:', pageTitle);
  console.log('body:', bodySnippet.replace(/\s+/g, ' ').slice(0, 300));

  console.log('\n=== DOM diagnostics ===');
  console.log(JSON.stringify(diag, null, 2));
  console.log(`\n=== Console width(-1) warnings: ${minusOneWarnings.length} ===`);
  for (const w of minusOneWarnings.slice(0, 3)) {
    console.log(w.text.slice(0, 200));
  }

  await browser.close();

  const healthy =
    diag.shell?.liveReady === 'true' &&
    Number(diag.shell?.w) > 100 &&
    Number(diag.shell?.h) > 100 &&
    !diag.responsiveContainer &&
    diag.wrapper &&
    diag.wrapper.width > 100 &&
    diag.wrapper.height > 100 &&
    diag.surface &&
    Number(diag.surface.width) > 100 &&
    minusOneWarnings.length === 0 &&
    (diag.gridCount > 0 || diag.lineCount > 0);

  if (healthy) {
    console.log('\nRESULT: HEALTHY');
    process.exit(0);
  }

  console.log('\nRESULT: BROKEN');
  if (diag.responsiveContainer) console.log('→ Phase 2: ResponsiveContainer still mounting');
  else if (diag.shell?.liveReady !== 'true') console.log('→ Phase 3a: layout measurement');
  else console.log('→ Phase 3b: Recharts bootstrap / SVG blank');

  process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
