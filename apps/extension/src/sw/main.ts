/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Classic service worker. A click on the toolbar icon opens the dashboard in a tab.
 * `tabs.create` needs no `tabs` permission. IndexedDB and the change bus come later
 * (D3 section 5).
 *
 * It ignores every `osx-panel:` port. Those link the overlay to its docked iframe directly
 * (D3 section 3); the worker is not in that path.
 */
import { isPanelPortName } from '../shared/panelProtocol';

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?host=tab') });
});

chrome.runtime.onConnect.addListener((port) => {
  if (isPanelPortName(port.name)) return;
  // No other port exists yet.
});
