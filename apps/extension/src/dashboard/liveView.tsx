/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The live tabs of the docked panel (D6 section 1): Score, Chart and Save. Each takes the scored view the shell holds. Chart and Save read the
 * store only when their tab is open. Build and Plan are the existing `AutoBuilderPanel` and `SessionPlannerEditor`, mounted by the app.
 */
import * as React from 'react';
import { scoreProgression } from '@omniswim/engine';
import type { LpSolve, Progression, Results, TeamId } from '@omniswim/engine';
import type { ParityReport } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { readScorerOwnTeam, readSessionPreset } from '../storage';
import type { StorageRepo } from '../storage';
import type { UndoStack } from '../storage';
import { meetKeyForSnapshot } from './meetKey';
import { resolveRival } from './rival';
import { readRival } from './settingsStore';
import { ScoreChart } from './ScoreChart';
import { defaultSnapshotName, saveLineup, saveSnapshot } from './snapshotSave';
import type { SaveSnapshotOutcome } from './snapshotSave';

export type View =
  | { kind: 'empty' }
  | { kind: 'error'; code: string; reason: string }
  | { kind: 'not_loaded'; missing: readonly string[] }
  | { kind: 'preset_incomplete'; pending: readonly string[] }
  | { kind: 'scored'; snapshot: SimSnapshot; results: Results; parity: ParityReport };

export type ScoredView = Extract<View, { kind: 'scored' }>;

const teamName = (snapshot: SimSnapshot, id: string): string => snapshot.teams.find((t) => String(t.id) === id)?.name ?? id;

/** What the docked panel says before there is a scored view. The Score tab shows the status; the other tabs say they wait for it. */
export function WaitingNote({ view }: { view: View }): React.ReactElement {
  return <p className="osx-status osx-status--warn" data-testid="waiting">{view.kind === 'empty' ? 'Waiting for the SwimCloud simulator results.' : 'The simulator results are not ready, see the Score tab.'}</p>;
}

export function ScoreTab({ view }: { view: View }): React.ReactElement {
  if (view.kind === 'empty') return <p data-testid="waiting">Waiting for the SwimCloud simulator results.</p>;
  return (
    <section className="osx-results" aria-live="polite">
      <h2>SwimCloud simulator</h2>
      {view.kind === 'error' && <p className="osx-status osx-status--warn" data-testid="parity">Not compared: {view.code} — {view.reason}</p>}
      {view.kind === 'not_loaded' && <p className="osx-status osx-status--warn" data-testid="parity">Not loaded: {view.missing.join(', ')}</p>}
      {view.kind === 'preset_incomplete' && <p className="osx-status osx-status--warn" data-testid="parity">Preset incomplete: {view.pending.join(', ')}</p>}
      {view.kind === 'scored' && <>
        <table data-testid="team-results"><thead><tr><th>Team</th><th>Engine</th><th>SwimCloud</th></tr></thead><tbody>
          {view.results.teams.map((team) => {
            const observed = view.parity.kind === 'compared' ? view.parity.teams.find((t) => t.teamId === team.teamId)?.observed : undefined;
            return <tr key={team.teamId}><th scope="row">{teamName(view.snapshot, String(team.teamId))}</th><td>{team.points}</td><td>{observed === undefined ? '—' : observed}</td></tr>;
          })}
        </tbody></table>
        {view.parity.kind === 'not_observed' && <p className="osx-status osx-status--warn" data-testid="parity">Not observed</p>}
        {view.parity.kind === 'compared' && (view.parity.matches
          ? <p className="osx-status osx-status--good" data-testid="parity">Matches SwimCloud</p>
          : <div className="osx-status osx-status--bad" data-testid="parity"><p>{view.parity.differingEvents.length} differing events</p><ul>{view.parity.differingEvents.flatMap((event) => event.rows.filter((row) => row.status === 'mismatch').map((row) => (
            <li key={`${event.eventKey}:${row.entryKey}`}>{event.eventKey}, {teamName(view.snapshot, String(row.teamId))}: engine {row.engine} vs SwimCloud {row.observed ?? 'not stated'}</li>
          )))}</ul></div>)}
      </>}
    </section>
  );
}

type ChartState =
  | { kind: 'loading' }
  | { kind: 'need_team' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; own: TeamId; rival: TeamId | null; chosen: boolean; progression: Progression; scheduled: boolean };

