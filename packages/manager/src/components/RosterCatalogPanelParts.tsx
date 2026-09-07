/**
 * Sub-components for RosterCatalogPanel: the team sidebar (create-team form +
 * team list) and the athlete pane (header, import toggles, athlete list).
 * Split out of the panel so each piece's branching lives in its own named
 * function instead of one large render tree — pure extraction, no behavior
 * change.
 */
import React from 'react';
import { Plus, Trash2, ClipboardPaste, FileJson } from 'lucide-react';
import type { CatalogTeam, CatalogTeamRoster } from '@omniswim/core/lib/rosterCatalog';
import AthleteRosterRow from './AthleteRosterRow';

type ImportMode = 'none' | 'paste' | 'json';

/** New-team name/gender/division fields shown when "creating" is toggled on. */
export function CreateTeamForm({
  newName,
  onNewNameChange,
  newGender,
  onNewGenderChange,
  newDivision,
  onNewDivisionChange,
  onSave,
}: {
  newName: string;
  onNewNameChange: (v: string) => void;
  newGender: 'Men' | 'Women';
  onNewGenderChange: (v: 'Men' | 'Women') => void;
  newDivision: string;
  onNewDivisionChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="px-4 py-3 border-b border-theme-soft space-y-2">
      <input
        value={newName}
        onChange={e => onNewNameChange(e.target.value)}
        placeholder="Team name"
        className="glass-input px-3 py-1.5 rounded w-full text-ui-body"
      />
      <div className="flex gap-2">
        <select
          value={newGender}
          onChange={e => onNewGenderChange(e.target.value as 'Men' | 'Women')}
          className="glass-input px-2 py-1 rounded text-ui-caption"
        >
          <option value="Men">Men</option>
          <option value="Women">Women</option>
        </select>
        <input
          value={newDivision}
          onChange={e => onNewDivisionChange(e.target.value)}
          placeholder="Division (D1/D2/D3/NAIA)"
          className="glass-input px-2 py-1 rounded w-full text-ui-caption"
        />
      </div>
      <button type="button" onClick={onSave} className="btn-primary px-3 py-1 rounded text-ui-caption w-full">
        Save
      </button>
    </div>
  );
}

