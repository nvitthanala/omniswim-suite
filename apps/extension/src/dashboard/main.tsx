/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dashboard. One bundle, two hosts: `?host=tab` (a browser tab) and `?host=docked` (the iframe in the simulator
 * page). This file wires the page to the world: the simulator snapshots, the overlay's port, the optimizer worker, storage and the theme.
 * What shows is in `Shell.tsx` (the frame and its slots), `liveView.tsx` (the docked tabs) and `tabHost.tsx` (the tab's sections).
 * The page is the only owner of the worker and of storage writes (D3 0.2, 0.4).
 */
import { createRoot } from 'react-dom/client';
import * as React from 'react';
import { swimmerLabel, teamLabel } from '../shared/names';
import { installHarness } from './harness';
import { listenForPanelPort, postPanelMessageSafely, readNonce } from './panelPort';
import { bindTheme, createAccentSync } from '../shared/theme';
import { SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';
import type { ScorerTag } from '@omniswim/engine';
import { createChromeChangeBus, createStorageRepo, createUndoStack, openOmniDb, readScorerOwnTeam, saveScorerOwnTeam, readScorerRulePreset, saveScorerRulePreset, listRulePresetChoices, resolveRulePreset, watchChanges, toSwimCloudId, readSessionPreset, readSessionLoadPreference, saveEditedSessionPreset } from '../storage';
import type { StorageRepo } from '../storage';
import type { UndoStack } from '../storage';
import type { AutoBuildStatusMessage, PanelSize, ScorerTagActionMessage, ScorerTagStateMessage, ThemeStateMessage } from '../shared/panelProtocol';
import { buildPlannerState, rosterErrorState } from './plannerState';
import { currentLabelOf, loadLiveModel, rosterSeasonNote } from './liveModel';
import type { LiveLoader, LiveOutcome } from './liveModel';
import type { RulePreset } from '@omniswim/engine';
import { panelCutTags, scoreScorerTags } from './scorerTagScoring';
import { createOptimizerClient } from './optimizerClient';
import { suggestOpponentRosters, suggestedTags } from './suggestedRosters';
import './dashboard.css';
import { postDockedParityReport } from './parity';
import { SessionPlannerEditor } from './sessionPlannerEditor';
import type { PlannerSubscribe } from './sessionPlannerEditor';
import { AutoBuilderPanel } from './autoBuilderPanel';
import { DockedShell, HostShell } from './Shell';
import type { ShellTab } from './Shell';
import { ChartTab, SaveTab, ScoreTab, viewOf, WaitingNote } from './liveView';
import type { View } from './liveView';
import { MeetsView, PresetsSlot, SettingsView } from './tabHost';
import type { SettingsSubscribe } from './tabHost';
import { meetKeyForSnapshot } from './meetKey';
import { readSetting, readThemeSettings } from './settingsStore';
import { createRosterFlow } from './rosterFlow';
import { RosterTab } from './rosterTab';

export type DashboardHost = 'tab' | 'docked';

/** `null` when the param is missing or not one of the two hosts. Nothing is guessed. */
export function readHost(search: string): DashboardHost | null {
  const host = new URLSearchParams(search).get('host');
  return host === 'tab' || host === 'docked' ? host : null;
}

/** The repo, once the database is open. `null` until then. */
function useRepo(): StorageRepo | null {
  const [repo, setRepo] = React.useState<StorageRepo | null>(null);
  React.useEffect(() => {
    let live = true;
    void repoForTags().then((r) => { if (live) setRepo(r); });
    return () => { live = false; };
  }, []);
  return repo;
}

function TabHostApp(): React.ReactElement {
  const repo = useRepo();
  const tabs: readonly ShellTab[] = [
    { id: 'meets', label: 'Meets', render: () => (repo ? <MeetsView repo={repo} /> : <p>Opening the saved data…</p>) },
    { id: 'presets', label: 'Presets', render: () => (repo ? <PresetsSlot repo={repo} /> : <p>Opening the saved data…</p>) },
    { id: 'settings', label: 'Settings', render: () => (repo ? <SettingsView repo={repo} onApplied={() => void applyStoredTheme()} subscribe={subscribeToSettings} /> : <p>Opening the saved data…</p>) },
  ];
  return <HostShell tabs={tabs} hostLabel="host: tab" />;
}

function DockedApp({ view, rosterNote }: { view: View; rosterNote: string | null }): React.ReactElement {
  const tabUrl = React.useMemo(() => chrome.runtime.getURL('dashboard.html?host=tab'), []);
  const scored = view.kind === 'scored' ? view : null;
  const tabs: readonly ShellTab[] = [
    { id: 'score', label: 'Score', render: () => <ScoreTab view={view} rosterNote={rosterNote} /> },
    { id: 'chart', label: 'Chart', render: ({ expanded, active }) => (scored ? <ChartTab view={scored} repoForMeet={repoForTags} expanded={expanded} active={active} /> : <WaitingNote view={view} />) },
    { id: 'build', label: 'Build', render: () => (scored ? <AutoBuilderPanel snapshot={scored.snapshot} repoForMeet={repoForTags} loadLive={liveLoader} solveLp={solveForAutoBuilder} undoStack={undoStackForDashboard} onStatus={postAutoBuildStatus} /> : <WaitingNote view={view} />) },
    { id: 'plan', label: 'Plan', render: () => (scored ? <SessionPlannerEditor snapshot={scored.snapshot} repoForMeet={repoForTags} subscribe={subscribeToPlanner} /> : <WaitingNote view={view} />) },
    { id: 'rosters', label: 'Rosters', render: ({ active }) => (scored ? <RosterTab snapshot={scored.snapshot} flow={rosterFlow} repoForMeet={repoForTags} active={active} /> : <WaitingNote view={view} />) },
    { id: 'save', label: 'Save', render: () => (scored ? <SaveTab view={scored} repoForMeet={repoForTags} loadLive={liveLoader} solveLp={solveForAutoBuilder} tabUrl={tabUrl} undo={async () => (await undoStackForDashboard()).undo()} undoStack={undoStackForDashboard} /> : <WaitingNote view={view} />) },
  ];
  return <DockedShell tabs={tabs} hostLabel="host: docked" onSize={postPanelSize} />;
}

export function App({ host }: { host: DashboardHost | null }) {
  const [view, setView] = React.useState<View>({ kind: 'empty' });
  // Decision P: Score, Chart and parity read the raw snapshot (`viewOf` calls `rescoreSimulator`). The live model never reaches them.
  const score = React.useCallback((snapshot: SimSnapshot): void => { setView(viewOf(snapshot)); }, []);
  const [rosterNote, setRosterNote] = React.useState<string | null>(null);
  const [liveTick, setLiveTick] = React.useState(0);
  React.useEffect(() => subscribeToLive(() => setLiveTick((n) => n + 1)), []);
  React.useEffect(() => {
    if (view.kind !== 'scored') { setRosterNote(null); return undefined; }
    let current = true;
    void liveLoader(view.snapshot).then((out) => {
      if (current) setRosterNote(out.kind === 'ready' ? rosterSeasonNote(out.live) : out.kind === 'error' ? `The roster season could not be applied: ${out.reason}` : null);
    }).catch((cause: unknown) => { if (current) setRosterNote(`The roster season could not be read: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { current = false; };
  }, [view, liveTick]);
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
  if (host === 'tab') return <TabHostApp />;
  if (host === 'docked') return <DockedApp view={view} rosterNote={rosterNote} />;
  return <main className="osx-dashboard"><h1>OmniSwim</h1><p data-testid="host">host: unknown</p></main>;
}

// Light until the stored choice is read (D3 section 4). The attribute selects the token set in dashboard.css.
const themeController = bindTheme(document.documentElement);
const accentSync = createAccentSync(document.documentElement);
const container = document.getElementById('root');
if (!container) throw new Error('dashboard.html has no #root element');
const host = readHost(location.search);
let pendingSnapshot: SimSnapshot | null = null;
let latestPanelPort: { postMessage(message: unknown): void } | null = null;
/** Chrome can throw when a port disconnects before onDisconnect is delivered. */
function postPanelMessage(message: unknown): void {
  const port = latestPanelPort;
  postPanelMessageSafely(port, message, () => { if (latestPanelPort === port) latestPanelPort = null; });
}
/** Roster fetches (F1.1a). The run message must reach a live port: a lost message would leave the run waiting for a `fetch-end` that never comes. */
const rosterFlow = createRosterFlow({
  post: (message) => {
    if (!latestPanelPort) throw new Error('the SwimCloud page is not connected');
    latestPanelPort.postMessage(message);
  },
  newRunId: () => crypto.randomUUID(),
  repo: () => repoForTags(),
});
/** The one live-model loader (D7 decision L). Each operation calls it once and passes the result down. */
const liveLoader: LiveLoader = async (snapshot) => loadLiveModel({ snapshot, repo: await repoForTags(), currentLabel: currentLabelOf(rosterFlow.seasons(), rosterFlow.save()), sourcing: SIMULATOR_SOURCING });
/** The Score tab's roster note listens here. It fires when the roster season, a stored roster or a class year may have changed. */
const liveListeners = new Set<() => void>();
const subscribeToLive = (listener: () => void): (() => void) => {
  liveListeners.add(listener);
  return () => { liveListeners.delete(listener); };
};
// The live model needs the current season's label and the saved rosters. Publish only when the label changes or a roster save reaches 'saved':
// a progress tick must not start LP solves.
let lastLiveLabel = currentLabelOf(rosterFlow.seasons(), rosterFlow.save());
let lastSavedRun: string | null = null;
rosterFlow.subscribe(() => {
  const label = currentLabelOf(rosterFlow.seasons(), rosterFlow.save());
  const save = rosterFlow.save();
  const savedRun = save.kind === 'saved' ? save.runId : null;
  if (label === lastLiveLabel && (savedRun === null || savedRun === lastSavedRun)) return;
  lastLiveLabel = label;
  if (savedRun !== null) lastSavedRun = savedRun;
  void publishTagState();
  for (const listener of liveListeners) listener();
});
let sessionScheduleError: string | undefined;
let tagRepo: Promise<StorageRepo> | undefined;
/** The tab host's Settings view listens here for a settings change another context made. */
const settingsListeners = new Set<() => void>();
const subscribeToSettings: SettingsSubscribe = (listener) => {
  settingsListeners.add(listener);
  return () => { settingsListeners.delete(listener); };
};
/** The Plan tab listens here for a change to the session presets, the settings or the meets that another context made, such as a backup import. */
const plannerListeners = new Set<() => void>();
const subscribeToPlanner: PlannerSubscribe = (listener) => {
  plannerListeners.add(listener);
  return () => { plannerListeners.delete(listener); };
};
const optimizer = createOptimizerClient();
const solveForAutoBuilder = (lp: string, options: Readonly<Record<string, string | number | boolean>>): ReturnType<typeof optimizer.solveLp> => optimizer.solveLp(lp, options);
/** The page panel shows one status line about a build (D5 amendment 7 item 3). */
const postAutoBuildStatus = (message: AutoBuildStatusMessage): void => postPanelMessage(message);
/** The docked panel's size, as the coach last asked. Resent when the port connects, because the shell asks before the overlay has connected. */
let panelSize: PanelSize = 'compact';
function postPanelSize(size: PanelSize): void {
  panelSize = size;
  postPanelMessage({ kind: 'panel-size', size });
}
/** Read the stored theme and accent, apply them here, and tell the page panel and the docked frame's chrome (D6 section 5). */
async function applyStoredTheme(): Promise<void> {
  try {
    const stored = await readThemeSettings(await repoForTags());
    themeController.setPreference(stored.preference);
    accentSync.set(stored.accent);
    postPanelMessage({ kind: 'theme-state', preference: stored.preference, ...(stored.accent === undefined ? {} : { accent: stored.accent }) } satisfies ThemeStateMessage);
  } catch {
    // A failed read keeps the current theme. It is no reason to flash another one.
  }
}
const repoForTags = (): Promise<StorageRepo> => (tagRepo ??= openOmniDb().then(db => {
  const bus = createChromeChangeBus(chrome.storage as never);
  const repo = createStorageRepo(db, { bus });
  void watchChanges(db, bus, change => {
    const liveStores = change.stores === 'unknown' || change.stores.some(store => store === 'rosters' || store === 'classYearOverrides');
    if (change.stores === 'unknown' || change.stores.includes('tags') || change.stores.includes('settings') || liveStores) void publishTagState();
    if (liveStores || change.stores.includes('settings')) for (const listener of liveListeners) listener();
    if (change.stores === 'unknown' || change.stores.includes('settings')) {
      void applyStoredTheme();
      for (const listener of settingsListeners) listener();
    }
    if (change.stores === 'unknown' || liveStores || change.stores.some(store => store === 'sessionPresets' || store === 'settings' || store === 'meets')) {
      for (const listener of plannerListeners) listener();
    }
  }, { targets: [document, window] });
  return repo;
}));
let undoStackPromise: Promise<UndoStack> | undefined;
const undoStackForDashboard = (): Promise<UndoStack> => (undoStackPromise ??= repoForTags().then(createUndoStack));
/** The scorer-tag scoring on the live model, or a plain note when SwimCloud has not loaded the simulator results (never a silent empty). */
function scoreOrNotLoaded(loaded: Exclude<LiveOutcome, { kind: 'error' }>, hasOwnTeam: boolean, tags: readonly ScorerTag[], preset: RulePreset | undefined): ReturnType<typeof scoreScorerTags> {
  if (loaded.kind === 'ready') return scoreScorerTags(loaded.live, hasOwnTeam, tags, preset);
  return { scored: false, warnings: [`SwimCloud has not loaded the simulator results yet (${loaded.missing.join(', ')} missing).`] };
}
async function publishTagState(error?: string): Promise<void> {
  if (!pendingSnapshot || !latestPanelPort) return;
  const snapshot = pendingSnapshot;
  const meetKey = meetKeyForSnapshot(snapshot);
  try {
    const repo = await repoForTags();
    const rows = await repo.list('tags', { index: 'byMeet', value: meetKey });
    const ownTeamId = await readScorerOwnTeam(repo, meetKey);
    const rulePresetRef = await readScorerRulePreset(repo, meetKey);
    const rulePreset = rulePresetRef ? await resolveRulePreset(repo, rulePresetRef) : { found: false as const };
    const choices = await listRulePresetChoices(repo, rulePresetRef);
    const selectedSession = await readSessionPreset(repo, meetKey);
    const loadPreference = await readSessionLoadPreference(repo, meetKey);
    // One load of the live model serves the planner, the suggestions, the scoring warnings and the cut tags (D7 decision L).
    const loaded = await liveLoader(snapshot);
    const sessionSchedule: ScorerTagStateMessage['sessionSchedule'] = selectedSession.ref
      ? { ref: selectedSession.ref, ...(selectedSession.preset ? { preset: selectedSession.preset } : {}), ...(sessionScheduleError ? { error: sessionScheduleError } : {}) }
      : { note: 'No session preset is chosen for this meet. Choose one in the docked dashboard first.' };
    const tags = rows.map(t => ({ teamId: String(t.teamId), swimmerId: String(t.swimmerId), role: t.role }));
    const selectedOwnTeam = ownTeamId && snapshot.teams.some(team => String(team.id) === String(ownTeamId)) ? String(ownTeamId) : undefined;
    const base = { meetKey, teams: snapshot.teams.map(t => ({ id: String(t.id), name: teamLabel(String(t.id), t.name) })),
      swimmers: (snapshot.swimmers ?? []).map(s => ({ id: String(s.id), teamId: String(s.teamId), name: swimmerLabel(String(s.id), s.display_name || s.name || undefined), gender: s.gender || 'Unknown' })),
      tags, ownTeamId: selectedOwnTeam, rulePresetRef, rulePreset: rulePreset.found ? rulePreset.value : undefined, rulePresetChoices: choices.map(c => ({ ref: c.ref, label: c.label })), sessionSchedule };
    // The roster season could not be applied: say so, with the real tags, instead of the "could not load saved tags" error.
    if (loaded.kind === 'error') { postPanelMessage(rosterErrorState(base, loaded.reason)); return; }
    const live = loaded.kind === 'ready' ? loaded.live : null;
    const suggestions = live === null ? [] : await suggestOpponentRosters(live, selectedOwnTeam, tags as ScorerTag[], rulePreset.found ? rulePreset.value : undefined,
      (lp, options) => optimizer.solveLp(lp, options));
    if (pendingSnapshot !== snapshot || !latestPanelPort) return;
    const allTags = [...tags, ...suggestedTags(suggestions)] as ScorerTag[];
    const scored = scoreOrNotLoaded(loaded, selectedOwnTeam !== undefined, allTags, rulePreset.found ? rulePreset.value : undefined);
    // Suggestions first: the planner scores with the same tags as the scorer-tag scoring, or an NSISC meet cannot be scored at all.
    const planner = buildPlannerState(live, rulePreset.found ? rulePreset.value : undefined, selectedSession.preset, loadPreference, allTags);
    postPanelMessage({ kind: 'scorer-tag-state', ...base,
      scoringTeamSize: scored.scoringTeamSize, warnings: scored.warnings,
      suggestions: suggestions.map(s => ({ teamId: s.teamId, gender: s.gender, result: s.result })), cutTags: live === null ? [] : panelCutTags(live, (await readSetting(repo, 'cutCloseThresholdPct')) ?? 1), planner, ...(error ? { error } : {}) } satisfies ScorerTagStateMessage);
  } catch (cause) {
    postPanelMessage({ kind: 'scorer-tag-state', meetKey, teams: snapshot.teams.map(t => ({ id: String(t.id), name: teamLabel(String(t.id), t.name) })), swimmers: (snapshot.swimmers ?? []).map(s => ({ id: String(s.id), teamId: String(s.teamId), name: swimmerLabel(String(s.id), s.display_name || s.name || undefined), gender: s.gender || 'Unknown' })), tags: [], warnings: [], error: `Could not load saved scorer tags or team: ${cause instanceof Error ? cause.message : String(cause)}` } satisfies ScorerTagStateMessage);
  }
}
async function handleTagAction(action: ScorerTagActionMessage): Promise<void> {
  if (!pendingSnapshot || !latestPanelPort) return;
  const meetKey = meetKeyForSnapshot(pendingSnapshot);
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
  const meetKey = meetKeyForSnapshot(pendingSnapshot);
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
  postPanelMessage({ kind: 'scorer-tags-loading' });
  void publishTagState();
}, action => { void handleTagAction(action); }, port => { latestPanelPort = port; rosterFlow.portChanged(); void publishTagState(); void applyStoredTheme(); if (panelSize !== 'compact') postPanelSize(panelSize); }, raw => { void handleSessionPresetEdit(raw); },
// A closed port takes no more messages. Only the port in use is dropped: a newer connect may already have replaced it.
closed => { if (latestPanelPort === closed) { latestPanelPort = null; rosterFlow.portChanged(); } },
{ onFetchMessage: message => rosterFlow.handle(message), onSeasons: seasons => rosterFlow.setSeasons(seasons) }) : null;
// `__OSX_HARNESS__` is false in the production build, so esbuild drops this call and the probe.
if (__OSX_HARNESS__) installHarness(host ?? 'unknown', panel);
void applyStoredTheme();
const root = createRoot(container);
root.render(<App host={host} />);
