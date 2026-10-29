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
import { AdapterError, rescoreSimulator, SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';
import type { Results } from '@omniswim/engine';
import type { ParityReport } from '@omniswim/swimcloud/browser';
import type { ScorerTag } from '@omniswim/engine';
import type { RulePreset, LoadPreference, SessionPreset } from '@omniswim/engine';
import { sessionLoad, relayRepeatsForSchedule, requireComplete, scoreMeet } from '@omniswim/engine';
import { createChromeChangeBus, createStorageRepo, openOmniDb, readScorerOwnTeam, saveScorerOwnTeam, readScorerRulePreset, saveScorerRulePreset, listRulePresetChoices, resolveRulePreset, watchChanges, toSwimCloudId, readSessionPreset, readSessionLoadPreference, saveEditedSessionPreset } from '../storage';
import type { StorageRepo } from '../storage';
import type { ScorerTagActionMessage, ScorerTagStateMessage } from '../shared/panelProtocol';
import { panelCutTags, scoreScorerTags } from './scorerTagScoring';
import { createOptimizerClient } from './optimizerClient';
import { suggestOpponentRosters, suggestedTags } from './suggestedRosters';
import './dashboard.css';
import { postDockedParityReport } from './parity';
import { SessionPlannerEditor } from './sessionPlannerEditor';

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
  React.useEffect(() => {
    if (host !== 'docked' || view.kind !== 'scored') return;
    // The content script accepts this only from its exact docked iframe window and extension origin.
    postDockedParityReport(window.parent, view.parity);
  }, [host, view]);
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
      {host === 'docked' && view.kind === 'scored' && <SessionPlannerEditor snapshot={view.snapshot} repoForMeet={repoForTags} />}
    </main>
  );
}

