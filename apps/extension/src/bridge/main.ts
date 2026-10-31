/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * sim-bridge entry (MAIN world). The logic is in ./install.ts so a test can run it.
 */
import { installBridge } from './install';

installBridge(window);
