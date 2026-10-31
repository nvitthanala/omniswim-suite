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
import { teamLabel } from '../shared/names';
import { diffResults, parseResults, ReportDiffError } from '@omniswim/engine';
import type { Lineup, Results, ResultsDiff, RivalRef, RoleLabel, TeamId } from '@omniswim/engine';
import { readScorerOwnTeam, listRulePresetChoices, listSessionPresetChoices, newerBuiltinVersion, exportData, importData, openOmniDb } from '../storage';
import type { ExportOptions, LineupRecord, StorageRepo, OnConflict } from '../storage';
import { EntryCsvButton } from './EntryCsvButton';
import { MeetReport } from './MeetReport';
import { resolveRival } from './rival';
import { clearAccent, clearFetchedSwimCloudData, readRival, readThemeSettings, readSetting, readStorageEstimate, saveAccent, saveRival, saveTheme, saveCutCloseThreshold } from './settingsStore';
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
    const teams = (parsed.teams ?? []).map((id) => teamLabel(id, names[id as TeamId])).join(', ');
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
  if (record.results === undefined) return { kind: 'no_results' };
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

/** Earlier and later follow the save time, not the order of the clicks. */
export function orderForDiff(records: readonly LineupRecord[]): LineupRecord[] {
  return [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const absent = <span aria-label="Absent">—</span>;
export function DiffView({ earlier, later }: { earlier: LineupRecord; later: LineupRecord }): React.ReactElement {
  const [state, setState] = React.useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; rows: ResultsDiff[] }>({ kind: 'loading' });
  React.useEffect(() => {
    let live = true;
    try {
      if (earlier.meetKey !== later.meetKey) throw new ReportDiffError();
      if (earlier.results === undefined || later.results === undefined) throw new Error('Both records need saved results to compare.');
      const thenResults = parseResults(earlier.results);
      const nowResults = parseResults(later.results);
      const teams = new Set<TeamId>([...thenResults.teams.map((team) => team.teamId), ...nowResults.teams.map((team) => team.teamId)]);
      const thenLineup = earlier.payload as Lineup;
      const nowLineup = later.payload as Lineup;
      const rows = [...teams].map((team) => diffResults({ results: thenResults, lineup: thenLineup }, { results: nowResults, lineup: nowLineup }, team));
      if (live) setState({ kind: 'ready', rows });
    } catch (cause) {
      const mismatch = cause instanceof ReportDiffError && cause.code === 'meet_key_mismatch';
      if (live) setState({ kind: 'error', message: mismatch ? 'These two records come from different meets, so they cannot be compared (meet_key_mismatch).' : cause instanceof Error ? cause.message : String(cause) });
    }
    return () => { live = false; };
  }, [earlier, later]);
  if (state.kind === 'loading') return <p>Loading comparison…</p>;
  if (state.kind === 'error') return <p role="alert" data-testid="diff-error">{state.message}</p>;
  const stripped = earlier.payload.display === undefined || later.payload.display === undefined;
  const side = (value: number | null, present: boolean): React.ReactNode => present && value !== null ? value : absent;
  return <section className="osx-diff" data-testid="diff-view"><h2>{earlier.name} compared with {later.name}</h2>
    {stripped && <p data-testid="diff-stripped-note">Time changes cannot be shown for a record stripped of SwimCloud data.</p>}
    {state.rows.map((row) => <section key={String(row.teamId)}><h3>{row.team}</h3>
      <table><caption>Team totals</caption><thead><tr><th>Earlier</th><th>Later</th><th>Change</th></tr></thead><tbody><tr>
        <td>{side(row.totals.then, row.totals.inThen)}</td><td>{side(row.totals.now, row.totals.inNow)}</td><td>{row.totals.delta ?? absent}</td>
      </tr></tbody></table>
      <table><caption>Events</caption><thead><tr><th>Event</th><th>Earlier points</th><th>Later points</th><th>Change</th></tr></thead><tbody>{row.events.length ? row.events.map((event) => <tr key={event.eventKey}><th>{event.eventKey}</th><td>{side(event.pointsThen, event.inThen)}</td><td>{side(event.pointsNow, event.inNow)}</td><td>{event.delta ?? absent}</td></tr>) : <tr><td colSpan={4}>No event changes.</td></tr>}</tbody></table>
      <table><caption>Swimmers and relays</caption><thead><tr><th>Swimmer or relay</th><th>Earlier points</th><th>Later points</th><th>Change</th></tr></thead><tbody>{row.swimmers.length ? row.swimmers.map((swimmer, index) => <tr key={`${swimmer.name}:${index}`}><th>{swimmer.name}{swimmer.isRelay ? ' (relay)' : ''}</th><td>{side(swimmer.pointsThen, swimmer.inThen)}</td><td>{side(swimmer.pointsNow, swimmer.inNow)}</td><td>{swimmer.deltaPoints ?? absent}</td></tr>) : <tr><td colSpan={4}>No swimmer or relay changes.</td></tr>}</tbody></table>
    </section>)}</section>;
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
      {state.kind === 'no_results' && <p className="osx-status osx-status--warn" data-testid="record-no-results">{record.kind === 'lineup' ? 'A saved lineup has no results. Save a snapshot to see its report and compare it.' : 'This snapshot has no saved results, so there is no report for it.'}</p>}
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
  const [compare, setCompare] = React.useState<string[]>([]);
  const [compareMeetKey, setCompareMeetKey] = React.useState<string | null>(null);
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
                    {r.kind === 'snapshot' && <label><input type="checkbox" data-testid="diff-pick" checked={compare.includes(r.lineupId)} onChange={(event) => {
                      if (event.target.checked) { setCompareMeetKey(group.meetKey); setCompare((current) => [...(compareMeetKey === group.meetKey ? current : []).filter((id) => id !== r.lineupId).slice(-1), r.lineupId]); }
                      else setCompare((current) => current.filter((id) => id !== r.lineupId));
                    }} /> Compare</label>}
                    <span className="osx-record-kind"> {r.kind === 'snapshot' ? 'snapshot' : 'lineup'}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {record !== undefined && <RecordView record={record} repo={repo} />}
        {compare.length === 2 && (() => {
          const [first, second] = orderForDiff(compare.map((id) => records?.find((r) => r.lineupId === id)).filter((r): r is LineupRecord => r !== undefined));
          return first && second && first.meetKey === second.meetKey && first.meetKey === compareMeetKey ? <DiffView earlier={first} later={second} /> : null;
        })()}
      </div>
    </section>
  );
}

