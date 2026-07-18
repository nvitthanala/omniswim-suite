/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Info, Upload } from 'lucide-react';
import { Gender, HistoricalSwim, SwimCloudBadge, Workspace } from '@omniswim/core/types';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import {
  formatHistoryImportSummary,
  importHistoryToRoster,
  previewHistoryImportActions,
  type ImportSwimmerAction,
} from '@omniswim/core/lib/historyImportRoster';
import { divisionForTeam } from '@omniswim/core/data/teamDivisions';
import { useToast } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  /** Teams available for the import target selector. */
  teams?: string[];
  onUpdate: (patch: Partial<Workspace>) => void;
  onTeamChange?: (team: string) => void;
  /** When true, parse/preview still works but merge into workspace is blocked. */
  importDisabled?: boolean;
};

function actionBadge(action: ImportSwimmerAction): { label: string; className: string } {
  switch (action) {
    case 'new_recruit':
      return { label: 'New recruit', className: 'text-[var(--text-accent)] border-[var(--text-accent)]/30' };
    case 'add_to_lineup':
      return { label: 'Add to lineup', className: 'badge-info' };
    case 'already_recruit':
      return { label: 'Already recruit', className: 'badge-warning' };
    case 'history_matched':
    default:
      return { label: 'History only (matched)', className: 'text-theme-muted border-theme-soft' };
  }
}

function badgeLabel(badge?: SwimCloudBadge): string | null {
  switch (badge) {
    case 'extracted':
      return 'Official';
    case 'user_input':
      return 'Manual';
    case 'd1_a':
      return 'A CUT';
    case 'd1_b':
      return 'B CUT';
    case 'other':
      return 'Tag';
    default:
      return null;
  }
}

function SwimRowTags({ swim }: { swim: HistoricalSwim }) {
  const stamp = badgeLabel(swim.swimcloudBadge);
  const showComputedA = swim.computedCut === 'A' && swim.swimcloudBadge !== 'd1_a';
  const showComputedB = swim.computedCut === 'B' && swim.swimcloudBadge !== 'd1_b';

  return (
    <div className="flex flex-wrap gap-1 justify-end">
      {stamp === 'Official' && (
        <span className="text-ui-micro text-theme-secondary border border-theme-soft px-1 rounded" title="Extracted official result">
          Official
        </span>
      )}
      {stamp === 'Manual' && (
        <span className="text-ui-micro badge-warning px-1 rounded" title="User-entered time">
          Manual
        </span>
      )}
      {(stamp === 'A CUT' || showComputedA) && (
        <span className="text-ui-micro btn-accent-outline px-1 rounded">A CUT</span>
      )}
      {(stamp === 'B CUT' || showComputedB) && (
        <span className="text-ui-micro bg-amber-400/10 text-amber-400 px-1 border border-amber-400/30 rounded">
          B CUT
        </span>
      )}
      {stamp === 'Tag' && (
        <span className="text-ui-micro text-theme-muted border border-theme-soft px-1 rounded">Tag</span>
      )}
    </div>
  );
}

