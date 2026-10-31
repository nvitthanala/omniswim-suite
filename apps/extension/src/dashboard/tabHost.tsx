/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The sections of the browser tab (D6 section 1). The tab has no live simulator data: it works from stored records.
 *
 * - Meets: per meet key, the saved lineups and snapshots. A snapshot opens as the report and the entry CSV. Its results are parsed with
 *   `parseResults` when it opens, so a record whose results cannot be read shows that error and nothing else breaks.
 * - Presets: a slot.
 * - Settings: the theme, the accent and the rival of each meet.
 */
import * as React from 'react';
import { parseResults } from '@omniswim/engine';
import type { Lineup, Results, RivalRef, RoleLabel, TeamId } from '@omniswim/engine';
import { readScorerOwnTeam } from '../storage';
import type { LineupRecord, StorageRepo } from '../storage';
import { EntryCsvButton } from './EntryCsvButton';
import { MeetReport } from './MeetReport';
import { resolveRival } from './rival';
import { clearAccent, readRival, readThemeSettings, saveAccent, saveRival, saveTheme } from './settingsStore';
import type { ThemeSettings } from './settingsStore';
import type { ThemePreference } from '../shared/theme';

// ---- Meets -------------------------------------------------------------------------------------

interface MeetGroup {
  readonly meetKey: string;
  readonly records: readonly LineupRecord[];
}

/** Newest meet first, and in each meet the newest record first. The order never depends on how the store listed them. */
export function groupByMeet(records: readonly LineupRecord[]): readonly MeetGroup[] {
  const byMeet = new Map<string, LineupRecord[]>();
  for (const record of records) byMeet.set(record.meetKey, [...(byMeet.get(record.meetKey) ?? []), record]);
  const newest = (a: LineupRecord, b: LineupRecord): number => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.lineupId < b.lineupId ? -1 : 1);
  return [...byMeet].map(([meetKey, list]) => ({ meetKey, records: [...list].sort(newest) })).sort((a, b) => newest(a.records[0] as LineupRecord, b.records[0] as LineupRecord));
}

/** Team names of a record, from the SwimCloud display data it carries (absent when the record was stripped of it). */
const teamNamesOf = (record: LineupRecord): Readonly<Record<TeamId, string>> =>
  Object.fromEntries(Object.entries(record.payload.display?.teams ?? {}).map(([id, t]) => [id, t.name])) as Record<TeamId, string>;

/** "Henderson State, Delta State · 2026-02-18 to 2026-02-21", from the meet key and the newest record's names. Falls back to the key. */
export function meetTitle(group: MeetGroup): string {
  try {
    const parsed = JSON.parse(group.meetKey.slice(group.meetKey.indexOf(':') + 1)) as { teams?: string[]; startDate?: string; endDate?: string };
    const names = teamNamesOf(group.records[0] as LineupRecord);
    const teams = (parsed.teams ?? []).map((id) => names[id as TeamId] ?? id).join(', ');
    const dates = parsed.startDate && parsed.endDate ? ` · ${parsed.startDate} to ${parsed.endDate}` : '';
    return `${teams}${dates}` || group.meetKey;
  } catch {
    return group.meetKey;
  }
}

const ROLE_LABELS = { scorer: 'Scorer', 'non-scorer': 'Non-scorer', exhibition: 'Exhibition' } as const;

/** Role per swimmer for the CSV, from the tags the snapshot recorded. A suggested opponent roster is labelled as suggested. */
export function rolesOf(record: LineupRecord): ReadonlyMap<string, RoleLabel> {
  const roles = new Map<string, RoleLabel>();
  for (const tag of record.tags?.suggested ?? []) roles.set(String(tag.swimmerId), `${ROLE_LABELS[tag.role]} (suggested)`);
  for (const tag of record.tags?.coach ?? []) roles.set(String(tag.swimmerId), ROLE_LABELS[tag.role]);
  return roles;
}

type ReportState =
  | { kind: 'loading' }
  | { kind: 'no_results' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'need_team' }
  | { kind: 'ready'; results: Results; own: TeamId; rival: TeamId | null };

