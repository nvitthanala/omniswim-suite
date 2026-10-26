/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * sim-overlay entry (ISOLATED world). The logic is in ./overlay.ts and ./dockedPanel.ts so a test
 * can run it.
 */
import { mountDockedPanel } from './dockedPanel';
import { mountShadowHost, startOverlay } from './overlay';

const panel = mountDockedPanel(mountShadowHost(document), chrome.runtime);
startOverlay(window, console, (snapshot) => panel.sendSnapshot(snapshot));