// Light is the default (D3 section 4). The attribute selects the token set in dashboard.css.
bindTheme(document.documentElement);
const container = document.getElementById('root');
if (!container) throw new Error('dashboard.html has no #root element');
const host = readHost(location.search);
let pendingSnapshot: SimSnapshot | null = null;
let latestPanelPort: { postMessage(message: unknown): void } | null = null;
let sessionScheduleError: string | undefined;
let tagRepo: Promise<StorageRepo> | undefined;
const optimizer = createOptimizerClient();
const meetKeyFor = (snapshot: SimSnapshot): string => `swimcloud-simulator:${JSON.stringify({ teams: [...new Set(snapshot.teams.map(t => String(t.id)))].sort(), startDate: snapshot.settings.startDate, endDate: snapshot.settings.endDate })}`;
function buildPlannerState(snapshot: SimSnapshot, meetKey: string, rules: RulePreset | undefined, schedule: SessionPreset | undefined, preference: LoadPreference): ScorerTagStateMessage['planner'] {
  if (!rules) return { perSwimmer: [], violations: ['Choose the meet\'s OmniSwim rule preset before calculating session load.'] };
  const rescored = rescoreSimulator(snapshot, { meetKey, snapshotId: 'live-snapshot' });
  if (rescored.kind === 'not_loaded') return { perSwimmer: [], violations: ['Session load is pending because simulator results are not ready.'] };
  try {
    const completeRules = requireComplete(rules);
    const results = scoreMeet(rescored.adapted.model, rescored.adapted.lineup, [], completeRules, SIMULATOR_SOURCING);
    const repeated = results.violations.filter(v => v.kind === 'relay_swimmer_repeated');
    const visibleRepeats = schedule ? relayRepeatsForSchedule(repeated, schedule) : repeated;
    const repeatWarnings = visibleRepeats.map(v => `Relay rule violation: ${v.swimmerId} appears on multiple relays for ${v.eventKey} (${v.gender}).`);
    const note = schedule ? [] : ['No schedule chosen; relay event formats are unknown, so relay repeat violations are unfiltered.'];
    if (!schedule) return { perSwimmer: [], violations: [...repeatWarnings, ...note] };
    const load = sessionLoad(rescored.adapted.model, rescored.adapted.lineup, results, schedule, preference, completeRules);
    const loadWarnings = load.violations.map(v => v.kind === 'session_load' ? `Session load: swimmer ${String(v.swimmerId)} has ${v.races} races on day ${v.session.day} (${v.session.slot}); limit ${v.limit}.` : v.kind === 'pending_setting' ? `Pending setting: ${v.setting} for ${v.eventKey}.` : v.kind === 'unscheduled_event' ? `Unscheduled event: ${v.eventKey}.` : `Session load issue: ${v.kind}.`);
    return { perSwimmer: load.perSwimmer.map(s => ({ swimmerId: String(s.swimmerId), sessions: s.sessions })), violations: [...repeatWarnings, ...loadWarnings] };
  } catch (cause) {
    return { perSwimmer: [], violations: [`Session load is pending: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
}
const repoForTags = (): Promise<StorageRepo> => (tagRepo ??= openOmniDb().then(db => {
  const bus = createChromeChangeBus(chrome.storage as never);
  const repo = createStorageRepo(db, { bus });
  void watchChanges(db, bus, change => { if (change.stores === 'unknown' || change.stores.includes('tags') || change.stores.includes('settings')) void publishTagState(); }, { targets: [document, window] });
  return repo;
}));
async function publishTagState(error?: string): Promise<void> {
  if (!pendingSnapshot || !latestPanelPort) return;
  const snapshot = pendingSnapshot;
  const meetKey = meetKeyFor(snapshot);
  try {
    const repo = await repoForTags();
    const rows = await repo.list('tags', { index: 'byMeet', value: meetKey });
    const ownTeamId = await readScorerOwnTeam(repo, meetKey);
    const rulePresetRef = await readScorerRulePreset(repo, meetKey);
    const rulePreset = rulePresetRef ? await resolveRulePreset(repo, rulePresetRef) : { found: false as const };
    const choices = await listRulePresetChoices(repo, rulePresetRef);
    const selectedSession = await readSessionPreset(repo, meetKey);
    const loadPreference = await readSessionLoadPreference(repo, meetKey);
    const planner = buildPlannerState(snapshot, meetKey, rulePreset.found ? rulePreset.value : undefined, selectedSession.preset, loadPreference);
    const sessionSchedule: ScorerTagStateMessage['sessionSchedule'] = selectedSession.ref
      ? { ref: selectedSession.ref, ...(selectedSession.preset ? { preset: selectedSession.preset } : {}), ...(sessionScheduleError ? { error: sessionScheduleError } : {}) }
      : { note: 'No session preset is chosen for this meet. Choose one in the docked dashboard first.' };
    const tags = rows.map(t => ({ teamId: String(t.teamId), swimmerId: String(t.swimmerId), role: t.role }));
    const selectedOwnTeam = ownTeamId && snapshot.teams.some(team => String(team.id) === String(ownTeamId)) ? String(ownTeamId) : undefined;
    const suggestions = await suggestOpponentRosters(snapshot, meetKey, selectedOwnTeam, tags as ScorerTag[], rulePreset.found ? rulePreset.value : undefined,
      (lp, options) => optimizer.solveLp(lp, options));
    if (pendingSnapshot !== snapshot || !latestPanelPort) return;
    const scored = scoreScorerTags(snapshot, meetKey, selectedOwnTeam !== undefined, [...tags, ...suggestedTags(suggestions)] as ScorerTag[], rulePreset.found ? rulePreset.value : undefined);
      latestPanelPort.postMessage({ kind: 'scorer-tag-state', meetKey,
      teams: snapshot.teams.map(t => ({ id: String(t.id), name: t.name })),
      swimmers: (snapshot.swimmers ?? []).map(s => ({ id: String(s.id), teamId: String(s.teamId), name: s.display_name || s.name || String(s.id), gender: s.gender || 'Unknown' })),
      tags, ownTeamId: selectedOwnTeam, rulePresetRef, rulePreset: rulePreset.found ? rulePreset.value : undefined, rulePresetChoices: choices.map(c => ({ ref: c.ref, label: c.label })),
      scoringTeamSize: scored.scoringTeamSize, warnings: scored.warnings,
        suggestions: suggestions.map(s => ({ teamId: s.teamId, gender: s.gender, result: s.result })), cutTags: panelCutTags(snapshot, meetKey), planner, sessionSchedule, ...(error ? { error } : {}) } satisfies ScorerTagStateMessage);
  } catch (cause) {
    latestPanelPort.postMessage({ kind: 'scorer-tag-state', meetKey, teams: snapshot.teams.map(t => ({ id: String(t.id), name: t.name })), swimmers: (snapshot.swimmers ?? []).map(s => ({ id: String(s.id), teamId: String(s.teamId), name: s.display_name || s.name || String(s.id), gender: s.gender || 'Unknown' })), tags: [], warnings: [], error: `Could not load saved scorer tags or team: ${cause instanceof Error ? cause.message : String(cause)}` } satisfies ScorerTagStateMessage);
  }
}
async function handleTagAction(action: ScorerTagActionMessage): Promise<void> {
  if (!pendingSnapshot || !latestPanelPort) return;
  const meetKey = meetKeyFor(pendingSnapshot);
  try {
    const repo = await repoForTags();
    if (action.action === 'choose-rule-preset' && action.rulePresetRef) {
      await saveScorerRulePreset(repo, meetKey, action.rulePresetRef);
      await publishTagState();
      return;
    }
    if (!action.teamId) throw new Error('The selected team is missing');
    if (!pendingSnapshot.teams.some(team => String(team.id) === action.teamId)) throw new Error('The selected team is not in the current simulator snapshot');
    if (action.action !== 'choose-team' && !pendingSnapshot.swimmers?.some(swimmer => String(swimmer.id) === action.swimmerId && String(swimmer.teamId) === action.teamId)) {
      throw new Error('The selected swimmer is not on that team in the current simulator snapshot');
    }
    if (action.action === 'choose-team') await saveScorerOwnTeam(repo, meetKey, toSwimCloudId(action.teamId));
    else if (action.swimmerId) {
      const teamId = toSwimCloudId(action.teamId); const swimmerId = toSwimCloudId(action.swimmerId);
      const key: [string, string, string] = [meetKey, teamId, swimmerId];
      const current = await repo.get('tags', key);
      if (action.action === 'clear-role') { if (current.found) await repo.delete('tags', key, current.value.rev); }
      else if (action.role) await repo.put('tags', { meetKey, teamId, swimmerId, role: action.role }, current.found ? current.value.rev : 'new');
    }
    await publishTagState();
  } catch (cause) {
    await publishTagState(`Could not save scorer tag: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
async function handleSessionPresetEdit(raw: unknown): Promise<void> {
  if (!pendingSnapshot || !latestPanelPort) return;
  const meetKey = meetKeyFor(pendingSnapshot);
  try {
    const repo = await repoForTags();
    const selected = await readSessionPreset(repo, meetKey);
    if (!selected.ref) throw new Error('Choose a session preset in the docked dashboard before editing the schedule.');
    await saveEditedSessionPreset(repo, meetKey, selected.ref, raw);
    sessionScheduleError = undefined;
  } catch (cause) { sessionScheduleError = cause instanceof Error ? cause.message : String(cause); }
  await publishTagState();
}
// Top level, before the first render: the overlay connects as soon as the iframe has loaded.
const nonce = host === 'docked' ? readNonce(location.hash) : null;
const panel = nonce ? listenForPanelPort(chrome.runtime, nonce, (snapshot) => {
  pendingSnapshot = snapshot;
  window.dispatchEvent(new CustomEvent('osx-snapshot', { detail: snapshot }));
  latestPanelPort?.postMessage({ kind: 'scorer-tags-loading' });
  void publishTagState();
}, action => { void handleTagAction(action); }, port => { latestPanelPort = port; void publishTagState(); }, raw => { void handleSessionPresetEdit(raw); }) : null;
// `__OSX_HARNESS__` is false in the production build, so esbuild drops this call and the probe.
if (__OSX_HARNESS__) installHarness(host ?? 'unknown', panel);
const root = createRoot(container);
root.render(<App host={host} />);
