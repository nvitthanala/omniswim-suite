/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { ClipboardPaste, Info, Undo2, Upload } from 'lucide-react';
import { ClassYear, Gender, HistoricalSwim, Workspace } from '@omniswim/core/types';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import {
  formatHistoryImportSummary,
  previewHistoryImportActions,
  previewSwimCloudReplace,
  SwimCloudReplaceRefusedError,
} from '@omniswim/core/lib/historyImportRoster';
import { backupWorkspaces } from '@omniswim/core/api/workspaces';
import {
  addAliasLink,
  buildAliasResolver,
  suggestAliasCandidates,
  type AliasNameEntry,
  type AliasSuggestion,
} from '@omniswim/core/lib/athleteAliases';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import { convertTimeToSeconds } from '@omniswim/core/lib/utils';
import { getCutlinesForSwim } from '@omniswim/core/lib/cutlineUtils';
import { Button, TeamSelect, useToast } from '@omniswim/ui';
import AliasSuggestionsPanel from './AliasSuggestionsPanel';
import { CLASS_YEAR_OPTIONS, SwimRowTags } from './AthleteHistoryImportPanelParts';
import SwimCloudImportModePicker from './SwimCloudImportModePicker';
import SwimCloudReplacePreviewPanel from './SwimCloudReplacePreviewPanel';
import SwimCloudReplaceConfirmModal from './SwimCloudReplaceConfirmModal';
import { performSwimCloudImport, type SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';
import {
  actionBadge,
  buildHistoryBestIndex,
  diffMatchKey,
  rosterNameEntriesForTeam,
  splitUnreadStampWarnings,
  type ImportDiffStatus,
  type RowMeta,
} from './athleteHistoryImportView';

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
  /** Notifies parent of the class years picked in the preview (normalized-name keyed). */
  onClassYearsChange?: (overrides: Record<string, ClassYear>) => void;
};

