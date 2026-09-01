/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { ClipboardPaste, Info, Undo2, Upload } from 'lucide-react';
import { ClassYear, Gender, HistoricalSwim, SwimCloudBadge, Workspace } from '@omniswim/core/types';
import { normalizeEventLabel, parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import {
  formatHistoryImportSummary,
  importHistoryToRoster,
  previewHistoryImportActions,
  rosterNamesForTeam,
  type ImportSwimmerAction,
} from '@omniswim/core/lib/historyImportRoster';
import {
  addAliasLink,
  buildAliasResolver,
  suggestAliasCandidates,
  type AliasNameEntry,
  type AliasSuggestion,
  type AthleteAliasResolver,
} from '@omniswim/core/lib/athleteAliases';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import { convertTimeToSeconds, foldDiacritics, normalizeSwimmerName } from '@omniswim/core/lib/utils';
import { getCutlinesForSwim } from '@omniswim/core/lib/cutlineUtils';
import { useToast } from '@omniswim/ui';
import AliasSuggestionsPanel from './AliasSuggestionsPanel';

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

const CLASS_YEAR_OPTIONS: ClassYear[] = [
  ClassYear.FR,
  ClassYear.SO,
  ClassYear.JR,
  ClassYear.SR,
  ClassYear.HS,
];

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

/** Diacritic/course-insensitive-name + event + course key used to diff a parsed swim against athleteHistory. */
function diffMatchKey(name: string, team: string, event: string, timeType?: string): string {
  const foldedName = foldDiacritics(normalizeSwimmerName(name));
  const normEvent = normalizeEventLabel(event).toLowerCase();
  return `${foldedName}|${team.trim().toLowerCase()}|${normEvent}|${timeType ?? 'SCY'}`;
}

/**
 * Best (fastest) existing seconds per athlete+event+course, from the workspace's
 * athleteHistory. Names are resolved through the alias resolver first so a
 * confirmed link ("Stevie" -> "Steven") unifies the diff onto one identity.
 */
function buildHistoryBestIndex(history: HistoricalSwim[], resolver: AthleteAliasResolver): Map<string, number> {
  const map = new Map<string, number>();
  for (const h of history) {
    const resolvedName = resolver.resolveAthleteName(h.name, h.team, h.gender);
    const key = diffMatchKey(resolvedName, h.team, h.event, h.timeType);
    const sec = convertTimeToSeconds(h.time);
    const prev = map.get(key);
    if (prev == null || sec < prev) map.set(key, sec);
  }
  return map;
}

/** Roster names (results + recruits) for a team/gender — the "existing" side of alias suggestions. */
function rosterNameEntriesForTeam(workspace: Workspace, team: string, gender: Gender): AliasNameEntry[] {
  return rosterNamesForTeam(workspace, team, gender).map(name => ({ name, team, gender }));
}

type ImportDiffStatus = 'new' | 'improved' | 'same';

type RowMeta = {
  diffStatus: ImportDiffStatus;
  deltaSec?: number;
  cutTooltip?: string;
};

function DiffBadge({ status, deltaSec }: { status: ImportDiffStatus; deltaSec?: number }) {
  if (status === 'new') {
    return (
      <span
        className="text-ui-micro text-[var(--text-accent)] border border-[var(--text-accent)]/30 px-1.5 rounded-full"
        title="No existing time for this event/course"
      >
        NEW
      </span>
    );
  }
  if (status === 'improved') {
    const label = deltaSec != null ? deltaSec.toFixed(2) : '0.00';
    return (
      <span
        className="text-ui-micro border border-emerald-400/30 bg-emerald-400/10 text-emerald-300 px-1.5 rounded-full"
        title={`${label}s faster than the existing recorded best`}
      >
        -{label}s
      </span>
    );
  }
  return (
    <span
      className="text-ui-micro text-theme-muted border border-theme-soft px-1.5 rounded-full"
      title="Not faster than the existing recorded best for this event/course"
    >
      SAME
    </span>
  );
}

type SwimRowTagSpec = {
  key: string;
  show: boolean;
  className: string;
  title?: string;
  label: string;
};

/** The badge-driven tag row for one swim: which chips to show is decided by
 * the SwimCloud badge stamp plus (for A/B cuts) a locally computed fallback.
 * Built as data and filtered, rather than five independent JSX `&&` guards. */
function buildSwimRowTagSpecs(
  stamp: ReturnType<typeof badgeLabel>,
  swim: HistoricalSwim,
  cutTooltip: string | undefined
): SwimRowTagSpec[] {
  const showComputedA = swim.computedCut === 'A' && swim.swimcloudBadge !== 'd1_a';
  const showComputedB = swim.computedCut === 'B' && swim.swimcloudBadge !== 'd1_b';
  return [
    {
      key: 'official',
      show: stamp === 'Official',
      className: 'text-ui-micro text-theme-secondary border border-theme-soft px-1.5 rounded-full',
      title: 'Extracted official result',
      label: 'Official',
    },
    {
      key: 'manual',
      show: stamp === 'Manual',
      className: 'text-ui-micro badge-warning px-1.5 rounded-full',
      title: 'User-entered time',
      label: 'Manual',
    },
    {
      key: 'a-cut',
      show: stamp === 'A CUT' || showComputedA,
      className: 'text-ui-micro btn-accent-outline px-1.5 rounded-full',
      title: cutTooltip,
      label: 'A CUT',
    },
    {
      key: 'b-cut',
      show: stamp === 'B CUT' || showComputedB,
      className: 'text-ui-micro bg-amber-400/10 text-amber-400 px-1.5 border border-amber-400/30 rounded-full',
      title: cutTooltip,
      label: 'B CUT',
    },
    {
      key: 'tag',
      show: stamp === 'Tag',
      className: 'text-ui-micro text-theme-muted border border-theme-soft px-1.5 rounded-full',
      label: 'Tag',
    },
  ];
}

function SwimRowTags({
  swim,
  diffStatus,
  deltaSec,
  cutTooltip,
}: {
  swim: HistoricalSwim;
  diffStatus: ImportDiffStatus;
  deltaSec?: number;
  cutTooltip?: string;
}) {
  const stamp = badgeLabel(swim.swimcloudBadge);
  const tags = buildSwimRowTagSpecs(stamp, swim, cutTooltip).filter(tag => tag.show);

  return (
    <div className="flex flex-wrap gap-1 justify-end">
      <DiffBadge status={diffStatus} deltaSec={deltaSec} />
      {tags.map(tag => (
        <span key={tag.key} className={tag.className} title={tag.title}>
          {tag.label}
        </span>
      ))}
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
    });
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
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
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
      classYearOverrides: Object.keys(classYears).length > 0 ? classYears : undefined,
    });
    if (result.noop) return;
    onUpdate(result.patch);
    toast.push('success', formatHistoryImportSummary(result.summary));
    setPreview([]);
    setPaste('');
    setWarnings([]);
    setFormatLabel('');
    setClassYears({});
    setDismissedAliasKeys(new Set());
    setLastAliasLink(null);
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
              <button
                type="button"
                onClick={handleUndoAliasLink}
                title={lastAliasLink.description}
                className="mb-2 flex w-full items-center gap-1.5 truncate rounded-lg border border-theme-soft px-2.5 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
              >
                <Undo2 size={12} className="shrink-0" />
                <span className="truncate">Undo: {lastAliasLink.description}</span>
              </button>
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
