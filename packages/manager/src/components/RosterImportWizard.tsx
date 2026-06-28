/**
 * Enhanced SwimCloud paste import with format detection and merge preview.
 */
import React, { useMemo, useRef, useState } from 'react';
import { X, ClipboardPaste, FileSpreadsheet, Globe } from 'lucide-react';
import { Gender, HistoricalSwim, Workspace } from '@omniswim/core/types';
import {
  detectSwimCloudPasteFormat,
  mergeHistoryIndex,
  parseSwimCloudPasteDetailed,
} from '@omniswim/core/lib/athleteHistory';
import { parseCsvHistory } from '@omniswim/core/lib/csvImport';
import { divisionForTeam } from '@omniswim/core/data/teamDivisions';
import { useToast } from '@omniswim/ui';

type ImportMode = 'paste' | 'csv';

type Props = {
  workspace: Workspace;
  gender: Gender;
  onClose: () => void;
  onUpdate: (patch: Partial<Workspace>) => void | Promise<void>;
};

function uniqueTeams(workspace: Workspace, gender: Gender): string[] {
  const field = gender === Gender.MEN ? workspace.menResults : workspace.womenResults;
  const teams = new Set<string>();
  for (const r of field ?? []) {
    if (r.team) teams.add(r.team);
  }
  return [...teams].sort();
}