export default function AthleteHistoryImportPanel({
  workspace,
  gender,
  team,
  teams = [],
  onUpdate,
  onTeamChange,
  importDisabled,
  onClassYearsChange,
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
  const [classYears, setClassYears] = useState<Record<string, ClassYear>>({});
  /** Defaults to 'merge' — see SwimCloudImportModePicker. */
  const [importMode, setImportMode] = useState<SwimCloudImportMode>('merge');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [dismissedAliasKeys, setDismissedAliasKeys] = useState<Set<string>>(new Set());
  const [lastAliasLink, setLastAliasLink] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  const [, startPreviewTransition] = useTransition();
  const infoRef = useRef<HTMLDivElement>(null);
  const teamOptions = teams.length > 0 ? teams : team ? [team] : [];

  const swimmerActions = useMemo(
    () => previewHistoryImportActions(workspace, preview, { team, gender }),
    [workspace, preview, team, gender]
  );

  const replacePreview = useMemo(
    () =>
      importMode === 'replace' && team.trim() && preview.length > 0
        ? previewSwimCloudReplace(workspace, preview, { team, gender })
        : null,
    [importMode, workspace, preview, team, gender]
  );

  // Suggestions compare unmatched incoming swimmers (previewHistoryImportActions
  // couldn't confidently match them to the roster) against every roster name for
  // this team/gender. Depends on workspace.athleteAliases so a just-added link
  // removes its own suggestion (resolver.areLinked short-circuits it) and the
  // list stays current after a Link click re-renders with the patched workspace.
  const aliasSuggestions = useMemo<AliasSuggestion[]>(() => {
    if (!team.trim() || swimmerActions.length === 0) return [];
    const existingNames = rosterNameEntriesForTeam(workspace, team, gender);
    if (existingNames.length === 0) return [];
    // All rows (not just new_recruit): an athlete already on the recruit list
    // under a long-form name still needs a link offer against the roster name.
    const incomingNames: AliasNameEntry[] = swimmerActions.map(s => ({
      name: s.name,
      team: s.team,
      gender: s.gender,
    }));
    if (incomingNames.length === 0) return [];
    const resolver = buildAliasResolver(workspace.athleteAliases ?? []);
    return suggestAliasCandidates(existingNames, incomingNames, { resolver });
  // Deliberate: depends on the individual workspace fields this reads, not the
  // whole object, so an unrelated workspace edit does not re-run the scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspace.menResults,
    workspace.womenResults,
    workspace.recruits,
    workspace.athleteAliases,
    swimmerActions,
    team,
    gender,
  ]);

  const rowMeta = useMemo<RowMeta[]>(() => {
    const resolver = buildAliasResolver(workspace.athleteAliases ?? []);
    const bestIndex = buildHistoryBestIndex(workspace.athleteHistory ?? [], resolver);
    return preview.map(s => {
      const resolvedName = resolver.resolveAthleteName(s.name, s.team, s.gender);
      const key = diffMatchKey(resolvedName, s.team, s.event, s.timeType);
      const existingSec = bestIndex.get(key);
      const sec = convertTimeToSeconds(s.time);
      let diffStatus: ImportDiffStatus;
      let deltaSec: number | undefined;
      if (existingSec == null) {
        diffStatus = 'new';
      } else if (Number.isFinite(sec) && sec < existingSec - 1e-9) {
        diffStatus = 'improved';
        deltaSec = existingSec - sec;
      } else {
        diffStatus = 'same';
      }

      let cutTooltip: string | undefined;
      if (s.computedCut === 'A' || s.computedCut === 'B') {
        const division = divisionForTeamOrNull(s.team);
        if (division) {
          const { aCut, bCut } = getCutlinesForSwim(s.gender, s.event, division);
          const standard = s.computedCut === 'A' ? aCut : bCut;
          if (standard) {
            cutTooltip = `Beats NCAA ${division} ${s.computedCut} cut (${standard.time_25_26})`;
          }
        } else {
          cutTooltip = "This team's division is unknown, so the cut standard shown may not be the right table.";
        }
      }

      return { diffStatus, deltaSec, cutTooltip };
    });
  }, [preview, workspace.athleteHistory, workspace.athleteAliases]);

  const diffSummary = useMemo(() => {
    let newCount = 0;
    let improvedCount = 0;
    let unchangedCount = 0;
    for (const m of rowMeta) {
      if (m.diffStatus === 'new') newCount += 1;
      else if (m.diffStatus === 'improved') improvedCount += 1;
      else unchangedCount += 1;
    }
    return { newCount, improvedCount, unchangedCount };
  }, [rowMeta]);

  const { otherWarnings, unreadStampSummary } = useMemo(
    () => splitUnreadStampWarnings(warnings),
    [warnings]
  );

  const previewNames = useMemo(() => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const s of preview) {
      const key = s.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(s.name);
    }
    return names;
  }, [preview]);

  const setClassYear = (name: string, year: ClassYear) => {
    setClassYears(prev => {
      const next = { ...prev, [name]: year };
      onClassYearsChange?.(next);
      return next;
    });
  };

  const handleLinkAlias = (suggestion: AliasSuggestion) => {
    const result = addAliasLink(workspace, {
      canonicalName: suggestion.existing.name,
      aliasName: suggestion.incoming.name,
      gender: suggestion.incoming.gender,
      team: suggestion.existing.team ?? suggestion.incoming.team,
      source: 'import',
    });
    onUpdate(result.patch);
    setLastAliasLink({ inverse: result.inverse, description: result.description });
    toast.push('success', result.description);
  };

  const handleDismissAlias = (key: string) => {
    setDismissedAliasKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const handleUndoAliasLink = () => {
    if (!lastAliasLink) return;
    onUpdate(lastAliasLink.inverse);
    toast.push('success', `Undid: ${lastAliasLink.description}`);
    setLastAliasLink(null);
  };

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
    const division = divisionForTeamOrNull(team) ?? undefined;
    const result = parseSwimCloudPasteDetailed(paste, {
      team,
      gender,
      swimmerName: swimmerName.trim() || undefined,
      division,
    });
    // The parse is synchronous, but committing a large preview (~850 rows) plus its
    // derived table/badges is the expensive part. Mark those state updates as a
    // transition so the paste box and buttons stay responsive while React renders it.
    startPreviewTransition(() => {
      if (result.detectedName && !swimmerName.trim()) {
        setSwimmerName(result.detectedName);
      }
      setPreview(result.swims);
      setWarnings(result.warnings);
      setFormatLabel(result.format);
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
      setImportMode('merge');
    });
  };

  const _parseText = () => parseLocal();

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
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
      setImportMode('merge');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Returns whether the import committed, so a confirm dialog knows whether it can close. */
  const runImport = async (importOpts: { mode: SwimCloudImportMode }): Promise<boolean> => {
    let backedUp = true;
    try {
      const result = await performSwimCloudImport(
        workspace,
        preview,
        {
          team,
          gender,
          sourceType: 'paste',
          sourceLabel: `Import ${preview.length} swims${swimmerName ? ` (${swimmerName})` : ''}`,
          classYearOverrides: Object.keys(classYears).length > 0 ? classYears : undefined,
          mode: importOpts.mode,
        },
        {
          backup: async () => {
            try {
              await backupWorkspaces();
            } catch (err) {
              backedUp = false;
              throw err;
            }
          },
        }
      );
      if (result.noop) return true;
      onUpdate(result.patch);
      toast.push('success', formatHistoryImportSummary(result.summary));
      setPreview([]);
      setPaste('');
      setWarnings([]);
      setFormatLabel('');
      setClassYears({});
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
      setImportMode('merge');
      return true;
    } catch (err) {
      if (err instanceof SwimCloudReplaceRefusedError) {
        toast.push('error', err.message);
        return false;
      }
      if (!backedUp) {
        toast.push(
          'error',
          `Could not back up the workspace, so the replace was not run: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
      toast.push('error', `Import failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const confirmImport = () => {
    if (!preview.length || !team.trim()) return;
    if (importMode === 'replace') {
      setShowReplaceConfirm(true);
      return;
    }
    void runImport({ mode: 'merge' });
  };

  const handleConfirmReplace = async () => {
    setReplaceBusy(true);
    const committed = await runImport({ mode: 'replace' });
    setReplaceBusy(false);
    // Left open on failure so the coach can see why and retry.
    if (committed) setShowReplaceConfirm(false);
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
        <Button
          variant="outline"
          size="sm"
          className="p-2 text-theme-secondary hover:text-[var(--text-accent)] shrink-0"
          aria-label="How to copy from SwimCloud"
          onClick={() => setShowInfo(v => !v)}
          leadingIcon={<Info size={16} />}
        />
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
            <TeamSelect
              teams={teamOptions}
              value={team && teamOptions.includes(team) ? team : ''}
              disabled={busy}
              onChange={e => onTeamChange?.(e.target.value)}
              className="glass-input w-full rounded-lg px-3 py-2.5 text-ui-body appearance-none"
              placeholderDisabled
            />
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
        <Button variant="outline" size="md" disabled={busy || !paste.trim()} onClick={parseLocal}>
          Parse text
        </Button>
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

      {otherWarnings.length > 0 ? (
        <ul className="text-ui-caption text-amber-400/90 mb-2 list-disc list-inside space-y-1">
          {otherWarnings.map((w, i) => (
            <li key={i} className="break-words">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {unreadStampSummary ? (
        <p className="text-ui-caption text-theme-secondary mb-2 break-words">{unreadStampSummary}</p>
      ) : null}

      {error ? <p className="text-ui-caption text-amber-400 mb-2 break-words">{error}</p> : null}

      {previewNames.length > 0 && !importDisabled ? (
        <div className="mb-3">
          <p className="text-ui-caption text-theme-muted mb-1.5">
            Class years for new roster additions (existing swimmers keep theirs)
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-h-40 overflow-y-auto custom-scrollbar pr-1">
            {previewNames.map(name => (
              <label key={name} className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-ui-body text-theme-secondary truncate" title={name}>
                  {name}
                </span>
                <select
                  value={classYears[name] ?? ''}
                  onChange={e => setClassYear(name, e.target.value as ClassYear)}
                  className="glass-input rounded-lg px-2 py-1 text-ui-caption shrink-0"
                >
                  <option value="" disabled>
                    Default
                  </option>
                  {CLASS_YEAR_OPTIONS.map(y => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      ) : null}

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
                  <tr
                    key={i}
                    className="border-b border-theme-soft/50 last:border-0 theme-hover-row transition-colors"
                    style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 37px' }}
                  >
                    <td className="py-2 px-3 text-[var(--text-primary)] break-words">{s.event}</td>
                    <td className="py-2 px-3 font-mono tabular-nums whitespace-nowrap">{s.time}</td>
                    <td
                      className="py-2 px-3 text-theme-secondary hidden sm:table-cell truncate max-w-[10rem]"
                      title={s.meetLabel}
                    >
                      {s.meetLabel ?? '—'}
                    </td>
                    <td className="py-2 px-3">
                      <SwimRowTags
                        swim={s}
                        diffStatus={rowMeta[i]?.diffStatus ?? 'same'}
                        deltaSec={rowMeta[i]?.deltaSec}
                        cutTooltip={rowMeta[i]?.cutTooltip}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-3 border-t border-theme-soft surface-muted-bg">
            {aliasSuggestions.length > 0 && !importDisabled ? (
              <AliasSuggestionsPanel
                suggestions={aliasSuggestions}
                dismissed={dismissedAliasKeys}
                onLink={handleLinkAlias}
                onDismiss={handleDismissAlias}
              />
            ) : null}
            {lastAliasLink ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleUndoAliasLink}
                title={lastAliasLink.description}
                className="mb-2 w-full truncate rounded-lg border border-theme-soft text-left text-theme-muted hover:text-theme-secondary"
                leadingIcon={<Undo2 size={12} className="shrink-0" />}
              >
                <span className="truncate">Undo: {lastAliasLink.description}</span>
              </Button>
            ) : null}
            <p className="text-ui-caption text-theme-secondary mb-2">
              {diffSummary.newCount} new · {diffSummary.improvedCount} improved ·{' '}
              {diffSummary.unchangedCount} unchanged
            </p>
            {importDisabled ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                Enable <strong className="text-[var(--text-primary)]">What-if</strong> to import onto
                the roster.
              </p>
            ) : !team.trim() ? (
              <p className="text-ui-caption text-amber-400/90">Select a team above before importing.</p>
            ) : (
              <>
                <div className="border border-theme-soft rounded-lg p-3 space-y-3 mb-3">
                  <SwimCloudImportModePicker mode={importMode} onChange={setImportMode} />
                  {replacePreview ? <SwimCloudReplacePreviewPanel preview={replacePreview} /> : null}
                </div>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={confirmImport}
                  className="p-0 text-[var(--text-accent)] hover:underline font-semibold"
                >
                  {importMode === 'replace'
                    ? `Review replace… (${preview.length} swims)`
                    : `Import & add to roster (${preview.length} swims)`}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {showReplaceConfirm && replacePreview ? (
        <SwimCloudReplaceConfirmModal
          preview={replacePreview}
          busy={replaceBusy}
          onCancel={() => setShowReplaceConfirm(false)}
          onConfirm={() => void handleConfirmReplace()}
        />
      ) : null}
    </div>
  );
}
