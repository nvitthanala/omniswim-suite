/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Info, Upload } from 'lucide-react';
import { Gender, HistoricalSwim, SwimCloudBadge, Workspace } from '@omniswim/core/types';
import { mergeHistoryIndex, parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import { divisionForTeam } from '@omniswim/core/data/teamDivisions';

type Props = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  onUpdate: (patch: Partial<Workspace>) => void;
  /** When true, parse/preview still works but merge into workspace is blocked. */
  importDisabled?: boolean;
};

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
  onUpdate,
  importDisabled,
}: Props) {
  const [paste, setPaste] = useState('');
  const [swimmerName, setSwimmerName] = useState('');
  const [preview, setPreview] = useState<HistoricalSwim[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [formatLabel, setFormatLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);

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
    if (!preview.length) return;
    const merged = mergeHistoryIndex(workspace.athleteHistory ?? [], preview);
    const sources = [
      ...(workspace.historySources ?? []),
      {
        type: 'paste',
        label: `Import ${preview.length} swims${swimmerName ? ` (${swimmerName})` : ''}`,
        importedAt: Date.now(),
      },
    ];
    onUpdate({ athleteHistory: merged, historySources: sources });
    setPreview([]);
    setPaste('');
    setWarnings([]);
    setFormatLabel('');
  };

  return (
    <div className="surface-card rounded-lg p-4 shrink-0">
      <div className="flex items-center gap-2 mb-2 relative" ref={infoRef}>
        <h4 className="label-caps flex items-center gap-2 text-[var(--text-primary)]">
          <ClipboardPaste size={14} />
          Athlete history import
        </h4>
        <button
          type="button"
          className="p-1 rounded border border-theme-soft text-theme-secondary hover:text-[var(--text-accent)] hover:border-[var(--text-accent)]/40 transition-colors"
          aria-label="How to copy from SwimCloud"
          onClick={() => setShowInfo(v => !v)}
        >
          <Info size={14} />
        </button>
        {showInfo ? (
          <div className="theme-popover absolute left-0 top-full mt-2 z-20 w-full max-w-md p-3 rounded-lg shadow-lg text-ui-caption">
            <p className="text-ui-label font-bold text-[var(--text-primary)] mb-2 uppercase tracking-wide">
              Copy from SwimCloud
            </p>
            <ol className="list-decimal list-inside space-y-1 text-theme-secondary mb-3">
              <li>Open the swimmer profile on SwimCloud</li>
              <li>Go to the <strong className="text-[var(--text-primary)]">Times</strong> tab</li>
              <li>Select <strong className="text-[var(--text-primary)]">Personal Bests</strong></li>
              <li>Under Sort by, choose <strong className="text-[var(--text-primary)]">Best</strong></li>
              <li>Select the table → Copy → Paste below → Parse text</li>
            </ol>
            <p className="text-theme-muted mb-2">Header lines (name, team, etc.) are OK — we skip them automatically.</p>
            <p className="text-theme-muted">
              <strong className="text-[var(--text-primary)]">Stamp legend:</strong> X = official extracted · U = manual
              entry · A / D1-A = A cut · B / D1-B = B cut
            </p>
          </div>
        ) : null}
      </div>

      <p className="text-ui-caption text-theme-secondary mb-3 leading-relaxed">
        Paste SwimCloud Personal Bests text or upload a screenshot. Copy/paste only — no automatic fetch from
        SwimCloud.
      </p>

      <label className="block text-ui-label text-theme-secondary uppercase tracking-wide mb-1">Swimmer name</label>
      <input
        type="text"
        value={swimmerName}
        disabled={busy}
        onChange={e => setSwimmerName(e.target.value)}
        placeholder="Auto-detected from paste (e.g. Blaise Vera)"
        className="glass-input glass-input-compact w-full mb-3 font-sans"
      />

      <label className="block text-ui-label text-theme-secondary uppercase tracking-wide mb-1">Paste table</label>
      <textarea
        value={paste}
        disabled={busy}
        onChange={e => setPaste(e.target.value)}
        placeholder="Paste Personal Bests table from SwimCloud…"
        className="w-full min-h-[6rem] resize-y glass-input font-mono text-ui-body mb-3"
      />

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          disabled={busy || !paste.trim()}
          onClick={parseLocal}
          className="text-ui-label px-3 py-1.5 btn-accent-outline rounded"
        >
          Parse text
        </button>
        <label className="text-ui-label px-3 py-1.5 border border-theme-soft rounded cursor-pointer flex items-center gap-1.5 hover:bg-[var(--hover-overlay)]">
          <Upload size={12} />
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
        <ul className="text-ui-caption text-amber-400/90 mb-2 list-disc list-inside space-y-0.5">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="text-ui-caption text-amber-400 mb-2">{error}</p> : null}

      {preview.length > 0 ? (
        <div className="border border-theme-soft rounded-lg mb-2 overflow-hidden">
          <div className="max-h-48 overflow-y-auto custom-scrollbar">
            <table className="w-full mono-table text-ui-body">
              <thead className="sticky top-0 surface-muted-bg border-b border-theme-soft">
                <tr className="text-ui-label uppercase text-theme-secondary">
                  <th className="text-left py-2 px-2 font-sans">Event</th>
                  <th className="text-left py-2 px-2 font-sans">Time</th>
                  <th className="text-left py-2 px-2 font-sans hidden sm:table-cell">Meet</th>
                  <th className="text-right py-2 px-2 font-sans">Tags</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((s, i) => (
                  <tr key={i} className="border-b border-theme-soft/50 last:border-0">
                    <td className="py-1.5 px-2 text-[var(--text-primary)]">{s.event}</td>
                    <td className="py-1.5 px-2 font-mono">{s.time}</td>
                    <td className="py-1.5 px-2 text-theme-secondary hidden sm:table-cell truncate max-w-[12rem]" title={s.meetLabel}>
                      {s.meetLabel ?? '—'}
                    </td>
                    <td className="py-1.5 px-2">
                      <SwimRowTags swim={s} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-2 border-t border-theme-soft surface-muted-bg">
            {importDisabled ? (
              <p className="text-ui-caption text-theme-secondary">
                Enable <strong className="text-[var(--text-primary)]">What-if mode</strong> above to import
                these swims into athlete history.
              </p>
            ) : (
              <button
                type="button"
                onClick={confirmImport}
                className="text-ui-label text-[var(--text-accent)] hover:underline font-medium"
              >
                Confirm import to history ({preview.length} swims)
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
