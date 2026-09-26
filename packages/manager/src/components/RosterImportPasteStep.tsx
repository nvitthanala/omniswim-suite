/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "paste" step of RosterImportWizard — mode tabs, the SwimCloud reference
 * iframe toggle, team/gender fields and the paste/CSV textarea. Split out of
 * the wizard's own function body so this region's branching lives here.
 */
import type { RefObject } from 'react';
import { ClipboardPaste, FileSpreadsheet, Globe, Boxes } from 'lucide-react';
import type { Gender } from '@omniswim/core/types';
import { Button, TeamSelect } from '@omniswim/ui';

type ImportMode = 'paste' | 'csv';

type Props = {
  mode: ImportMode;
  onSetMode: (mode: ImportMode) => void;
  showReference: boolean;
  onToggleReference: () => void;
  onShowCaptureRosterPanel: () => void;
  team: string;
  teams: string[];
  onSetTeam: (team: string) => void;
  gender: Gender;
  paste: string;
  onSetPaste: (paste: string) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  detectedFormat: string | null;
};

export default function RosterImportPasteStep({
  mode,
  onSetMode,
  showReference,
  onToggleReference,
  onShowCaptureRosterPanel,
  team,
  teams,
  onSetTeam,
  gender,
  paste,
  onSetPaste,
  fileInputRef,
  onFile,
  detectedFormat,
}: Props) {
  return (
    <>
      <div className="flex items-center gap-1 border-b border-theme-soft">
        <button
          type="button"
          onClick={() => onSetMode('paste')}
          className={`px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${mode === 'paste' ? 'border-[var(--text-accent)] text-[var(--text-primary)]' : 'border-transparent nav-tab-inactive'}`}
        >
          <ClipboardPaste size={13} /> Paste
        </button>
        <button
          type="button"
          onClick={() => onSetMode('csv')}
          className={`px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${mode === 'csv' ? 'border-[var(--text-accent)] text-[var(--text-primary)]' : 'border-transparent nav-tab-inactive'}`}
        >
          <FileSpreadsheet size={13} /> CSV
        </button>
        <button
          type="button"
          onClick={onToggleReference}
          className={`ml-auto px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 transition-colors ${showReference ? 'text-[var(--text-primary)]' : 'nav-tab-inactive'}`}
        >
          <Globe size={13} /> SwimCloud
        </button>
        {/* One entry point, not two peers: "From clipboard" is now the
            capture browser's own secondary link, offered only when no
            capture exists yet — see plans/2026-09-10/02-UI-REDESIGN-WHOLE-APP.md §0. */}
        <button
          type="button"
          onClick={onShowCaptureRosterPanel}
          disabled={!team.trim()}
          title="Import a whole roster's times from a capture the Omniswim SwimCloud Companion extension has already fetched — every swimmer it captured, in one action. Pasting a single page from the clipboard is still offered there when no capture exists yet."
          className="px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 nav-tab-inactive hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
        >
          <Boxes size={13} /> Add from SwimCloud
        </button>
      </div>

      {showReference ? (
        <div className="border border-theme-soft rounded-lg overflow-hidden">
          <div className="px-3 py-1.5 bg-[var(--surface-strong)] text-ui-caption text-theme-muted flex items-center justify-between">
            <span>Reference panel — open SwimCloud, then copy/paste into the importer.</span>
            <a
              href="https://www.swimcloud.com/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--text-accent)] hover:underline"
            >
              Open in new tab ↗
            </a>
          </div>
          <iframe
            title="SwimCloud reference"
            src="https://www.swimcloud.com/"
            className="w-full h-64 bg-white"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="label-caps">Team</span>
          <TeamSelect
            teams={teams}
            value={team && teams.includes(team) ? team : ''}
            onChange={e => onSetTeam(e.target.value)}
            className="glass-input px-3 py-2 rounded-lg text-ui-body appearance-none"
            placeholderDisabled
          />
          {teams.length === 0 ? (
            <span className="text-ui-caption text-theme-muted">
              Load a meet PDF first, or type a custom team below.
            </span>
          ) : null}
          <input
            value={team}
            onChange={e => onSetTeam(e.target.value)}
            className="glass-input px-3 py-2 rounded-lg text-ui-body mt-1"
            placeholder="Or type a team name…"
            aria-label="Custom team name"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Gender</span>
          <div className="px-3 py-2 rounded-lg border border-theme-soft text-ui-body bg-[var(--surface-muted)]">
            {gender}
          </div>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="label-caps flex items-center gap-2">
          {mode === 'csv' ? <FileSpreadsheet size={14} /> : <ClipboardPaste size={14} />}
          {mode === 'csv' ? 'CSV content' : 'Paste text'}
          {mode === 'csv' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="text-[var(--text-accent)] normal-case hover:underline ml-1 p-0"
            >
              (choose file…)
            </Button>
          ) : detectedFormat && detectedFormat !== 'unknown' ? (
            <span className="text-[var(--text-accent)] normal-case">({detectedFormat.replace('_', ' ')})</span>
          ) : null}
        </span>
        <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} className="hidden" />
        <textarea
          value={paste}
          onChange={e => onSetPaste(e.target.value)}
          rows={10}
          className="glass-input px-3 py-2 rounded-lg text-ui-body font-mono text-sm resize-y"
          placeholder={
            mode === 'csv'
              ? 'Paste CSV with header row: name,event,time[,team,gender,date,meet]'
              : 'Paste Personal Bests or roster table from SwimCloud…'
          }
        />
      </label>
    </>
  );
}