/** The chart of the live results: the coach's team in the accent, the rival dashed, the rest muted (D6 section 5). */
/** `active` is false while the tab is hidden. The chart reads the store each time the tab shows, so a team chosen meanwhile is seen. */
export function ChartTab({ view, repoForMeet, expanded, active }: { view: ScoredView; repoForMeet: () => Promise<StorageRepo>; expanded: boolean; active: boolean }): React.ReactElement {
  const [state, setState] = React.useState<ChartState>({ kind: 'loading' });
  React.useEffect(() => {
    if (!active) return undefined;
    let live = true;
    void (async () => {
      try {
        const repo = await repoForMeet();
        const meetKey = meetKeyForSnapshot(view.snapshot);
        const own = await readScorerOwnTeam(repo, meetKey);
        if (own === undefined || !view.results.teams.some((t) => String(t.teamId) === String(own))) { if (live) setState({ kind: 'need_team' }); return; }
        const rival = resolveRival(view.results, String(own) as TeamId, await readRival(repo, meetKey));
        const schedule = (await readSessionPreset(repo, meetKey)).preset ?? null;
        const progression = scoreProgression(view.results, schedule);
        if (live) setState({ kind: 'ready', own: String(own) as TeamId, rival: rival.teamId, chosen: rival.chosen, progression, scheduled: schedule !== null });
      } catch (cause) {
        if (live) setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
    return () => { live = false; };
  }, [view, repoForMeet, active]);
  const names = React.useMemo(() => Object.fromEntries(view.snapshot.teams.map((t) => [String(t.id), t.name])) as Record<TeamId, string>, [view.snapshot]);
  if (state.kind === 'loading') return <p data-testid="chart-loading">Loading the chart…</p>;
  if (state.kind === 'need_team') return <p className="osx-status osx-status--warn" data-testid="chart-need-team">Choose your team in the page panel to draw the chart.</p>;
  if (state.kind === 'error') return <p className="osx-status osx-status--bad" role="alert" data-testid="chart-error">The chart could not be drawn: {state.message}</p>;
  return (
    <section data-testid="chart">
      <ScoreChart progression={state.progression} ownTeamId={state.own} rivalTeamId={state.rival} teamNames={names} width={expanded ? 600 : 320} height={expanded ? 300 : 180} />
      <p className="osx-chart-note" data-testid="chart-rival">
        {state.rival === null ? 'No rival: there is no other team.' : `Rival: ${names[state.rival] ?? state.rival} (${state.chosen ? 'your choice, set in Settings' : 'the team closest to you on points'}).`}
      </p>
    </section>
  );
}

export interface SaveTabProps {
  readonly view: ScoredView;
  readonly repoForMeet: () => Promise<StorageRepo>;
  readonly solveLp: LpSolve;
  /** The URL of this dashboard as a browser tab. */
  readonly tabUrl: string;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly undo?: () => Promise<{ status: 'undone' | 'empty' | 'changed elsewhere' }>;
  readonly undoStack?: () => Promise<UndoStack>;
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string } | (SaveSnapshotOutcome & { savedAs?: 'snapshot' | 'lineup' });

export function SaveTab({ view, repoForMeet, solveLp, tabUrl, undo, undoStack, now = () => new Date().toISOString(), newId = () => crypto.randomUUID() }: SaveTabProps): React.ReactElement {
  const [name, setName] = React.useState('');
  const [state, setState] = React.useState<SaveState>({ kind: 'idle' });
  const [undoMessage, setUndoMessage] = React.useState('');
  const save = async (kind: 'snapshot' | 'lineup'): Promise<void> => {
    setState({ kind: 'saving' });
    try {
      const outcome = await (kind === 'snapshot' ? saveSnapshot : saveLineup)(view.snapshot, name, { repo: await repoForMeet(), solveLp, now, newId, ...(undoStack ? { undoStack: await undoStack() } : {}) });
      setState(outcome.kind === 'saved' ? { ...outcome, savedAs: kind } : outcome);
    } catch (cause) {
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  return (
    <section className="osx-save" data-testid="save">
      <h2>Save this result</h2>
      <p>A snapshot keeps these results, your scorer tags and the seed times, so you can report on them later. It never changes after you save it.</p>
      <label>Name <input type="text" data-testid="snapshot-name" placeholder={defaultSnapshotName(now())} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <p>
        <button type="button" data-testid="snapshot-save" disabled={state.kind === 'saving'} onClick={() => void save('snapshot')}>Save snapshot</button>
        {' '}
        <button type="button" data-testid="lineup-save" disabled={state.kind === 'saving'} onClick={() => void save('lineup')}>Save lineup</button>
        {' '}
        <button type="button" data-testid="undo" disabled={!undo} onClick={() => {
          if (undo) void undo().then((outcome) => setUndoMessage(outcome.status === 'undone' ? 'Undone.' : outcome.status === 'empty' ? 'Nothing to undo.' : 'This record changed in another tab. Nothing was undone.'));
        }}>Undo</button>
        {' '}
        <a href={tabUrl} target="_blank" rel="noopener noreferrer" data-testid="open-in-tab">Open in tab</a>
      </p>
      <div role="status" aria-live="polite" data-testid="snapshot-status" data-phase={state.kind}>
        {state.kind === 'saving' && 'Saving…'}
        {state.kind === 'saved' && `Saved ${state.savedAs ?? 'snapshot'} "${state.name}". Open it in the tab${state.savedAs === 'lineup' ? ' to see its saved entries' : ' to report on it'}.`}
        {state.kind === 'refused' && <>Not saved:<ul>{state.reasons.map((r) => <li key={r}>{r}</li>)}</ul></>}
        {state.kind === 'error' && `Not saved: ${state.message}`}
      </div>
      <p role="status" aria-live="polite" data-testid="undo-status">{undoMessage}</p>
    </section>
  );
}