export default function AthleteHistoryImportPanel({
  workspace,
  gender,
  team,
  teams = [],
  onUpdate,
  onTeamChange,
  importDisabled,
}: Props) {
  const toast = useToast();
  const [paste, setPaste] = useState('');
  const [swimmerName, setSwimmerName] = useState('');
  const [preview, setPreview] = useState<HistoricalSwim[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [formatLabel, setFormatLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  const teamOptions = teams.length > 0 ? teams : team ? [team] : [];

  const swimmerActions = useMemo(
    () => previewHistoryImportActions(workspace, preview, { team, gender }),
    [workspace, preview, team, gender]
  );

  useEffect(() => {
    if (!showInfo) return;
    const onDoc = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setShowInfo(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showInfo]);

  const parseLocal = () => {
    setError('');
    if (!team.trim()) {
      setError('Select a team before parsing.');
      return;
    }
    const division = divisionForTeam(team);
    const result = parseSwimCloudPasteDetailed(paste, {
      team,
      gender,
      swimmerName: swimmerName.trim() || undefined,
      division,
    });
    if (result.detectedName && !swimmerName.trim()) {
      setSwimmerName(result.detectedName);
    }
    setPreview(result.swims);
    setWarnings(result.warnings);
    setFormatLabel(result.format);
  };

  const parseText = () => parseLocal();

  const parseImage = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const s = String(reader.result ?? '');
          resolve(s.split(',')[1] ?? '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/parse-athlete-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, team, gender }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setPreview([]);
        return;
      }
      setPreview(data.swims ?? []);
      setWarnings(data.warnings ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = () => {
    if (!preview.length || !team.trim()) return;
    const result = importHistoryToRoster(workspace, preview, {
      team,
      gender,
      sourceType: 'paste',
      sourceLabel: `Import ${preview.length} swims${swimmerName ? ` (${swimmerName})` : ''}`,
    });
    if (result.noop) return;
    onUpdate(result.patch);
    toast.push('success', formatHistoryImportSummary(result.summary));
    setPreview([]);
    setPaste('');
    setWarnings([]);
    setFormatLabel('');
  };

  return (
    <div className="surface-card rounded-xl p-4 sm:p-5 shrink-0 min-w-0">
      <div className="flex items-start justify-between gap-3 mb-3 relative" ref={infoRef}>
        <div className="min-w-0">
          <h4 className="text-ui-label font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <ClipboardPaste size={16} className="text-[var(--text-accent)] shrink-0" />
            SwimCloud import
          </h4>
          <p className="text-ui-body text-theme-secondary mt-1 leading-relaxed">
            Paste Personal Bests (or a roster table). We add new swimmers to the roster and line up
            events for athletes already on the team.
          </p>
        </div>
        <button
          type="button"
          className="p-2 rounded-lg border border-theme-soft text-theme-secondary hover:text-[var(--text-accent)] hover:border-[var(--text-accent)]/40 transition-colors shrink-0"
          aria-label="How to copy from SwimCloud"
          onClick={() => setShowInfo(v => !v)}
        >
          <Info size={16} />
        </button>
        {showInfo ? (
          <div className="theme-popover absolute right-0 top-full mt-2 z-20 w-full max-w-md p-4 rounded-xl shadow-lg text-ui-body">
            <p className="text-ui-label font-semibold text-[var(--text-primary)] mb-2">
              Copy from SwimCloud
            </p>
            <ol className="list-decimal list-inside space-y-1.5 text-theme-secondary mb-3">
              <li>Open the swimmer profile on SwimCloud</li>
              <li>
                Go to the <strong className="text-[var(--text-primary)]">Times</strong> tab
              </li>
              <li>
                Select <strong className="text-[var(--text-primary)]">Personal Bests</strong>
              </li>
              <li>
                Sort by <strong className="text-[var(--text-primary)]">Best</strong>
              </li>
              <li>Copy the table → paste below → Parse</li>
            </ol>
            <p className="text-theme-muted">
              Header lines are fine. Stamps: X official · U manual · A/B cuts.
            </p>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        {teamOptions.length > 0 ? (
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className="text-ui-caption text-theme-muted">Team</span>
            <select
              value={team && teamOptions.includes(team) ? team : ''}
              disabled={busy}
              onChange={e => onTeamChange?.(e.target.value)}
              className="glass-input w-full rounded-lg px-3 py-2.5 text-ui-body appearance-none"
            >
              <option value="" disabled>
                Select a team…
              </option>
              {teamOptions.map(t => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1.5 min-w-0">
          <span className="text-ui-caption text-theme-muted">Swimmer name (optional)</span>
          <input
            type="text"
            value={swimmerName}
            disabled={busy}
            onChange={e => setSwimmerName(e.target.value)}
            placeholder="Auto-detected from paste"
            className="glass-input w-full rounded-lg px-3 py-2.5 font-sans text-ui-body"
          />
        </label>
      </div>

      {!team && teamOptions.length > 0 ? (
        <p className="text-ui-caption text-amber-400/90 mb-3">
          Choose which team these times belong to before importing.
        </p>
      ) : null}

      <label className="flex flex-col gap-1.5 mb-3">
        <span className="text-ui-caption text-theme-muted">Paste table</span>
        <textarea
          value={paste}
          disabled={busy}
          onChange={e => setPaste(e.target.value)}
          placeholder="Paste Personal Bests table from SwimCloud…"
          className="w-full min-h-[8rem] resize-y glass-input rounded-lg px-3 py-2.5 font-mono text-ui-body"
        />
      </label>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          disabled={busy || !paste.trim()}
          onClick={parseLocal}
          className="text-ui-label px-4 py-2 btn-accent-outline rounded-lg font-medium disabled:opacity-40"
        >
          Parse text
        </button>
        <label className="text-ui-label px-4 py-2 border border-theme-soft rounded-lg cursor-pointer flex items-center gap-2 hover:bg-[var(--hover-overlay)]">
          <Upload size={14} />
          Screenshot
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={busy}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) parseImage(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {formatLabel ? (
        <p className="text-ui-caption text-theme-secondary mb-2">
          Detected: <span className="text-[var(--text-accent)]">{formatLabel.replace('_', ' ')}</span>
          {preview.length > 0 ? ` · ${preview.length} rows` : null}
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="text-ui-caption text-amber-400/90 mb-2 list-disc list-inside space-y-1">
          {warnings.map((w, i) => (
            <li key={i} className="break-words">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="text-ui-caption text-amber-400 mb-2 break-words">{error}</p> : null}

      {swimmerActions.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-3">
          {swimmerActions.map(s => {
            const badge = actionBadge(s.action);
            return (
              <span
                key={`${s.name}|${s.action}`}
                className={`text-ui-caption px-2 py-1 rounded-lg border max-w-full truncate ${badge.className}`}
                title={`${s.name}: ${badge.label} · ${s.swimCount} swim(s)`}
              >
                {s.name}: {badge.label}
              </span>
            );
          })}
        </div>
      ) : null}

      {preview.length > 0 ? (
        <div className="border border-theme-soft rounded-xl overflow-hidden">
          <div className="max-h-56 overflow-y-auto custom-scrollbar">
            <table className="w-full text-ui-body">
              <thead className="sticky top-0 surface-muted-bg border-b border-theme-soft">
                <tr className="text-ui-caption text-theme-muted">
                  <th className="text-left py-2.5 px-3 font-medium">Event</th>
                  <th className="text-left py-2.5 px-3 font-medium">Time</th>
                  <th className="text-left py-2.5 px-3 font-medium hidden sm:table-cell">Meet</th>
                  <th className="text-right py-2.5 px-3 font-medium">Tags</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((s, i) => (
                  <tr key={i} className="border-b border-theme-soft/50 last:border-0">
                    <td className="py-2 px-3 text-[var(--text-primary)] break-words">{s.event}</td>
                    <td className="py-2 px-3 font-mono whitespace-nowrap">{s.time}</td>
                    <td
                      className="py-2 px-3 text-theme-secondary hidden sm:table-cell truncate max-w-[10rem]"
                      title={s.meetLabel}
                    >
                      {s.meetLabel ?? '—'}
                    </td>
                    <td className="py-2 px-3">
                      <SwimRowTags swim={s} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-3 border-t border-theme-soft surface-muted-bg">
            {importDisabled ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                Enable <strong className="text-[var(--text-primary)]">What-if</strong> to import onto
                the roster.
              </p>
            ) : !team.trim() ? (
              <p className="text-ui-caption text-amber-400/90">Select a team above before importing.</p>
            ) : (
              <button
                type="button"
                onClick={confirmImport}
                className="text-ui-label text-[var(--text-accent)] hover:underline font-semibold"
              >
                Import & add to roster ({preview.length} swims)
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