export default function RosterImportWizard({ workspace, gender, onClose, onUpdate }: Props) {
  const toast = useToast();
  const teams = useMemo(() => uniqueTeams(workspace, gender), [workspace, gender]);
  const [team, setTeam] = useState(teams[0] ?? '');
  const [mode, setMode] = useState<ImportMode>('paste');
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<HistoricalSwim[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [format, setFormat] = useState<string>('unknown');
  const [step, setStep] = useState<'paste' | 'preview'>('paste');
  const [showReference, setShowReference] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleParse = () => {
    if (!team.trim()) {
      toast.push('error', 'Select or enter a team name.');
      return;
    }
    if (mode === 'csv') {
      const result = parseCsvHistory(paste, { team: team.trim(), gender });
      if (result.swims.length === 0) {
        toast.push('error', result.warnings[0] || 'No rows parsed from CSV.');
        if (result.warnings.length === 0) return;
      }
      setPreview(result.swims);
      setWarnings(result.warnings);
      setFormat('csv');
      setStep('preview');
      return;
    }
    const result = parseSwimCloudPasteDetailed(paste, {
      team: team.trim(),
      gender,
      division: divisionForTeam(team.trim()),
    });
    setPreview(result.swims);
    setWarnings(result.warnings);
    setFormat(result.format);
    setStep('preview');
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setPaste(text);
      setMode('csv');
    } catch (err) {
      toast.push('error', `Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  const handleMerge = async () => {
    if (preview.length === 0) return;
    const merged = mergeHistoryIndex(workspace.athleteHistory ?? [], preview);
    const sources = [
      ...(workspace.historySources ?? []),
      {
        type: mode === 'csv' ? 'csv_import' : 'swimcloud_paste',
        label: `${format} import (${team})`,
        importedAt: Date.now(),
      },
    ];
    await onUpdate({ athleteHistory: merged, historySources: sources });
    toast.push('success', `Merged ${preview.length} swim(s) into ${team}.`);
    onClose();
  };

  const detectedFormat =
    mode === 'paste' && paste.trim() ? detectSwimCloudPasteFormat(paste) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--backdrop)]">
      <div className="surface-card border border-theme w-full max-w-2xl max-h-[90vh] flex flex-col rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-soft">
          <div>
            <h3 className="text-ui-label font-black uppercase tracking-widest">Import Roster / History</h3>
            <p className="text-ui-caption text-theme-muted mt-1">
              Paste SwimCloud Personal Bests or roster table text
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-2 theme-hover-row rounded" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {step === 'paste' ? (
            <>
              <div className="flex items-center gap-1 border-b border-theme-soft">
                <button
                  type="button"
                  onClick={() => setMode('paste')}
                  className={`px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${mode === 'paste' ? 'border-[var(--text-accent)] text-[var(--text-primary)]' : 'border-transparent nav-tab-inactive'}`}
                >
                  <ClipboardPaste size={13} /> Paste
                </button>
                <button
                  type="button"
                  onClick={() => setMode('csv')}
                  className={`px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${mode === 'csv' ? 'border-[var(--text-accent)] text-[var(--text-primary)]' : 'border-transparent nav-tab-inactive'}`}
                >
                  <FileSpreadsheet size={13} /> CSV
                </button>
                <button
                  type="button"
                  onClick={() => setShowReference(s => !s)}
                  className={`ml-auto px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 transition-colors ${showReference ? 'text-[var(--text-primary)]' : 'nav-tab-inactive'}`}
                >
                  <Globe size={13} /> SwimCloud
                </button>
              </div>

              {showReference ? (
                <div className="border border-theme-soft rounded overflow-hidden">
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
                  <input
                    list="import-teams"
                    value={team}
                    onChange={e => setTeam(e.target.value)}
                    className="glass-input px-3 py-2 rounded text-ui-body"
                    placeholder="Team name"
                  />
                  <datalist id="import-teams">
                    {teams.map(t => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label-caps">Gender</span>
                  <div className="px-3 py-2 rounded border border-theme-soft text-ui-body bg-[var(--surface-muted)]">
                    {gender}
                  </div>
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="label-caps flex items-center gap-2">
                  {mode === 'csv' ? <FileSpreadsheet size={14} /> : <ClipboardPaste size={14} />}
                  {mode === 'csv' ? 'CSV content' : 'Paste text'}
                  {mode === 'csv' ? (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="text-[var(--text-accent)] normal-case hover:underline ml-1"
                    >
                      (choose file…)
                    </button>
                  ) : detectedFormat && detectedFormat !== 'unknown' ? (
                    <span className="text-[var(--text-accent)] normal-case">({detectedFormat.replace('_', ' ')})</span>
                  ) : null}
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv"
                  onChange={handleFile}
                  className="hidden"
                />
                <textarea
                  value={paste}
                  onChange={e => setPaste(e.target.value)}
                  rows={10}
                  className="glass-input px-3 py-2 rounded text-ui-body font-mono text-sm resize-y"
                  placeholder={
                    mode === 'csv'
                      ? 'Paste CSV with header row: name,event,time[,team,gender,date,meet]'
                      : 'Paste Personal Bests or roster table from SwimCloud…'
                  }
                />
              </label>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-ui-caption">
                <span className="badge-info px-2 py-0.5 rounded">{format}</span>
                <span className="text-theme-muted">{preview.length} swims parsed</span>
                {warnings.map(w => (
                  <span key={w} className="badge-warning px-2 py-0.5 rounded">
                    {w}
                  </span>
                ))}
              </div>
              <div className="border border-theme-soft rounded max-h-64 overflow-y-auto custom-scrollbar">
                <table className="w-full text-ui-caption">
                  <thead className="sticky top-0 bg-[var(--surface-strong)]">
                    <tr className="text-left text-theme-muted uppercase tracking-wider">
                      <th className="p-2">Name</th>
                      <th className="p-2">Event</th>
                      <th className="p-2">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((s, i) => (
                      <tr key={i} className="border-t border-theme-soft">
                        <td className="p-2">{s.name}</td>
                        <td className="p-2">{s.event}</td>
                        <td className="p-2 font-mono">{s.time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-soft">
          {step === 'preview' ? (
            <button
              type="button"
              onClick={() => setStep('paste')}
              className="px-4 py-2 text-ui-micro font-bold uppercase tracking-widest nav-tab-inactive hover:text-[var(--text-primary)]"
            >
              Back
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="px-4 py-2 text-ui-micro font-bold uppercase tracking-widest nav-tab-inactive">
            Cancel
          </button>
          {step === 'paste' ? (
            <button
              type="button"
              onClick={handleParse}
              disabled={!paste.trim()}
              className="px-4 py-2 btn-primary rounded text-ui-micro font-bold uppercase tracking-widest disabled:opacity-40"
            >
              Preview
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleMerge()}
              disabled={preview.length === 0}
              className="px-4 py-2 btn-primary rounded text-ui-micro font-bold uppercase tracking-widest disabled:opacity-40"
            >
              Merge into workspace
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
