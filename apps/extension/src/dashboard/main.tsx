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
import * as React from 'react';
import { installHarness } from './harness';
import { listenForPanelPort, readNonce } from './panelPort';
import { bindTheme } from '../shared/theme';
import { AdapterError, rescoreSimulator } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';
import type { Results } from '@omniswim/engine';
import type { ParityReport } from '@omniswim/swimcloud/browser';
import './dashboard.css';

export type DashboardHost = 'tab' | 'docked';

/** `null` when the param is missing or not one of the two hosts. Nothing is guessed. */
export function readHost(search: string): DashboardHost | null {
  const host = new URLSearchParams(search).get('host');
  return host === 'tab' || host === 'docked' ? host : null;
}

type View = { kind: 'empty' } | { kind: 'error'; code: string; reason: string } | { kind: 'not_loaded'; missing: readonly string[] }
  | { kind: 'preset_incomplete'; pending: readonly string[] }
  | { kind: 'scored'; snapshot: SimSnapshot; results: Results; parity: ParityReport };

export function App({ host }: { host: DashboardHost | null }) {
  const [view, setView] = React.useState<View>({ kind: 'empty' });
  const score = React.useCallback((snapshot: SimSnapshot): void => {
    try {
      const result = rescoreSimulator(snapshot, { meetKey: 'swimcloud-simulator', snapshotId: 'live-snapshot' });
      if (result.kind === 'not_loaded') setView(result);
      else if (result.kind === 'preset_incomplete') setView(result);
      else setView({ kind: 'scored', snapshot, results: result.results, parity: result.parity });
    } catch (error) {
      if (error instanceof AdapterError) setView({ kind: 'error', code: error.code, reason: error.message });
      else setView({ kind: 'error', code: 'unexpected', reason: error instanceof Error ? error.message : String(error) });
    }
  }, []);
  React.useEffect(() => {
    const onSnapshot = (event: Event): void => score((event as CustomEvent<SimSnapshot>).detail);
    window.addEventListener('osx-snapshot', onSnapshot);
    if (pendingSnapshot) score(pendingSnapshot);
    return () => window.removeEventListener('osx-snapshot', onSnapshot);
  }, [score]);
  return (
    <main className="osx-dashboard">
      <h1>OmniSwim</h1>
      <p data-testid="host">host: {host ?? 'unknown'}</p>
      {view.kind !== 'empty' && <section className="osx-results" aria-live="polite">
        <h2>SwimCloud simulator</h2>
        {view.kind === 'error' && <p className="osx-status osx-status--warn" data-testid="parity">Not compared: {view.code} — {view.reason}</p>}
        {view.kind === 'not_loaded' && <p className="osx-status osx-status--warn" data-testid="parity">Not loaded: {view.missing.join(', ')}</p>}
        {view.kind === 'preset_incomplete' && <p className="osx-status osx-status--warn" data-testid="parity">Preset incomplete: {view.pending.join(', ')}</p>}
        {view.kind === 'scored' && <>
          <table data-testid="team-results"><thead><tr><th>Team</th><th>Engine</th><th>SwimCloud</th></tr></thead><tbody>
            {view.results.teams.map((team) => {
              const observed = view.parity.kind === 'compared' ? view.parity.teams.find((t) => t.teamId === team.teamId)?.observed : undefined;
              const name = view.snapshot.teams.find((t) => String(t.id) === String(team.teamId))?.name ?? String(team.teamId);
              return <tr key={team.teamId}><th scope="row">{name}</th><td>{team.points}</td><td>{observed === undefined ? '—' : observed}</td></tr>;
            })}
          </tbody></table>
          {view.parity.kind === 'not_observed' && <p className="osx-status osx-status--warn" data-testid="parity">Not observed</p>}
          {view.parity.kind === 'compared' && (view.parity.matches
            ? <p className="osx-status osx-status--good" data-testid="parity">Matches SwimCloud</p>
            : <div className="osx-status osx-status--bad" data-testid="parity"><p>{view.parity.differingEvents.length} differing events</p><ul>{view.parity.differingEvents.flatMap((event) => event.rows.filter((row) => row.status === 'mismatch').map((row) => {
              const name = view.snapshot.teams.find((t) => String(t.id) === String(row.teamId))?.name ?? String(row.teamId);
              return <li key={`${event.eventKey}:${row.entryKey}`}>{event.eventKey}, {name}: engine {row.engine} vs SwimCloud {row.observed ?? 'not stated'}</li>;
            }))}</ul></div>)}
        </>}
      </section>}
    </main>
  );
}

// Light is the default (D3 section 4). The attribute selects the token set in dashboard.css.
bindTheme(document.documentElement);
const container = document.getElementById('root');
if (!container) throw new Error('dashboard.html has no #root element');
const host = readHost(location.search);
let pendingSnapshot: SimSnapshot | null = null;
// Top level, before the first render: the overlay connects as soon as the iframe has loaded.
const nonce = host === 'docked' ? readNonce(location.hash) : null;
const panel = nonce ? listenForPanelPort(chrome.runtime, nonce, (snapshot) => {
  pendingSnapshot = snapshot;
  window.dispatchEvent(new CustomEvent('osx-snapshot', { detail: snapshot }));
}) : null;
// `__OSX_HARNESS__` is false in the production build, so esbuild drops this call and the probe.
if (__OSX_HARNESS__) installHarness(host ?? 'unknown', panel);
const root = createRoot(container);
root.render(<App host={host} />);