/** Parse the stored results at use. A record that cannot be read becomes a state, never an exception. */
async function loadReport(repo: StorageRepo, record: LineupRecord): Promise<ReportState> {
  if (record.kind !== 'snapshot' || record.results === undefined) return { kind: 'no_results' };
  let results: Results;
  try {
    results = parseResults(record.results);
  } catch (cause) {
    return { kind: 'unreadable', message: cause instanceof Error ? cause.message : String(cause) };
  }
  const own = await readScorerOwnTeam(repo, record.meetKey);
  if (own === undefined || !results.teams.some((t) => String(t.teamId) === String(own))) return { kind: 'need_team' };
  const rival = resolveRival(results, String(own) as TeamId, await readRival(repo, record.meetKey));
  return { kind: 'ready', results, own: String(own) as TeamId, rival: rival.teamId };
}

const fileNameOf = (record: LineupRecord): string => `${record.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'entries'}-entries.csv`;

function RecordView({ record, repo }: { record: LineupRecord; repo: StorageRepo }): React.ReactElement {
  const [state, setState] = React.useState<ReportState>({ kind: 'loading' });
  React.useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    loadReport(repo, record).then((s) => { if (live) setState(s); }, (cause: unknown) => { if (live) setState({ kind: 'unreadable', message: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { live = false; };
  }, [record, repo]);
  return (
    <section className="osx-record" data-testid="record-view">
      <h2>{record.name}</h2>
      <p className="osx-record-meta">{record.kind === 'snapshot' ? 'Snapshot' : 'Saved lineup'} · saved {record.createdAt.slice(0, 16).replace('T', ' ')}</p>
      {state.kind === 'loading' && <p>Loading…</p>}
      {state.kind === 'no_results' && <p className="osx-status osx-status--warn" data-testid="record-no-results">This {record.kind === 'snapshot' ? 'snapshot' : 'saved lineup'} holds entries but no results, so there is no report for it. Save a snapshot from the docked panel to get one.</p>}
      {state.kind === 'unreadable' && <p className="osx-status osx-status--bad" role="alert" data-testid="record-error">The saved results could not be read: {state.message}</p>}
      {state.kind === 'need_team' && <p className="osx-status osx-status--warn" data-testid="record-need-team">Choose your team for this meet in the page panel of the simulator, then open this snapshot again.</p>}
      {state.kind === 'ready' && <>
        <EntryCsvButton lineup={record.payload as Lineup} results={state.results} facts={record.facts ?? null} roles={rolesOf(record)} fileName={fileNameOf(record)} />
        <MeetReport lineup={record.payload as Lineup} results={state.results} facts={record.facts ?? null} schedule={record.builtUnder.sessionPresetValues ?? null} ownTeamId={state.own} rivalTeamId={state.rival} teamNames={teamNamesOf(record)} />
      </>}
    </section>
  );
}

export function MeetsView({ repo }: { repo: StorageRepo }): React.ReactElement {
  const [records, setRecords] = React.useState<readonly LineupRecord[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    repo.list('lineups').then((list) => { setRecords(list); setError(null); }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [repo]);
  React.useEffect(load, [load]);
  const groups = React.useMemo(() => groupByMeet(records ?? []), [records]);
  const record = records?.find((r) => r.lineupId === selected);
  return (
    <section className="osx-meets" data-testid="meets">
      <h2>Meets</h2>
      <p><button type="button" data-testid="meets-refresh" onClick={load}>Refresh</button></p>
      {error !== null && <p className="osx-status osx-status--bad" role="alert">The saved lineups could not be read: {error}</p>}
      {records === null && error === null && <p>Loading…</p>}
      {records !== null && groups.length === 0 && <p data-testid="meets-empty">Nothing is saved yet. Save a snapshot from the docked panel in the simulator.</p>}
      <div className="osx-meets-body">
        <div className="osx-meets-list">
          {groups.map((group) => (
            <section key={group.meetKey} data-testid="meet-group">
              <h3>{meetTitle(group)}</h3>
              <ul>
                {group.records.map((r) => (
                  <li key={r.lineupId}>
                    <button type="button" className="osx-record-button" data-testid="record-open" aria-pressed={r.lineupId === selected} onClick={() => setSelected(r.lineupId)}>
                      {r.name}
                    </button>
                    <span className="osx-record-kind"> {r.kind === 'snapshot' ? 'snapshot' : 'lineup'}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {record !== undefined && <RecordView record={record} repo={repo} />}
      </div>
    </section>
  );
}

// ---- Presets -----------------------------------------------------------------------------------

export function PresetsSlot(): React.ReactElement {
  return (
    <section data-testid="presets-slot">
      <h2>Presets</h2>
      <p>Editing presets here is not built yet. Choose your scoring rules in the page panel of the simulator, and your session schedule in the Plan tab of the docked panel.</p>
    </section>
  );
}

// ---- Settings ----------------------------------------------------------------------------------

const THEME_CHOICES: readonly { readonly value: ThemePreference; readonly label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Follow the system' },
];

/** The accent shown in the picker before the coach picks one. It is the light theme's own accent, so the picker opens on what the page shows. */
const PICKER_START = '#1565c0';

interface MeetRival {
  readonly group: MeetGroup;
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly rival: RivalRef | undefined;
}

/**
 * `subscribe` reports a change another page or the service worker made to the store (the change bus, see `watchChanges`). It returns its own stop.
 * While the view is mounted, such a change refreshes it, so a theme chosen in the docked panel's tab is not shown stale here.
 */
export type SettingsSubscribe = (listener: () => void) => () => void;

export function SettingsView({ repo, onApplied, subscribe }: { repo: StorageRepo; onApplied?: () => void; subscribe?: SettingsSubscribe }): React.ReactElement {
  const [theme, setTheme] = React.useState<ThemeSettings | null>(null);
  const [meets, setMeets] = React.useState<readonly MeetRival[]>([]);
  const [message, setMessage] = React.useState('');
  const refresh = React.useCallback(async () => {
    const records = await repo.list('lineups');
    const groups = groupByMeet(records);
    setMeets(await Promise.all(groups.map(async (group) => {
      const names = teamNamesOf(group.records[0] as LineupRecord);
      const teams = Object.entries(names).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
      return { group, teams, rival: await readRival(repo, group.meetKey) };
    })));
    setTheme(await readThemeSettings(repo));
  }, [repo]);
  React.useEffect(() => { refresh().catch((cause: unknown) => setMessage(`Settings could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)); }, [refresh]);
  React.useEffect(() => subscribe?.(() => {
    refresh().catch((cause: unknown) => setMessage(`Settings could not be read: ${cause instanceof Error ? cause.message : String(cause)}`));
  }), [refresh, subscribe]);
  const run = async (change: () => Promise<void>, done: string): Promise<void> => {
    try {
      await change();
      setMessage(done);
      await refresh();
      onApplied?.();
    } catch (cause) {
      setMessage(`Not saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  return (
    <section className="osx-settings" data-testid="settings">
      <h2>Settings</h2>
      <fieldset>
        <legend>Theme</legend>
        {THEME_CHOICES.map((choice) => (
          <label key={choice.value} className="osx-radio">
            <input type="radio" name="osx-theme" value={choice.value} data-testid={`theme-${choice.value}`} checked={theme?.preference === choice.value} disabled={theme === null} onChange={() => void run(() => saveTheme(repo, choice.value), `Theme: ${choice.label}.`)} />
            {' '}{choice.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Accent colour</legend>
        <label>
          Colour{' '}
          <input type="color" data-testid="accent-input" aria-label="Accent colour" value={theme?.accent ?? PICKER_START} disabled={theme === null} onChange={(e) => void run(() => saveAccent(repo, e.target.value), `Accent: ${e.target.value}.`)} />
        </label>
        {' '}
        <button type="button" data-testid="accent-reset" disabled={theme?.accent === undefined} onClick={() => void run(() => clearAccent(repo), "Accent: the theme's own.")}>Use the theme's accent</button>
        <p className="osx-record-meta">{theme?.accent === undefined ? "The theme's own accent is in use." : `Your accent: ${theme.accent}`}</p>
      </fieldset>
      <fieldset>
        <legend>Rival for each meet</legend>
        {meets.length === 0 && <p data-testid="rivals-empty">Meets appear here after you save a snapshot.</p>}
        {meets.map(({ group, teams, rival }) => (
          <label key={group.meetKey} className="osx-rival-row">
            {meetTitle(group)}
            <select
              data-testid="rival-select"
              aria-label={`Rival for ${meetTitle(group)}`}
              value={rival?.kind === 'team' ? rival.teamId : ''}
              onChange={(e) => void run(() => saveRival(repo, group.meetKey, e.target.value === '' ? undefined : { kind: 'team', teamId: e.target.value as TeamId }), 'Rival saved.')}
            >
              <option value="">The team closest to yours (default)</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        ))}
      </fieldset>
      <p role="status" aria-live="polite" data-testid="settings-status">{message}</p>
    </section>
  );
}