/** One team row in the sidebar list. */
function TeamListItem({
  team,
  onSelect,
  onDelete,
}: {
  team: CatalogTeam;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className="flex items-center justify-between gap-2 px-4 py-2 cursor-pointer border-b border-theme-soft theme-hover-row"
      onClick={onSelect}
    >
      <div className="min-w-0">
        <div className="text-ui-body truncate text-[var(--text-primary)]">{team.name}</div>
        <div className="text-ui-caption text-theme-muted">
          {team.gender}
          {team.division ? ` · ${team.division}` : ''}
        </div>
      </div>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${team.name}`}
        className="p-1 text-theme-secondary hover:text-red-400"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

/** Team list body: loading / empty / populated states. */
function TeamList({
  teams,
  selectedTeamId,
  onSelectTeam,
  onDeleteTeam,
}: {
  teams: CatalogTeam[] | null;
  selectedTeamId: string | null;
  onSelectTeam: (id: string) => void;
  onDeleteTeam: (team: CatalogTeam) => void;
}) {
  if (teams == null) {
    return <li className="px-4 py-3 text-ui-caption text-theme-muted">Loading…</li>;
  }
  if (teams.length === 0) {
    return <li className="px-4 py-3 text-ui-caption text-theme-muted">No teams yet — create one to start.</li>;
  }
  return (
    <>
      {teams.map(team => (
        <TeamListItem
          key={team.id}
          team={team}
          onSelect={() => onSelectTeam(team.id)}
          onDelete={() => onDeleteTeam(team)}
        />
      ))}
    </>
  );
}

/** Left sidebar: create-team toggle/form plus the team list. */
export function TeamSidebar({
  teams,
  selectedTeamId,
  creating,
  onToggleCreating,
  newName,
  onNewNameChange,
  newGender,
  onNewGenderChange,
  newDivision,
  onNewDivisionChange,
  onSaveNewTeam,
  onSelectTeam,
  onDeleteTeam,
}: {
  teams: CatalogTeam[] | null;
  selectedTeamId: string | null;
  creating: boolean;
  onToggleCreating: () => void;
  newName: string;
  onNewNameChange: (v: string) => void;
  newGender: 'Men' | 'Women';
  onNewGenderChange: (v: 'Men' | 'Women') => void;
  newDivision: string;
  onNewDivisionChange: (v: string) => void;
  onSaveNewTeam: () => void;
  onSelectTeam: (id: string) => void;
  onDeleteTeam: (team: CatalogTeam) => void;
}) {
  return (
    <aside className="md:w-64 border-b md:border-b-0 md:border-r border-theme-soft flex flex-col">
      <div className="px-4 py-3 border-b border-theme-soft flex items-center justify-between">
        <span className="text-ui-label font-bold uppercase tracking-widest text-theme-secondary">Teams</span>
        <button
          type="button"
          onClick={onToggleCreating}
          className="p-1 theme-hover-row rounded text-[var(--text-accent)]"
          aria-label="Create team"
        >
          <Plus size={16} />
        </button>
      </div>
      {creating ? (
        <CreateTeamForm
          newName={newName}
          onNewNameChange={onNewNameChange}
          newGender={newGender}
          onNewGenderChange={onNewGenderChange}
          newDivision={newDivision}
          onNewDivisionChange={onNewDivisionChange}
          onSave={onSaveNewTeam}
        />
      ) : null}
      <ul className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        <TeamList
          teams={teams}
          selectedTeamId={selectedTeamId}
          onSelectTeam={onSelectTeam}
          onDeleteTeam={onDeleteTeam}
        />
      </ul>
    </aside>
  );
}

/** Title, gender/division badges and athlete/event counts for the selected team. */
function AthletePaneHeader({
  roster,
  importMode,
  onToggleImportMode,
}: {
  roster: CatalogTeamRoster;
  importMode: ImportMode;
  onToggleImportMode: (mode: 'paste' | 'json') => void;
}) {
  return (
    <header className="px-5 py-3 border-b border-theme-soft">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h4 className="text-ui-body font-bold text-[var(--text-primary)]">{roster.team.name}</h4>
        <span className="badge-info px-2 py-0.5 rounded text-[10px]">{roster.team.gender}</span>
        {roster.team.division ? (
          <span className="badge-warning px-2 py-0.5 rounded text-[10px]">{roster.team.division}</span>
        ) : null}
        <span className="text-ui-caption text-theme-muted">
          {roster.athletes.length} athletes · {roster.athletes.reduce((s, a) => s + a.times.length, 0)} events
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onToggleImportMode('paste')}
          className={`px-3 py-1 text-ui-caption rounded border ${importMode === 'paste' ? 'btn-primary' : 'border-theme-soft nav-tab-inactive'}`}
        >
          <ClipboardPaste size={12} className="inline mr-1" /> Paste SwimCloud
        </button>
        <button
          type="button"
          onClick={() => onToggleImportMode('json')}
          className={`px-3 py-1 text-ui-caption rounded border ${importMode === 'json' ? 'btn-primary' : 'border-theme-soft nav-tab-inactive'}`}
        >
          <FileJson size={12} className="inline mr-1" /> Import JSON
        </button>
      </div>
    </header>
  );
}

/** Athlete list: empty state or the eligibility-toggle rows. */
function AthleteList({
  roster,
  onToggleEligibility,
  onDeleteTime,
}: {
  roster: CatalogTeamRoster;
  onToggleEligibility: (athleteId: string, timeId: string, isEligible: boolean) => void;
  onDeleteTime: (timeId: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-2">
      {roster.athletes.length === 0 ? (
        <p className="text-ui-caption text-theme-muted">
          No athletes imported yet. Use the buttons above to bring in data.
        </p>
      ) : null}
      {roster.athletes.map(athlete => (
        <AthleteRosterRow
          key={athlete.id}
          athlete={athlete}
          onToggleEligibility={(timeId, isEligible) => onToggleEligibility(athlete.id, timeId, isEligible)}
          onDeleteTime={timeId => onDeleteTime(timeId)}
        />
      ))}
    </div>
  );
}

/**
 * Right pane: "select a team" placeholder, or the header + import panes + athlete
 * list for the selected team. `importPanes` is rendered by the caller (it owns the
 * paste/JSON sub-panes) so this component doesn't need to know their props.
 */
export function AthletePane({
  roster,
  importMode,
  onToggleImportMode,
  importPanes,
  onToggleEligibility,
  onDeleteTime,
}: {
  roster: CatalogTeamRoster | null;
  importMode: ImportMode;
  onToggleImportMode: (mode: 'paste' | 'json') => void;
  importPanes: React.ReactNode;
  onToggleEligibility: (athleteId: string, timeId: string, isEligible: boolean) => void;
  onDeleteTime: (timeId: string) => void;
}) {
  if (!roster) {
    return (
      <div className="flex-1 flex items-center justify-center text-theme-muted text-ui-caption">
        Select a team on the left to manage athletes.
      </div>
    );
  }
  return (
    <>
      <AthletePaneHeader roster={roster} importMode={importMode} onToggleImportMode={onToggleImportMode} />
      {importPanes}
      <AthleteList roster={roster} onToggleEligibility={onToggleEligibility} onDeleteTime={onDeleteTime} />
    </>
  );
}
