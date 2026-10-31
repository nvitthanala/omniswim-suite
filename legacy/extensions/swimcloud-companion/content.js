/**
 * Omniswim SwimCloud Companion — content script.
 *
 * Track A per plans/2026-09-06/01-legal-and-access-strategy.md §4: this
 * script does nothing until a human clicks the button it injects, on a page
 * they are already viewing in their own logged-in browser. It never
 * navigates anywhere, never runs on a timer, and never reads or sends
 * anything except in direct response to that click. That is the entire basis
 * for Track A's risk posture — see the legal doc and
 * plans/2026-09-06/03-architecture.md §2. An extension version that added an
 * "auto-import every page I visit" mode would quietly become Track B and
 * would need to be evaluated as one.
 *
 * What it does, on click:
 *   1. Reads this page's current, already-rendered HTML
 *      (document.documentElement.outerHTML) and URL (location.href).
 *   2. Builds a small JSON payload — see buildPayload() below. Its shape must
 *      stay in sync with SwimCloudClipboardPayload in
 *      packages/swimcloud/src/clipboardPayload.ts, which is the thing that
 *      actually validates and parses it on the app side. This file can't
 *      import that module directly (a Manifest V3 content script here is a
 *      plain classic script, no bundler in front of it), so the shape is
 *      duplicated intentionally, in one small function, rather than spread
 *      across this file.
 *   3. Copies the JSON to the clipboard via the Clipboard API, which requires
 *      (and here, has) a direct user gesture.
 *   4. Shows a brief on-page confirmation. Nothing is sent over the network
 *      by this script — the clipboard is the entire transport (Track A's
 *      chosen default, see 03-architecture.md §5's open question, resolved
 *      2026-09-07: clipboard over a localhost listener or a watched file,
 *      because it needs no new infrastructure, no port, and works even when
 *      the desktop app isn't running).
 */
(function () {
  'use strict';

  const BUTTON_ID = 'omniswim-swimcloud-companion-button';
  if (document.getElementById(BUTTON_ID)) {
    return; // Already injected (e.g. a SPA navigation re-ran content scripts).
  }

  function buildPayload() {
    return {
      // Bump this if the shape ever changes incompatibly. The app-side
      // reader (clipboardPayload.ts) rejects anything with an
      // unrecognized version rather than guessing at a shape it wasn't
      // written for.
      omniswimSwimCloudCapture: 1,
      sourceUrl: location.href,
      retrievedAt: new Date().toISOString(),
      track: 'browser-extension',
      html: document.documentElement.outerHTML,
    };
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Fallback for a context where the async Clipboard API is unavailable —
    // still only ever runs from this same user-gesture click handler.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  function createButton() {
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Copy for Omniswim';
    button.setAttribute('aria-label', 'Copy this SwimCloud page for import into Omniswim Suite');

    let resetTimer;
    button.addEventListener('click', async () => {
      clearTimeout(resetTimer);
      try {
        const payload = buildPayload();
        await copyToClipboard(JSON.stringify(payload));
        button.textContent = 'Copied — paste into Omniswim';
        button.classList.add('omniswim-swimcloud-companion-button--done');
      } catch (error) {
        button.textContent = 'Copy failed — see console';
        button.classList.add('omniswim-swimcloud-companion-button--error');

        console.error('Omniswim SwimCloud Companion: clipboard write failed.', error);
      }
      resetTimer = setTimeout(() => {
        button.textContent = 'Copy for Omniswim';
        button.classList.remove('omniswim-swimcloud-companion-button--done', 'omniswim-swimcloud-companion-button--error');
      }, 3000);
    });

    return button;
  }

  document.body.appendChild(createButton());
})();
