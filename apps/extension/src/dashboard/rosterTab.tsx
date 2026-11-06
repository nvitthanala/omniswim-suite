/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Rosters tab of the docked panel (F1.1a, D7 section 4). It asks SwimCloud for one roster page per team, only when the coach clicks Fetch and
 * has turned fetching on. It shows each team's roster status, the class year of each swimmer with its source, and what the chosen roster season does
 * to membership. The chosen season is stored per meet (`rosterSeasonsByMeet`) and applies to Build, Plan and the scorer tags through the live model
 * (`liveModel.ts`). It never feeds the Score tab: parity reads the raw snapshot (D7 decision P).
 */
import * as React from 'react';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { AdaptedSimulator } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { swimmerLabel, teamLabel } from '../shared/names';
import { CLASS_YEARS, classifyRoster, toSwimCloudId } from '../storage';
import type { ClassYearCode, ClassYearOverrideRecord, RosterRecord, StorageRepo } from '../storage';
import type { RosterFlow, RosterSaveState, SeasonList } from './rosterFlow';
import { currentLabelOf, loadLiveStored } from './liveModel';
import type { LiveStored } from './liveModel';
import { describeRequests, planRosterRequests } from './rosterPlan';
import type { PlannedRosterRequest, RosterPlan, RosterSeasonChoice } from './rosterPlan';
import { buildTeamView } from './rosterView';
import type { TeamRosterView } from './rosterView';
import { meetKeyForSnapshot } from './meetKey';
import { readFetchPosture, readRosterSeason, saveFetchPosture, saveRosterSeason } from './settingsStore';
import type { RunState } from './fetchClient';

const GENDERS = { M: 'Men', F: 'Women' } as const;
type Posture = 'off' | 'on-click';

export function runStatusText(state: RunState<PlannedRosterRequest>): string {
  switch (state.phase) {
    case 'idle': return '';
    case 'running': return `Fetching: ${state.received} of ${state.total} received${state.waitingMs !== null && state.waitingMs > 0 ? `, next request in ${Math.ceil(state.waitingMs / 1000)} s` : ''}.`;
    case 'finished': return `All ${state.items.length} pages arrived.`;
    case 'failed': return state.detail;
  }
}

/** Said in the tab, always: where a chosen roster season applies and where it does not (architect ruling 2, F1.1a). */
const APPLIES = "A roster season you choose here applies to Build (AutoBuilder), Plan and the scorer tags. A swimmer who is not on that roster loses their entries there, and a scorer tag on them is not used. Score, Chart and the SwimCloud check stay on SwimCloud's own table. You cannot save a snapshot or a lineup, or Accept an AutoBuilder proposal, while a roster season is chosen. Simulator (current) removes no entry and no tag.";
const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ') + ' UTC';
const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function teamStatus(record: RosterRecord | undefined): string {
  if (!record) return 'Not loaded';
  return classifyRoster(record) === 'verified-empty' ? `No roster posted (${when(record.fetchedAt)})` : `${record.memberIds.length} swimmers (${when(record.fetchedAt)})`;
}

function safeAdapt(snapshot: SimSnapshot): AdaptedSimulator | null {
  try {
    const out = adaptSimulatorSnapshot(snapshot, { meetKey: meetKeyForSnapshot(snapshot), snapshotId: 'live-snapshot' });
    return out.kind === 'ready' ? out.adapted : null;
  } catch { return null; }
}

function safeTeamView(input: Parameters<typeof buildTeamView>[0]): TeamRosterView | { readonly error: string } {
  try { return buildTeamView(input); } catch (cause) { return { error: errorText(cause) }; }
}

function refusalText(save: RosterSaveState, teamId: string): string | null {
  if (save.kind !== 'saved') return null;
  const parts: string[] = [];
  for (const r of save.reports) {
    if (r.request.target.teamId !== teamId) continue;
    if (r.status.kind === 'refused') parts.push(`Refused (${r.status.code}): ${r.status.detail}`);
    else if (r.status.kind === 'write-failed') parts.push(`Not saved: ${r.status.detail}`);
  }
  return parts.length === 0 ? null : parts.join(' ');
}

async function writeOverride(repo: StorageRepo, swimmerId: string, seasonId: string, value: string): Promise<void> {
  const id = toSwimCloudId(swimmerId);
  const existing = await repo.get('classYearOverrides', [id, seasonId]);
  if (value === '') {
    if (existing.found) await repo.delete('classYearOverrides', [id, seasonId], existing.value.rev);
    return;
  }
  const code = CLASS_YEARS.find((c) => c === value);
  if (!code) throw new RangeError(`${value} is not a class year`);
  const createdAt = existing.found ? existing.value.createdAt : new Date().toISOString();
  await repo.put('classYearOverrides', { swimmerId: id, seasonId, classYear: code, origin: { kind: 'local' }, createdAt }, existing.found ? existing.value.rev : 'new');
}

