// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `RosterImportWizard`'s clipboard dispatcher — which SwimCloud page kind
 * routes where.
 *
 * The bug this file locks down (fixed 2026-09-09): a `swimmer`-kind capture
 * (the bare `/swimmer/{id}/` profile root) was routed straight into
 * `parseSwimmerProfileHtml`, a `Synthetic-fixture-only` parser written for a
 * personal-bests table SwimCloud does not serve on that page. The real bests
 * table lives on `/swimmer/{id}/times/`. So the dispatcher now routes
 * `swimmerTimes` to the real parser and tells a coach who captured the profile
 * root which page to capture instead — the same "you captured the wrong page"
 * treatment the meet root already gets.
 *
 * Both halves are asserted from the **real** capture pair: the times page and
 * the profile-root page SwimCloud served for the same swimmer on 2026-09-09.
 * Neither branch is exercised with invented markup.
 *
 * Written without JSX (plain `React.createElement`) so it stays a `.test.ts`
 * under this repo's `tests/**\/*.test.ts` include glob — same convention
 * `tests/swimCloudCapturePicker.test.ts` established.
 *
 * `useToast` outside a `ToastProvider` falls back to `console.error` /
 * `console.log` (see `packages/ui/src/components/Toast.tsx`), so spying on the
 * console is how this file reads what a coach would have been shown.
 *
 * A standalone, always-visible "From clipboard" button no longer exists here:
 * the whole-app UI redesign demoted the clipboard path to the shared
 * `SwimCloudCaptureBrowser`'s own empty-state fallback link (see
 * `plans/2026-09-10/02-UI-REDESIGN-WHOLE-APP.md` §0). `handleClipboardImport`
 * and everything it dispatches to are unchanged — only how a coach reaches it
 * moved, so `importFromClipboard` below opens "Add from SwimCloud" and clicks
 * the browser's own "or paste a single swimmer instead" link. `fetch` is
 * stubbed to fail immediately so that panel's pairing-token call never hangs
 * on a real network call this file has no interest in.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type Workspace } from '@omniswim/core/types';
import RosterImportWizard from '@omniswim/manager/components/RosterImportWizard';

// React 18/19 warn on `act(...)` unless the environment declares itself.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TIMES_HTML = readFileSync(join(fixturesDir, 'swimcloud-real-swimmer-times-1472365.html'), 'utf8');
const HOME_HTML = readFileSync(join(fixturesDir, 'swimcloud-real-swimmer-home-1472365.html'), 'utf8');
const ROSTER_MEN_HTML = readFileSync(
  join(fixturesDir, 'swimcloud-real-team-roster-58-gender-m.html'),
  'utf8',
);

/** Exactly the shape `extensions/swimcloud-companion`'s `buildPayload()` puts on the clipboard. */
function clipboardCapture(sourceUrl: string, html: string): string {
  return JSON.stringify({
    omniswimSwimCloudCapture: 1,
    sourceUrl,
    retrievedAt: '2026-09-09T03:32:55.480Z',
    track: 'browser-extension',
    html,
  });
}

function testWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Test workspace',
    menResults: [],
    womenResults: [],
    recruits: [],
    createdAt: Date.now(),
  } as Workspace;
}