// ---- Presets -----------------------------------------------------------------------------------

export function PresetsSlot({ repo }: { repo: StorageRepo }): React.ReactElement {
  const [rows, setRows] = React.useState<readonly { kind: string; source: string; note: string }[]>([]);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let live = true;
    const readPresets = async (): Promise<void> => {
      try {
        const [rules, sessions, userRules, userSessions] = await Promise.all([
          listRulePresetChoices(repo),
          listSessionPresetChoices(repo),
          repo.list('rulePresets'),
          repo.list('sessionPresets'),
        ]);
        const describe = (choice: { source: string; label: string; ref: { kind: string; id: string; version?: number } }, kind: 'rule' | 'session') => {
          const copy = choice.source === 'user' ? (kind === 'rule' ? userRules : userSessions).find(x => x.id === choice.ref.id) : undefined;
          const derivedFrom = copy?.derivedFrom;
          const baseName = derivedFrom ? (kind === 'rule' ? rules : sessions).find(c => c.source === 'builtin' && c.ref.kind === 'builtin' && c.ref.id === derivedFrom.builtinId)?.label ?? derivedFrom.builtinId : '';
          const based = presetDerivedFromText(kind, derivedFrom, baseName);
          const source = choice.source === 'builtin' ? `Built in v${choice.ref.version}`
            : copy?.origin.kind === 'imported' ? `Imported from ${copy.origin.fileName}` : 'User copy';
          return { kind: `${kind === 'rule' ? 'Rule' : 'Session'}: ${choice.label}`, source, note: based };
        };
        if (live) {
          setRows([...rules.map(x => describe(x, 'rule')), ...sessions.map(x => describe(x, 'session'))]);
          setError('');
        }
      } catch (cause) {
        if (live) {
          setRows([]);
          setError(`Presets could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    };
    void readPresets();
    return () => { live = false; };
  }, [repo]);
  return (
    <section data-testid="presets-slot">
      <h2>Presets</h2>
      <p>Presets are read only here. Choose scoring rules in the simulator panel and session schedules in Plan.</p>
      {error ? <p role="alert" data-testid="presets-error">{error}</p> : (
        <ul>
          {rows.map((row, i) => (
            <li key={`${row.kind}-${i}`}>
              {row.kind} — {row.source}{row.note && `; ${row.note}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function presetDerivedFromText(kind: 'rule' | 'session', derivedFrom: { readonly builtinId: string; readonly builtinVersion: number } | undefined, builtinName: string): string {
  if (!derivedFrom) return '';
  const available = newerBuiltinVersion(kind, derivedFrom);
  return `Based on ${builtinName} v${derivedFrom.builtinVersion}${available ? `; v${available} available` : ''}`;
}

// ---- Settings ----------------------------------------------------------------------------------

const THEME_CHOICES: readonly { readonly value: ThemePreference; readonly label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Follow the system' },
];

/** The accent shown in the picker before the coach picks one. It is the light theme's own accent, so the picker opens on what the page shows. */
const PICKER_START = '#1565c0';

export function backupExportOptions(includeSwimCloudData: boolean): ExportOptions {
  return {
    stores: [
      'rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides',
      ...(includeSwimCloudData ? ['swimmerHistory', 'rosters'] as const : []),
      'settings',
    ],
    includeSwimCloudData,
    includeSettings: true,
  };
}

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
  // The text in the box. It is saved on blur or Enter, never per keystroke: an empty box would read as 0.
  const [thresholdText, setThresholdText] = React.useState('1.0');
  const [thresholdSaved, setThresholdSaved] = React.useState(false);
  const [estimate, setEstimate] = React.useState<string>('');
  const [confirmCache, setConfirmCache] = React.useState(false);
  const [conflict, setConflict] = React.useState<OnConflict>('skip');
  const [includeSwimCloudData, setIncludeSwimCloudData] = React.useState(false);
  const mounted = React.useRef(false);
  // True from the first keystroke in the threshold box until it is saved: a refresh from the change bus must not replace what the coach is typing.
  const thresholdDirty = React.useRef(false);
  const refresh = React.useCallback(async () => {
    const records = await repo.list('lineups');
    if (!mounted.current) return;
    const groups = groupByMeet(records);
    const nextMeets = await Promise.all(groups.map(async (group) => {
      const names = teamNamesOf(group.records[0] as LineupRecord);
      const teams = Object.entries(names).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
      return { group, teams, rival: await readRival(repo, group.meetKey) };
    }));
    const nextTheme = await readThemeSettings(repo);
    const nextThreshold = await readSetting(repo, 'cutCloseThresholdPct');
    if (mounted.current) {
      setMeets(nextMeets);
      setTheme(nextTheme);
      if (!thresholdDirty.current) {
        setThresholdText(nextThreshold === undefined ? '1.0' : String(nextThreshold));
        setThresholdSaved(nextThreshold !== undefined);
      }
    }
  }, [repo]);
  React.useEffect(() => { let live = true; void readStorageEstimate(navigator.storage).then(result => { if (live) setEstimate(result.text); }); return () => { live = false; }; }, []);
  React.useEffect(() => {
    mounted.current = true;
    refresh().catch((cause: unknown) => { if (mounted.current) setMessage(`Settings could not be read: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { mounted.current = false; };
  }, [refresh]);
  React.useEffect(() => subscribe?.(() => {
    refresh().catch((cause: unknown) => { if (mounted.current) setMessage(`Settings could not be read: ${cause instanceof Error ? cause.message : String(cause)}`); });
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
  const handleThresholdChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    thresholdDirty.current = true;
    setThresholdText(event.currentTarget.value);
  };
  const saveThreshold = (): void => {
    const text = thresholdText.trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) {
      setMessage('Cut threshold not saved: enter a number.');
      // End the draft, so the box shows the stored value again and later changes from other tabs reach it.
      thresholdDirty.current = false;
      void refresh();
      return;
    }
    thresholdDirty.current = false;
    void run(() => saveCutCloseThreshold(repo, value), `Cut threshold: ${value}%.`);
  };
  const handleThresholdKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') saveThreshold();
  };
  const handleClearCache = async (): Promise<void> => {
    setConfirmCache(false);
    try {
      const count = await clearFetchedSwimCloudData(await openOmniDb());
      setMessage(`Deleted ${count} fetched SwimCloud records.`);
    } catch (cause) {
      setMessage(`Cache clear failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const handleExportBackup = async (): Promise<void> => {
    try {
      const data = await exportData(repo, backupExportOptions(includeSwimCloudData));
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `omniswim-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage('Backup exported.');
    } catch (cause) {
      setMessage(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const handleImportBackup = async (file: File): Promise<void> => {
    try {
      const json: unknown = JSON.parse(await file.text());
      const report = await importData(await openOmniDb(), json, { fileName: file.name, onConflict: conflict });
      const added = Object.values(report.written).reduce((sum, count) => sum + (count ?? 0), 0) - report.replaced.length;
      const skipped = report.skipped.map(row => `${row.store}/${row.key}: ${row.reason}`).join(', ') || 'none';
      setMessage(`Added ${added}; replaced ${report.replaced.length}; skipped ${skipped}.`);
    } catch (cause) {
      const issues = (cause as { issues?: readonly { path: string; message: string }[] }).issues;
      setMessage(issues ? `Refused: ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}` : `Import failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const handleImportFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    if (file) void handleImportBackup(file);
  };
  const handleConflictChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    setConflict(event.currentTarget.value as OnConflict);
  };
  const handleIncludeSwimCloudChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    setIncludeSwimCloudData(event.currentTarget.checked);
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
        <legend>Close to a cut</legend>
        <label>
          Threshold (%)
          <input
            data-testid="cut-threshold"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={thresholdText}
            onChange={handleThresholdChange}
            onBlur={saveThreshold}
            onKeyDown={handleThresholdKey}
          />
        </label>
        {!thresholdSaved && <p data-testid="threshold-default">(default)</p>}
      </fieldset>
      <fieldset>
        <legend>Storage</legend>
        <p data-testid="storage-estimate">{estimate}</p>
        {!confirmCache ? (
          <button type="button" data-testid="clear-cache" onClick={() => setConfirmCache(true)}>
            Clear fetched SwimCloud data
          </button>
        ) : (
          <div>
            <p>Clear all fetched SwimCloud data? This never touches your lineups, tags, presets, or settings.</p>
            <button type="button" onClick={() => void handleClearCache()}>Confirm clear</button>
            <button type="button" onClick={() => setConfirmCache(false)}>Cancel</button>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>Backup</legend>
        <p>A default backup carries IDs only. Snapshot results and names are left out; check the box to include them.</p>
        <p>
          <label>
            <input
              type="checkbox"
              data-testid="backup-include-swimcloud"
              checked={includeSwimCloudData}
              onChange={handleIncludeSwimCloudChange}
            />
            {' '}Include SwimCloud data (times, results and names)
          </label>
        </p>
        <p>
          <button type="button" data-testid="backup-export" onClick={() => void handleExportBackup()}>
            Export backup
          </button>
        </p>
        {/* The conflict choice comes first: choosing a file starts the import. */}
        <p>
          <label>
            When a record already exists{' '}
            <select data-testid="backup-conflict" value={conflict} onChange={handleConflictChange}>
              <option value="skip">Skip</option>
              <option value="replace">Replace</option>
              <option value="keep-both">Keep both</option>
            </select>
          </label>
        </p>
        <p>
          <label>
            Import backup{' '}
            <input
              data-testid="backup-import"
              type="file"
              accept="application/json,.json"
              onChange={handleImportFileChange}
            />
          </label>
        </p>
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
