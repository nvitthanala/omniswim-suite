/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dashboard. One bundle, two hosts: `?host=tab` (a browser tab) and
 * `?host=docked` (the iframe in the simulator page). For now it names itself and its host, owns
 * the optimizer worker, and answers the overlay's port. The page is the only owner of the worker
 * and of storage writes (D3 0.2, 0.4).
 */
import { createRoot } from 'react-dom/client';
import { installHarness } from './harness';
import { listenForPanelPort, readNonce } from './panelPort';
import { bindTheme } from '../shared/theme';
import './dashboard.css';

export type DashboardHost = 'tab' | 'docked';

/** `null` when the param is missing or not one of the two hosts. Nothing is guessed. */
export function readHost(search: string): DashboardHost | null {
  const host = new URLSearchParams(search).get('host');
  return host === 'tab' || host === 'docked' ? host : null;
}

export function App({ host }: { host: DashboardHost | null }) {
  return (
    <main className="osx-dashboard">
      <h1>OmniSwim</h1>
      <p data-testid="host">host: {host ?? 'unknown'}</p>
    </main>
  );
}

// Light is the default (D3 section 4). The attribute selects the token set in dashboard.css.
bindTheme(document.documentElement);
const container = document.getElementById('root');
if (!container) throw new Error('dashboard.html has no #root element');
const host = readHost(location.search);
// Top level, before the first render: the overlay connects as soon as the iframe has loaded.
const nonce = host === 'docked' ? readNonce(location.hash) : null;
const panel = nonce ? listenForPanelPort(chrome.runtime, nonce) : null;
// `__OSX_HARNESS__` is false in the production build, so esbuild drops this call and the probe.
if (__OSX_HARNESS__) installHarness(host ?? 'unknown', panel);
createRoot(container).render(<App host={host} />);
