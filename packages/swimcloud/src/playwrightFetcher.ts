/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The real Track B raw fetcher: launches an actual Chromium browser via
 * `playwright-core` so SwimCloud's Cloudflare Managed/JS Challenge can run at
 * all. A plain HTTP client cannot pass it — there is no JS engine to execute
 * the challenge (`plans/2026-09-06/01-legal-and-access-strategy.md` §2).
 *
 * ## This class has never been run against a live site
 *
 * No Chromium binary was installed in the environment this was written in —
 * confirmed by the Phase 1a commit's "environment issues" note
 * (`chrome-headless-shell.exe` missing; `npx playwright install` was never
 * run). This file is written against the documented `playwright-core` API and
 * type-checked against the real package (already present at
 * `node_modules/playwright-core`, version pinned to what `@playwright/test`
 * already resolves to at the repo root — no new browser-automation dependency
 * was introduced, only a type-level one made explicit). It has unit coverage
 * only for the parts that don't require a running browser: constructor
 * validation and `storageState` path plumbing. See `tests/swimcloudPlaywrightFetcher.test.ts`.
 *
 * ## What still has to happen before Track B is trusted
 *
 * A **supervised, manual, human-present run** against one real SwimCloud URL —
 * `plans/2026-09-06/04-phasing.md` Phase 2 acceptance criterion, open
 * question 2. That run is deliberately *not* something this codebase, or any
 * agent, should do unattended: `01-legal-and-access-strategy.md`'s whole
 * posture for Track B is "on-demand, single-operator, an explicit paste
 * action" — never something code decides to do on its own initiative,
 * including as a test. This file gives you the mechanism; it does not give
 * itself permission to point that mechanism at swimcloud.com.
 */

import type { SwimCloudRawFetchResult, SwimCloudRawFetcher } from './fetcher';

export interface PlaywrightSwimCloudFetcherOptions {
  /**
   * Honest, identifying User-Agent — real contact info, not a browser-
   * impersonation string. Masking identity is what turns "breach of contract"
   * into something closer to deceptive access
   * (`01-legal-and-access-strategy.md` §4, "No identity spoofing").
   */
  readonly userAgent: string;
  /**
   * Path to a `storageState` JSON file: cookies/localStorage persisted across
   * runs, so a warmed-up session can be reused instead of re-solving a
   * challenge on every call
   * (`plans/2026-09-06/03-architecture.md` §3, "session reuse"). The file
   * lives outside version control; this class only reads and writes the path
   * it's given.
   */
  readonly storageStatePath?: string;
  /** Default `true`. A supervised verification run may want `false` to watch it happen. */
  readonly headless?: boolean;
  /** Milliseconds to wait for the page to go idle before reading content. Default 30000. */
  readonly navigationTimeoutMs?: number;
}

export class PlaywrightSwimCloudFetcher implements SwimCloudRawFetcher {
  constructor(private readonly options: PlaywrightSwimCloudFetcherOptions) {
    if (options.userAgent.trim().length === 0) {
      throw new Error(
        'PlaywrightSwimCloudFetcher requires a non-empty, honest User-Agent (01-legal-and-access-strategy.md §4) — refusing to launch with a blank one, which would fall back to Chromium\'s default and read as an ordinary browser rather than an identified tool.',
      );
    }
  }

  async fetchRaw(url: string): Promise<SwimCloudRawFetchResult> {
    // Imported lazily so importing this module doesn't require the browser
    // launcher to resolve at load time — only at the moment a fetch is
    // actually attempted, which is also the moment a supervised human should
    // be present for.
    const { chromium } = await import('playwright-core');

    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    try {
      const context = await browser.newContext({
        userAgent: this.options.userAgent,
        ...(this.options.storageStatePath === undefined
          ? {}
          : { storageState: await storageStateArgument(this.options.storageStatePath) }),
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(url, {
          waitUntil: 'networkidle',
          timeout: this.options.navigationTimeoutMs ?? 30_000,
        });
        const html = await page.content();
        if (this.options.storageStatePath !== undefined) {
          await context.storageState({ path: this.options.storageStatePath });
        }
        return { html, httpStatus: response?.status() ?? 0 };
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
}

/**
 * `newContext({ storageState })` throws if given a path to a file that
 * doesn't exist yet (the normal state on a fresh install, before any session
 * has ever been warmed up) — so a missing file means "no session yet," not an
 * error, and the browser starts with an empty context exactly as it would
 * without the option at all.
 *
 * Exported so this one piece of real logic in the file can be unit-tested
 * without launching a browser — see `tests/swimcloudPlaywrightFetcher.test.ts`.
 */
export async function storageStateArgument(path: string): Promise<string | undefined> {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(path);
    return path;
  } catch {
    return undefined;
  }
}