function FetchControls(props: {
  readonly flow: RosterFlow; readonly seasons: SeasonList | null; readonly choiceLabel: string; readonly onChoice: (label: string) => void;
  readonly posture: Posture; readonly onPosture: (next: Posture) => void; readonly plan: RosterPlan; readonly run: RunState<PlannedRosterRequest>;
  readonly save: RosterSaveState; readonly onFetch: () => void;
}): React.ReactElement {
  const { flow, seasons, choiceLabel, posture, plan, run, save } = props;
  const running = run.phase === 'running';
  return (
    <>
      <h2>Rosters and class years</h2>
      <p className="osx-roster-note">OmniSwim asks SwimCloud for one roster page per team when you click Fetch, at most one request every 3 seconds. Nothing else is requested.</p>
      <label className="osx-roster-line">
        <input type="checkbox" data-testid="roster-posture" checked={posture === 'on-click'} onChange={(e) => props.onPosture(e.currentTarget.checked ? 'on-click' : 'off')} /> Allow these requests when I click Fetch
      </label>
      <label className="osx-roster-line">Roster season{' '}
        <select data-testid="roster-season" value={choiceLabel} onChange={(e) => props.onChoice(e.currentTarget.value)}>
          <option value="">Simulator (current)</option>
          {(seasons?.seasons ?? []).map((s) => <option key={s.label} value={s.label}>{s.label}{s.isCurrent ? ' (current)' : ''}</option>)}
          {/* The stored choice is always an option, even when the season list is missing or lacks it: the select must not show a season that is not applied. */}
          {choiceLabel !== '' && !(seasons?.seasons ?? []).some((s) => s.label === choiceLabel) && <option value={choiceLabel}>{choiceLabel}</option>}
        </select>
      </label>
      {!seasons && <p className="osx-status osx-status--warn" data-testid="roster-no-seasons">The season list has not arrived from the SwimCloud page, so only "Simulator (current)" can be fetched.</p>}
      <p>
        <button type="button" data-testid="roster-fetch" disabled={running || !plan.ok || posture !== 'on-click'} onClick={props.onFetch}>
          {plan.ok ? `Fetch rosters (${describeRequests(plan.requests.length, plan.estimateMs)})` : 'Fetch rosters'}
        </button>
        {running && <> <button type="button" data-testid="roster-cancel" onClick={() => flow.client.cancel()}>Cancel</button></>}
      </p>
      {posture !== 'on-click' && <p className="osx-status osx-status--warn" data-testid="roster-posture-off">Fetching is off. Tick the box above to allow it.</p>}
      {!plan.ok && <p className="osx-status osx-status--warn" data-testid="roster-plan-refused">{plan.reason}</p>}
      <div role="status" aria-live="polite" data-testid="roster-run" data-phase={run.phase}>
        {run.phase === 'failed' ? <span className="osx-status osx-status--bad" role="alert">Not saved: {runStatusText(run)}</span> : runStatusText(run)}
        {save.kind === 'saving' && ' Saving…'}
        {save.kind === 'save-failed' && <span className="osx-status osx-status--bad" role="alert"> Not saved: {save.detail}</span>}
      </div>
    </>
  );
}

