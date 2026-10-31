/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * sim-overlay entry (ISOLATED world). The logic is in ./overlay.ts and ./dockedPanel.ts so a test
 * can run it.
 */
import { mountDockedPanel } from './dockedPanel';
import { mountShadowHost, startOverlay, themeOf, writeSimulatorSettings } from './overlay';
import { mountPagePanel } from './pagePanel';
import { isAutoBuildStatus, isPanelSize, isScorerTagState, isThemeState } from '../shared/panelProtocol';
import { createAccentSync } from '../shared/theme';
import type { ParityReport } from '@omniswim/swimcloud/browser';
import { trustedParityReport } from './parity';

const overlayHost = mountShadowHost(document);
const panel = mountDockedPanel(overlayHost, chrome.runtime);
let latestParity: ParityReport | null = null;
let latestError: string | undefined;
const frameAccent = createAccentSync(overlayHost.shadowRoot?.querySelector('.osx-root') as HTMLElement);
const pagePanel = mountPagePanel(document, () => ({ parity: latestParity, error: latestError }));
panel.onMessage((message) => {
  if (isScorerTagState(message)) { pagePanel.setScorerState(message); return; }
  if (isAutoBuildStatus(message)) { pagePanel.setAutoBuildStatus(message); return; }
  // The coach's theme reaches the docked frame's chrome and the page panel. Both read it as plain data: an attribute and a style property.
  if (isThemeState(message)) { themeOf(overlayHost)?.setPreference(message.preference); frameAccent.set(message.accent); pagePanel.setThemeState(message); return; }
  // The docked panel asks for its size. The shadow stylesheet turns the attribute into a size.
  if (isPanelSize(message)) { panel.iframe.dataset.osxSize = message.size; return; }
  if (message && typeof message === 'object' && 'kind' in message && (message as {kind?: unknown}).kind === 'scorer-tag-error') {
    const detail = (message as { message?: unknown }).message;
    latestError = typeof detail === 'string' ? detail : 'Scorer tag storage failed';
    pagePanel.refresh();
  }
});
pagePanel.onScorerAction((action) => panel.sendMessage(action));
pagePanel.onApplyRule((settings) => {
  if (!settings) { pagePanel.setApplyStatus('Not applied: this preset has compatibility refusals.'); return; }
  const token = writeSimulatorSettings(window, settings);
  if (!token) { latestError = overlayHost.dataset.osxCompatibilityError || 'Simulator settings write is unavailable'; pagePanel.setApplyStatus(`Compatibility error: ${latestError}`); pagePanel.refresh(); return; }
  pagePanel.setApplyStatus('Pending simulator read-back…');
});
const syncCompatibilityError = (): void => { latestError = overlayHost.dataset.osxCompatibilityError; pagePanel.refresh(); };
new MutationObserver(syncCompatibilityError).observe(overlayHost, { attributes: true, attributeFilter: ['data-osx-compatibility-error'] });
window.addEventListener('message', (event: MessageEvent) => {
  const report = trustedParityReport(event.source, event.origin, panel.iframe.contentWindow, new URL(chrome.runtime.getURL('/')).origin, event.data);
  if (!report) return;
  latestParity = report;
  pagePanel.refresh();
});
startOverlay(window, console, (snapshot) => panel.sendSnapshot(snapshot), () => pagePanel.setApplyStatus('Acknowledged: simulator settings match the requested values.'));
