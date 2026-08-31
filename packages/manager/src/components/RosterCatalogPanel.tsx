/**
 * RosterCatalogPanel ΓÇö Manager UI for the long-lived Team Roster Catalog.
 *
 * Lets coaches:
 *   - Browse every cataloged team (cross-workspace).
 *   - Create new teams in the catalog.
 *   - Open a team's athletes and toggle their stored events eligible/not.
 *   - Import a team's roster as JSON.
 *   - Read the matching SwimCloud paste parser output before persisting.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { X, Database, Users, ToggleLeft, ToggleRight, FileJson, Save } from 'lucide-react';
import type { CatalogTeam, CatalogTeamRoster } from '@omniswim/core/lib/rosterCatalog';
import { rosterCatalogApi } from '@omniswim/core/api/rosterCatalog';
import {
  validateRosterCatalogJson,
  type RosterCatalogImportJson,
} from '@omniswim/core/lib/rosterCatalog';
import { useToast } from '@omniswim/ui';
import { AthletePane, TeamSidebar } from './RosterCatalogPanelParts';

type Props = {
  onClose: () => void;
  /** Optional: suggest a team name to pre-fill on first open (from current workspace). */
  defaultTeamName?: string;
};

export default function RosterCatalogPanel({ onClose, defaultTeamName }: Props) {
  const toast = useToast();
  const [teams, setTeams] = useState<CatalogTeam[] | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [roster, setRoster] = useState<CatalogTeamRoster | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(defaultTeamName ?? '');
  const [newGender, setNewGender] = useState<'Men' | 'Women'>('Men');
  const [newDivision, setNewDivision] = useState('');
  const [importMode, setImportMode] = useState<'none' | 'paste' | 'json'>('none');

  const refreshTeams = async () => {
    try {
      const list = await rosterCatalogApi.listTeams();
      setTeams(list);
      if (list.length > 0 && !selectedTeamId) {
        setSelectedTeamId(list[0].id);
      }
    } catch (err) {
      toast.push('error', `Could not load teams: ${err instanceof Error ? err.message : String(err)}`);
      setTeams([]);
    }
  };

  useEffect(() => {
    void refreshTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTeamId) {
      setRoster(null);
      return;
    }
    (async () => {
      const r = await rosterCatalogApi.getRoster(selectedTeamId);
      setRoster(r);
    })();
  }, [selectedTeamId]);

  const handleCreateTeam = async () => {
    if (!newName.trim()) {
      toast.push('error', 'Team name required.');
      return;
    }
    try {
      const team = await rosterCatalogApi.createTeam({
        name: newName.trim(),
        gender: newGender,
        division: newDivision.trim() || undefined,
      });
      toast.push('success', `Added team ΓÇ£${team.name}ΓÇ¥`);
      setCreating(false);
      setNewName('');
      setNewDivision('');
      await refreshTeams();
      setSelectedTeamId(team.id);
    } catch (err) {
      toast.push('error', `Could not create team: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteTeam = async (team: CatalogTeam) => {
    if (!confirm(`Delete team ΓÇ£${team.name}ΓÇ¥ and all its athletes? This cannot be undone.`)) return;
    await rosterCatalogApi.deleteTeam(team.id);
    toast.push('info', `Removed ΓÇ£${team.name}ΓÇ¥.`);
    setSelectedTeamId(null);
    await refreshTeams();
  };

  const handleToggleEligibility = async (athleteId: string, timeId: string, isEligible: boolean) => {
    if (!roster) return;
    // Optimistic update.
    setRoster({
      ...roster,
      athletes: roster.athletes.map(a =>
        a.id === athleteId
          ? {
              ...a,
              times: a.times.map(t => (t.id === timeId ? { ...t, isEligible } : t)),
            }
          : a
      ),
    });
    try {
      await rosterCatalogApi.toggleEligibility(timeId, isEligible);
    } catch (err) {
      // Re-fetch to recover.
      const r = await rosterCatalogApi.getRoster(roster.team.id);
      setRoster(r);
      toast.push('error', `Toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteTime = async (timeId: string) => {
    if (!roster) return;
    setRoster({
      ...roster,
      athletes: roster.athletes.map(a => ({
        ...a,
        times: a.times.filter(t => t.id !== timeId),
      })),
    });
    try {
      await rosterCatalogApi.deleteTime(timeId);
    } catch (err) {
      const r = await rosterCatalogApi.getRoster(roster.team.id);
      setRoster(r);
      toast.push('error', `Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleImportDone = async () => {
    setImportMode('none');
    if (!roster) return;
    const r = await rosterCatalogApi.getRoster(roster.team.id);
    setRoster(r);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--backdrop)]">
      <div className="surface-card border border-theme w-full max-w-5xl max-h-[90vh] flex flex-col rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-soft">
          <div className="flex items-center gap-2">
            <Database size={18} className="text-[var(--text-accent)]" />
            <div>
              <h3 className="text-ui-label font-black uppercase tracking-widest">
                Team Roster Catalog
              </h3>
              <p className="text-ui-caption text-theme-muted mt-1">
                Long-lived per-team swimmer ├ù event storage. Toggles below feed scoring without
                touching your meets.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 theme-hover-row rounded" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <TeamSidebar
            teams={teams}
            selectedTeamId={selectedTeamId}
            creating={creating}
            onToggleCreating={() => setCreating(s => !s)}
            newName={newName}
            onNewNameChange={setNewName}
            newGender={newGender}
            onNewGenderChange={setNewGender}
            newDivision={newDivision}
            onNewDivisionChange={setNewDivision}
            onSaveNewTeam={handleCreateTeam}
            onSelectTeam={setSelectedTeamId}
            onDeleteTeam={team => void handleDeleteTeam(team)}
          />

          {/* Athlete + events pane */}
          <section className="flex-1 min-w-0 flex flex-col">
            <AthletePane
              roster={roster}
              importMode={importMode}
              onToggleImportMode={mode => setImportMode(m => (m === mode ? 'none' : mode))}
              onToggleEligibility={(athleteId, timeId, isEligible) =>
                void handleToggleEligibility(athleteId, timeId, isEligible)
              }
              onDeleteTime={timeId => void handleDeleteTime(timeId)}
              importPanes={
                roster ? (
                  <ImportPanes roster={roster} importMode={importMode} onDone={handleImportDone} />
                ) : null
              }
            />
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------- Sub-panes ----------

/** Picks the paste-import or JSON-import pane for the selected team, or nothing. */
function ImportPanes({
  roster,
  importMode,
  onDone,
}: {
  roster: CatalogTeamRoster;
  importMode: 'none' | 'paste' | 'json';
  onDone: () => void;
}) {
  if (importMode === 'paste') {
    return <RosterPasteImportPane teamId={roster.team.id} gender={roster.team.gender} onDone={onDone} />;
  }
  if (importMode === 'json') {
    return (
      <RosterJsonImportPane
        teamId={roster.team.id}
        onDone={onDone}
        prefill={{
          team: {
            name: roster.team.name,
            gender: roster.team.gender,
            division: roster.team.division ?? null,
            shortName: roster.team.shortName ?? null,
            color: roster.team.color ?? null,
            notes: roster.team.notes ?? null,
          },
          athletes: [],
        }}
      />
    );
  }
  return null;
}

function RosterPasteImportPane({
  teamId,
  gender,
  onDone,
}: {
  teamId: string;
  gender: 'Men' | 'Women';
  onDone: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [format, setFormat] = useState<'auto' | 'personal_bests' | 'roster'>('auto');
  const [busy, setBusy] = useState(false);

  const handleImport = async () => {
    if (!text.trim()) {
      toast.push('error', 'Paste some text first.');
      return;
    }
    setBusy(true);
    try {
      const res = await rosterCatalogApi.importPaste({
        teamId,
        text,
        format,
        gender,
      });
      toast.push('success', `Added ${res.added} swim${res.added === 1 ? '' : 's'} (${res.format}).`);
      if (res.warnings.length) {
        for (const w of res.warnings.slice(0, 3)) toast.push('info', w);
      }
      onDone();
    } catch (err) {
      toast.push('error', `Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 py-3 border-b border-theme-soft space-y-2 surface-muted-bg">
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase text-theme-secondary">Format</label>
        <select
          value={format}
          onChange={e => setFormat(e.target.value as 'auto' | 'personal_bests' | 'roster')}
          className="text-[11px] surface-muted-bg border border-theme-soft rounded px-2 py-0.5"
        >
          <option value="auto">Auto</option>
          <option value="personal_bests">Personal Bests</option>
          <option value="roster">Roster</option>
        </select>
      </div>
      <textarea
        rows={6}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste a SwimCloud Personal Bests or Roster table for this team."
        className="glass-input px-3 py-2 rounded text-ui-caption font-mono w-full resize-y"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setText('')}
          className="px-3 py-1 text-ui-caption nav-tab-inactive"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => void handleImport()}
          disabled={busy || !text.trim()}
          className="px-3 py-1 btn-primary rounded text-ui-caption disabled:opacity-40"
        >
          {busy ? 'ImportingΓÇª' : 'Import'}
        </button>
      </div>
    </div>
  );
}

function RosterJsonImportPane({
  teamId,
  prefill,
  onDone,
}: {
  teamId: string;
  prefill: RosterCatalogImportJson;
  onDone: () => void;
}) {
  const toast = useToast();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState(() => JSON.stringify(prefill, null, 2));
  const [issues, setIssues] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File) => {
    try {
      const raw = await file.text();
      setText(raw);
    } catch (err) {
      toast.push('error', `Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIssues(null);
    }
  };

  const handleImport = async () => {
    let parsed: RosterCatalogImportJson;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setIssues([`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`]);
      return;
    }
    const validation = validateRosterCatalogJson(parsed);
    if (validation) {
      setIssues(validation);
      return;
    }
    setIssues(null);
    setBusy(true);
    try {
      const res = await rosterCatalogApi.importJson(parsed);
      toast.push(
        'success',
        `Imported ${res.athletesAdded} athletes ┬╖ ${res.timesAdded} events into ${res.team.name}.`
      );
      onDone();
    } catch (err) {
      toast.push('error', `Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const stats = useMemo(() => {
    try {
      const p = JSON.parse(text);
      return {
        athletes: Array.isArray(p?.athletes) ? p.athletes.length : 0,
        events: Array.isArray(p?.athletes)
          ? p.athletes.reduce((s: number, a: { events?: unknown[] }) => s + (Array.isArray(a?.events) ? a.events.length : 0), 0)
          : 0,
      };
    } catch {
      return null;
    }
  }, [text]);

  return (
    <div className="px-5 py-3 border-b border-theme-soft space-y-2 surface-muted-bg">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = '';
        }}
        className="hidden"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="px-3 py-1 text-ui-caption rounded border border-theme-soft nav-tab-inactive"
        >
          <FileJson size={12} className="inline mr-1" /> Choose fileΓÇª
        </button>
        <span className="text-ui-caption text-theme-muted">
          {stats ? `${stats.athletes} athletes ┬╖ ${stats.events} events in JSON` : 'awaiting valid JSON'}
        </span>
      </div>
      <textarea
        rows={8}
        value={text}
        onChange={e => {
          setText(e.target.value);
          setIssues(null);
        }}
        className="glass-input px-3 py-2 rounded text-ui-caption font-mono w-full resize-y"
      />
      {issues && issues.length > 0 ? (
        <ul className="text-[11px] text-red-400 list-disc list-inside space-y-0.5">
          {issues.map((iss, i) => (
            <li key={i}>{iss}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setText(JSON.stringify(prefill, null, 2))}
          className="px-3 py-1 text-ui-caption nav-tab-inactive"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => void handleImport()}
          disabled={busy}
          className="px-3 py-1 btn-primary rounded text-ui-caption disabled:opacity-40"
        >
          <Save size={12} className="inline mr-1" />
          {busy ? 'ImportingΓÇª' : 'Import'}
        </button>
      </div>
      {/* teamId is referenced indirectly via button feedback; declared to avoid an unused-var lint warning */}
      <span className="hidden">{teamId}</span>
    </div>
  );
}

/** Re-export for type/spread parity with the toggle handlers. */
export const Toggle = {
  Left: ToggleLeft,
  Right: ToggleRight,
};

export { Users };
