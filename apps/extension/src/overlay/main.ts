/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * sim-overlay entry (ISOLATED world). The logic is in ./overlay.ts and ./dockedPanel.ts so a test
 * can run it.
 */
import { mountDockedPanel } from './dockedPanel';
import { mountShadowHost, startOverlay } from './overlay';
import { mountPagePanel } from './pagePanel';
import type { ParityReport } from '@omniswim/swimcloud/browser';

const overlayHost = mountShadowHost(document);
const panel = mountDockedPanel(overlayHost, chrome.runtime);
let latestParity: ParityReport | null = null;
let latestError: string | undefined;
const pagePanel = mountPagePanel(document, () => ({ parity: latestParity, error: latestError }));
const syncCompatibilityError = (): void => { latestError = overlayHost.dataset.osxCompatibilityError; pagePanel.refresh(); };
new MutationObserver(syncCompatibilityError).observe(overlayHost, { attributes: true, attributeFilter: ['data-osx-compatibility-error'] });
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== panel.iframe.contentWindow || event.origin !== new URL(panel.url).origin) return;
  const data = event.data as { source?: unknown; kind?: unknown; report?: unknown } | null;
  if (!data || data.source !== 'osx-docked-dashboard' || data.kind !== 'parity-report' || typeof data.report !== 'object' || data.report === null) return;
  const report = data.report as { kind?: unknown; matches?: unknown; differingEvents?: unknown };
  if (report.kind !== 'not_observed' && !(report.kind === 'compared' && typeof report.matches === 'boolean' && Array.isArray(report.differingEvents))) return;
  latestParity = data.report as ParityReport;
  pagePanel.refresh();
});
startOverlay(window, console, (snapshot) => panel.sendSnapshot(snapshot));