describe('RosterImportWizard — clipboard dispatcher routing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let errors: string[];
  let logs: string[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    errors = [];
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(String(args[0]));
    });
    // This file exercises the clipboard dispatcher, not `SwimCloudCaptureBrowser`'s
    // own network behavior — fail its pairing-token call immediately so its
    // empty-state (and the paste-fallback link inside it) appears at once.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network disabled in this test');
      }),
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /**
   * Mount the wizard, name a team, open "Add from SwimCloud", then click the
   * capture browser's own demoted "paste a single swimmer instead" link over
   * `clipboardText` — see this file's header comment on why that replaces the
   * old standalone "From clipboard" button.
   */
  async function importFromClipboard(clipboardText: string, teamName = 'Auburn'): Promise<void> {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => clipboardText },
    });

    await act(async () => {
      root.render(
        createElement(RosterImportWizard, {
          workspace: testWorkspace(),
          gender: Gender.MEN,
          onClose: () => undefined,
          onUpdate: () => undefined,
        }),
      );
    });

    // The dispatcher refuses before reading the clipboard unless a team is named.
    const teamInput = container.querySelector<HTMLInputElement>('input[aria-label="Custom team name"]');
    if (teamInput === null) throw new Error('team input not rendered');
    const setValue = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')?.set;
    if (setValue === undefined) throw new Error('no native value setter');
    await act(async () => {
      setValue.call(teamInput, teamName);
      teamInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const openButton = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Add from SwimCloud'),
    );
    if (openButton === undefined) throw new Error('"Add from SwimCloud" button not rendered');
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Let the stubbed pairing-token fetch reject and the browser settle into
    // its empty state before looking for the fallback link inside it.
    await flush();

    const pasteLink = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('paste a single swimmer instead'),
    );
    if (pasteLink === undefined) throw new Error('capture browser paste-fallback link not rendered');
    await act(async () => {
      pasteLink.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('routes a swimmerTimes capture to the real parser and imports the real swims', async () => {
    await importFromClipboard(
      clipboardCapture('https://www.swimcloud.com/swimmer/1472365/times/', TIMES_HTML),
    );

    // Reached the preview step with the 8 importable rows of the real capture
    // (9 rows, less the one relay-leadoff split).
    expect(errors).toStrictEqual([]);
    expect(container.textContent).toContain('Paulk, River J');
    expect(container.textContent).toContain('50 Free SCY');
    expect(container.textContent).toContain('19.42');
    // The leadoff split never reaches the preview.
    expect(container.textContent).not.toContain('50 Back SCY');
    expect(container.textContent).toContain('1 row(s) skipped — relay leadoff.');
  });

  it('does not attempt a parse of the bare swimmer profile root — it says which page to capture', async () => {
    await importFromClipboard(clipboardCapture('https://www.swimcloud.com/swimmer/1472365/', HOME_HTML));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("That page is a swimmer's profile summary, not their full times list");
    expect(errors[0]).toContain('swimcloud.com/swimmer/1472365/times/');
    // The tell that no parse was attempted: a parse failure would have been
    // reported as "Could not read personal bests from that page: …" instead.
    expect(errors[0]).not.toContain('Could not read personal bests');
    // And nothing advanced to the preview step.
    expect(container.textContent).not.toContain('Paulk, River J');
  });

  /* ------------------------------------------------------------------ */
  /* Behavior locked down across the 2026-09-09 shared-helper extraction */
  /* ------------------------------------------------------------------ */

  /*
   * `handleClipboardTeamRoster` and `handleClipboardSwimmerTimes` no longer
   * hold their own copies of "seed a queue from a roster" and "convert one
   * swimmer and check them off" — both now call
   * `packages/manager/src/lib/rosterQueueImport.ts`, which the new bulk
   * capture-import path calls too. The three cases below are the proof that
   * moving that logic changed none of what a coach sees: the same roster
   * summary sentence, the same queue, the same accumulate-don't-replace
   * preview.
   */

  it('seeds the roster queue from a real roster capture and reports who is new', async () => {
    await importFromClipboard(
      clipboardCapture('https://www.swimcloud.com/team/58/roster/?page=1&gender=M', ROSTER_MEN_HTML),
      'Henderson State',
    );

    expect(errors).toStrictEqual([]);
    // 35 real athletes on the real capture, none of them in this empty workspace.
    expect(logs[0]).toContain('Roster captured: 35 swimmer(s), 35 not yet in this workspace:');
    // Six names, then a count — the summary never prints all 35.
    expect(logs[0]).toContain('Bartu Akin, Steven Balistreri');
    expect(logs[0]).toContain('+29 more');
    // Team label comes from the page's own <title>, not from what was typed.
    expect(container.textContent).toContain('Roster queue — Henderson State University (0/35 captured)');
    // Every athlete is on the checklist, including the ones the summary elided.
    expect(container.textContent).toContain('Colin Candebat');
    // The manual per-swimmer fallback is still the way to work through it.
    expect(container.textContent).toContain('Capture next swimmer');
  });

  it('keeps a seeded queue and accumulates into the preview when a swimmer capture follows', async () => {
    await importFromClipboard(
      clipboardCapture('https://www.swimcloud.com/team/58/roster/?page=1&gender=M', ROSTER_MEN_HTML),
      'Henderson State',
    );
    await importFromClipboard(
      clipboardCapture('https://www.swimcloud.com/swimmer/1472365/times/', TIMES_HTML),
      'Henderson State',
    );

    expect(errors).toStrictEqual([]);
    // The real times fixture is an Auburn swimmer, so nobody on this roster is
    // checked off — and the count says so rather than guessing at a match.
    expect(logs[1]).toContain('Added 8 swim(s) for Paulk, River J. 0/35 roster swimmers captured.');
    expect(container.textContent).toContain('Roster queue — Henderson State University (0/35 captured)');
    // The swims still reached the preview, under the wizard's own team.
    expect(container.textContent).toContain('50 Free SCY');
    expect(container.textContent).toContain('19.42');
  });

  it('still refuses a page kind it does not read, naming the times page in the guidance', async () => {
    await importFromClipboard(
      clipboardCapture('https://www.swimcloud.com/conference/nsisc/', '<html><body></body></html>'),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('doesn\'t read "conference" pages');
    expect(errors[0]).toContain("swimmer's times page");
  });
});