function TeamList(props: { readonly snapshot: SimSnapshot; readonly stored: LiveStored | null; readonly save: RosterSaveState }): React.ReactElement {
  return (
    <>
      <h3>Teams</h3>
      <ul className="osx-roster-teams" data-testid="roster-teams">
        {props.snapshot.teams.map((t) => {
          const id = String(t.id);
          const refusal = refusalText(props.save, id);
          return (
            <li key={id} data-testid={`roster-team-${id}`}>
              <strong>{teamLabel(id, t.name)}</strong>: {teamStatus(props.stored?.membership.get(id))}
              {refusal && <span className="osx-status osx-status--bad" role="alert"> {refusal} The earlier roster, if any, is kept.</span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function MembershipNotes(props: { readonly view: TeamRosterView; readonly choiceLabel: string; readonly membershipLabel: string | null; readonly names: ReadonlyMap<string, string | undefined> }): React.ReactElement {
  const { view, choiceLabel, names } = props;
  const note = view.enrichment.teams.find((t) => t.teamId === view.teamId);
  const removed = view.enrichment.removedEntries;
  return (
    <>
      {note?.notes.map((n) => <p key={n} className="osx-status osx-status--warn" data-testid="roster-note">{n}</p>)}
      {note && note.rosterOnly.length > 0 && <p data-testid="roster-only">{note.rosterOnly.length} on the {props.membershipLabel ?? ''} roster have no swims here.</p>}
      {note && choiceLabel === '' && note.notOnRoster.length > 0 && <p className="osx-status osx-status--warn" data-testid="roster-mismatch">{note.notOnRoster.length} simulator swimmers are not on the fetched roster. They stay members: the simulator is the source.</p>}
      {removed.length > 0 && (
        <div data-testid="roster-removed">
          <p className="osx-status osx-status--warn">{removed.length} lineup entries are left out of Build and Plan, because the swimmer is not on the {choiceLabel} roster. A scorer tag on that swimmer is not used. Score still shows SwimCloud's own lineup.</p>
          <ul>{removed.map((r) => <li key={r.entryKey}>{r.kind === 'relay' ? 'Relay' : 'Entry'} {r.eventKey}: {r.swimmerIds.map((id) => swimmerLabel(id, names.get(id))).join(', ')}</li>)}</ul>
        </div>
      )}
    </>
  );
}

function ClassYearTable(props: {
  readonly view: TeamRosterView; readonly names: ReadonlyMap<string, string | undefined>; readonly overrides: readonly ClassYearOverrideRecord[];
  readonly currentLabel: string | null; readonly onOverride: (swimmerId: string, value: string) => void;
}): React.ReactElement {
  return (
    <table data-testid="roster-rows">
      <thead><tr><th>Swimmer</th><th>On roster</th><th>Class</th><th>Source</th><th>Set class</th></tr></thead>
      <tbody>
        {props.view.rows.map((row) => {
          const override = props.overrides.find((o) => o.swimmerId === row.swimmerId);
          const label = swimmerLabel(row.swimmerId, props.names.get(row.swimmerId));
          return (
            <tr key={row.swimmerId} data-testid={`roster-row-${row.swimmerId}`}>
              <th scope="row">{label}</th>
              <td>{row.membership === 'unknown' ? <span aria-label="roster membership unknown" title="Roster membership unknown">?</span> : row.membership === 'not_member' ? 'No' : 'Yes'}</td>
              <td>{row.classYear ?? '?'}</td>
              <td>{row.source}</td>
              <td>
                <select aria-label={`Set the class year of ${label}`} data-testid={`roster-override-${row.swimmerId}`} disabled={props.currentLabel === null}
                  title={props.currentLabel === null ? 'The current season is not known yet.' : undefined} value={override?.classYear ?? ''} onChange={(e) => props.onOverride(row.swimmerId, e.currentTarget.value)}>
                  <option value="">{override ? 'Clear my choice' : 'Not set'}</option>
                  {(CLASS_YEARS as readonly ClassYearCode[]).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface RosterTabProps {
  readonly snapshot: SimSnapshot;
  readonly flow: RosterFlow;
  readonly repoForMeet: () => Promise<StorageRepo>;
  readonly active: boolean;
}

export function RosterTab({ snapshot, flow, repoForMeet, active }: RosterTabProps): React.ReactElement {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => flow.subscribe(bump), [flow]);
  // The stored choice for this meet; '' is Simulator (current). It is read from storage with the rosters, never held only here.
  const [choiceLabel, setChoiceLabel] = React.useState('');
  const [teamId, setTeamId] = React.useState('');
  const [posture, setPosture] = React.useState<Posture>('off');
  const [stored, setStored] = React.useState<LiveStored | null>(null);
  const [message, setMessage] = React.useState('');
  const [reload, setReload] = React.useState(0);

  const seasons = flow.seasons();
  const run = flow.client.state();
  const save = flow.save();
  const gender = snapshot.settings.gender === 'F' ? 'F' : snapshot.settings.gender === 'M' ? 'M' : null;
  const teamIds = snapshot.teams.map((t) => String(t.id));
  const teamKey = teamIds.join(',');
  const choice: RosterSeasonChoice = choiceLabel === '' ? { kind: 'simulator-current' } : { kind: 'season', label: choiceLabel };
  const plan: RosterPlan = gender === null ? { ok: false, reason: 'The simulator does not say men or women.' } : planRosterRequests({ teamIds, gender, choice, seasons });
  const selectedTeam = teamIds.includes(teamId) ? teamId : (teamIds[0] ?? '');
  const currentLabel = currentLabelOf(seasons, save);
  const membershipLabel = choiceLabel === '' ? currentLabel : choiceLabel;
  const meetKey = meetKeyForSnapshot(snapshot);
  const adapted = React.useMemo(() => safeAdapt(snapshot), [snapshot]);

  React.useEffect(() => {
    if (!active || gender === null) return undefined;
    let live = true;
    const ids = teamKey === '' ? [] : teamKey.split(',');
    void (async () => {
      try {
        const repo = await repoForMeet();
        const nextPosture = await readFetchPosture(repo);
        const storedChoice = await readRosterSeason(repo, meetKey);
        const nextLabel = storedChoice.kind === 'season' ? storedChoice.label : '';
        const next = await loadLiveStored(repo, ids, GENDERS[gender], nextLabel === '' ? currentLabel : nextLabel, currentLabel);
        if (live) { setPosture(nextPosture); setChoiceLabel(nextLabel); setStored(next); }
      } catch (cause) {
        if (live) setMessage(`The saved rosters could not be read: ${errorText(cause)}`);
      }
    })();
    return () => { live = false; };
  }, [active, gender, teamKey, meetKey, currentLabel, repoForMeet, reload, save, run.phase]);

  const view = !adapted || !stored || !selectedTeam ? null
    : safeTeamView({ adapted, teamId: selectedTeam, mode: choiceLabel === '' ? 'simulator-current' : 'season', membershipRoster: stored.membership.get(selectedTeam), currentRoster: stored.current.get(selectedTeam), overrides: stored.overrides, currentLabel });
  const names = new Map((snapshot.swimmers ?? []).map((s) => [String(s.id), s.display_name || s.name || undefined] as const));

  const onFetch = (): void => {
    if (gender === null) return;
    const result = flow.fetchRosters({ teamIds, gender, choice, posture });
    setMessage(result.ok ? '' : result.reason);
  };
  const onChoice = (label: string): void => {
    void repoForMeet().then((repo) => saveRosterSeason(repo, meetKey, label === '' ? { kind: 'simulator-current' } : { kind: 'season', label }))
      .then(() => { setMessage(''); setStored(null); setChoiceLabel(label); setReload((n) => n + 1); })
      .catch((cause: unknown) => setMessage(`Not saved: ${errorText(cause)}`));
  };
  const onPosture = (next: Posture): void => {
    if (next === 'off') flow.client.cancel(); // turning fetching off ends a run that is going; the overlay answers with fetch-end
    void repoForMeet().then((repo) => saveFetchPosture(repo, next)).then(() => setPosture(next)).catch((cause: unknown) => setMessage(`Not saved: ${errorText(cause)}`));
  };
  const onOverride = (swimmerId: string, value: string): void => {
    if (currentLabel === null) return;
    void repoForMeet().then((repo) => writeOverride(repo, swimmerId, currentLabel, value)).then(() => { setMessage(''); setReload((n) => n + 1); })
      .catch((cause: unknown) => setMessage(`Not saved: ${errorText(cause)}`));
  };

  return (
    <section className="osx-roster" data-testid="roster-tab">
      <FetchControls flow={flow} seasons={seasons} choiceLabel={choiceLabel} onChoice={onChoice} posture={posture} onPosture={onPosture} plan={plan} run={run} save={save} onFetch={onFetch} />
      <p className="osx-status osx-status--warn" data-testid="roster-applies">{APPLIES}</p>
      {message && <p className="osx-status osx-status--bad" role="alert" data-testid="roster-message">{message}</p>}
      <TeamList snapshot={snapshot} stored={stored} save={save} />
      <h3>Class years</h3>
      <label className="osx-roster-line">Team{' '}
        <select data-testid="roster-team" value={selectedTeam} onChange={(e) => setTeamId(e.currentTarget.value)}>
          {snapshot.teams.map((t) => <option key={String(t.id)} value={String(t.id)}>{teamLabel(String(t.id), t.name)}</option>)}
        </select>
      </label>
      {currentLabel === null && <p className="osx-status osx-status--warn" data-testid="roster-no-label">The current season is not known yet. Class years and overrides wait for the season list or a fetch.</p>}
      {view && 'error' in view && <p className="osx-status osx-status--bad" role="alert" data-testid="roster-view-error">{view.error}</p>}
      {view && 'rows' in view && (
        <>
          <MembershipNotes view={view} choiceLabel={choiceLabel} membershipLabel={membershipLabel} names={names} />
          <ClassYearTable view={view} names={names} overrides={stored?.overrides ?? []} currentLabel={currentLabel} onOverride={onOverride} />
        </>
      )}
    </section>
  );
}
