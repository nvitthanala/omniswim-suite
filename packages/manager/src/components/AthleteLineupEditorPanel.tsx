/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Unified athlete editor: scorer status, meet entries, relay involvement.
 *
 * Rendered as a right-side slide-over drawer (fixed position) rather than
 * inline below the roster table — selecting an athlete used to push a ~950
 * line editor below the fold with no clear sense of who was being edited.
 * The drawer keeps the athlete identity pinned in a sticky header and
 * reorganizes the body into collapsible sections so only one concern is
 * expanded at a time by default.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  History,
  Link2,
  ListChecks,
  Medal,
  Pencil,
  Plus,
  Trash2,
  Undo2,
  X,
  Waves,
} from 'lucide-react';
import {
  Gender,
  HistoricalSwim,
  PlannedSwimEntry,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '@omniswim/core/types';
import { ALL_PLAN_EVENTS } from '@omniswim/core/lib/eventCatalog';
import { createPlannedEntry } from '@omniswim/core/lib/whatIfProjection';
import {
  canAcceptAnotherEntry,
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '@omniswim/core/lib/swimmerEntryLimits';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import { buildCutlineTagForTeam } from '@omniswim/core/lib/cutlineTags';
import {
  canonicalSwimmerName,
  compactEventTitleAttr,
  formatCompactEventLabel,
  isRelayResult,
  normalizeSwimmerName,
} from '@omniswim/core/lib/utils';
import {
  applyScorerOffRelayPatch,
  issueBadgeLabel,
  type LineupAthleteIssue,
} from '@omniswim/core/lib/rosterLineupAudit';
import {
  relayMissingStrokeLabel,
  stableRelayEntryKey,
} from '@omniswim/core/lib/relayLegMatching';
import {
  getAthleteCreditedSwims,
  scorerRosterKey,
  type AthleteCreditedSwim,
  type ScorerRosterRow,
} from '@omniswim/core/lib/scorerRoster';
import {
  addHistorySwim,
  addPlannedEntry,
  editCreditedSwim,
  removeCreditedSwim,
  removeHistorySwim,
  removePlannedEntry,
  updateHistorySwim,
  updatePlannedEntry,
  type HistorySwimRef,
  type WorkspaceEditorPatch,
} from '@omniswim/core/lib/swimEditor';
import { addAliasLink, removeAliasLink } from '@omniswim/core/lib/athleteAliases';
import { CutlineTag, CutlineNearMissChip, useToast } from '@omniswim/ui';
import AthleteCreditedSwimsPanel, { type EditCreditedSwimValues } from './AthleteCreditedSwimsPanel';
import AthleteRoleTag from './AthleteRoleTag';

type TimeType = 'SCY' | 'LCM' | 'SCM';
const TIME_TYPES: TimeType[] = ['SCY', 'LCM', 'SCM'];

type RelayInvolvement = {
  event: string;
  legIndex: number;
  status: 'ok' | 'vacant' | 'removed';
  statusLabel: string;
  relayEntryKey: string;
};

type Props = {
  workspace: Workspace;
  settings: ScoringSettings;
  gender: Gender;
  athlete: ScorerRosterRow;
  issues: LineupAthleteIssue[];
  scoredResults: SwimmerResult[];
  allResults: SwimmerResult[];
  editable: boolean;
  onUpdate: (patch: Partial<Workspace>) => void;
  onClose: () => void;
  autoIsScorer: boolean;
};

/** Collapsible section used to break the drawer body into focused chunks. */
function Section({
  title,
  icon,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-theme-soft last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-1.5 text-ui-caption font-semibold text-theme-muted">
          {icon}
          {title}
          {badge}
        </span>
        {open ? (
          <ChevronUp size={14} className="text-theme-secondary shrink-0" />
        ) : (
          <ChevronDown size={14} className="text-theme-secondary shrink-0" />
        )}
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}

export default function AthleteLineupEditorPanel({
  workspace,
  settings,
  gender,
  athlete,
  issues,
  scoredResults,
  allResults,
  editable,
  onUpdate,
  onClose,
  autoIsScorer,
}: Props) {
  const toast = useToast();
  const [newEvent, setNewEvent] = useState<string>(ALL_PLAN_EVENTS[0]);
  const [newTime, setNewTime] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [editingTimeId, setEditingTimeId] = useState<string | null>(null);
  const [editingTimeValue, setEditingTimeValue] = useState('');
  const [lastApplied, setLastApplied] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  const [newHistoryEvent, setNewHistoryEvent] = useState<string>(ALL_PLAN_EVENTS[0]);
  const [newHistoryTime, setNewHistoryTime] = useState('');
  const [newHistoryTimeType, setNewHistoryTimeType] = useState<TimeType>('SCY');
  const [newHistoryMeet, setNewHistoryMeet] = useState('');
  const [newHistoryDate, setNewHistoryDate] = useState('');
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null);
  const [editingHistoryEvent, setEditingHistoryEvent] = useState('');
  const [editingHistoryTime, setEditingHistoryTime] = useState('');
  const [editingHistoryTimeType, setEditingHistoryTimeType] = useState<TimeType>('SCY');
  const [aliasesOpen, setAliasesOpen] = useState(false);
  const [newAliasText, setNewAliasText] = useState('');
  const [pastePreview, setParsePreview] = useState<Array<{ event: string; time: string; selected: boolean }>>([]);

  // A fresh athlete selection should never inherit a stale undo chip or open editors.
  useEffect(() => {
    setLastApplied(null);
    setEditingTimeId(null);
    setEditingHistoryId(null);
    setNewAliasText('');
    setParsePreview([]);
    setPasteOpen(false);
    setPasteText('');
  }, [athlete.key]);

  // Escape closes the drawer, same as the backdrop click / X button.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Lost-update guard (BUG 3.2): every editor patch is a full-array replacement
  // computed from the workspace it was built against. During a rapid double-edit
  // (two clicks before React re-renders with the applied patch) the second build
  // would read the STALE `workspace` prop and overwrite the first edit. We keep a
  // ref to the freshest workspace — the prop, composed forward with each patch we
  // apply this render cycle — and build every patch against it so successive edits
  // compose instead of clobbering. The store's optimistic cache is likewise a
  // functional `{ ...w, ...patch }` merge, so the composed arrays land intact.
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const applyResult = (result: WorkspaceEditorPatch) => {
    workspaceRef.current = { ...workspaceRef.current, ...result.patch };
    onUpdate(result.patch);
    setLastApplied({ inverse: result.inverse, description: result.description });
    toast.push('success', result.description);
  };

  /** Build a patch against the freshest (composed) workspace, then apply it. */
  const applyPatch = (build: (ws: Workspace) => WorkspaceEditorPatch) => {
    applyResult(build(workspaceRef.current));
  };

  /** Apply a raw patch (no undo chip) while keeping the compose-ref current. */
  const applyRawPatch = (patch: Partial<Workspace>) => {
    workspaceRef.current = { ...workspaceRef.current, ...patch };
    onUpdate(patch);
  };

  const handleUndo = () => {
    if (!lastApplied) return;
    applyRawPatch(lastApplied.inverse);
    toast.push('success', `Undid: ${lastApplied.description}`);
    setLastApplied(null);
  };

  const plans = workspace.meetEntryPlans ?? [];
  const athleteCanonical = canonicalSwimmerName(athlete.name);
  const athleteTeamTrim = String(athlete.team ?? '').trim();
  const athletePlans = plans.filter(
    p =>
      canonicalSwimmerName(p.name) === athleteCanonical &&
      String(p.team ?? '').trim() === athleteTeamTrim &&
      p.gender === gender
  );

  const creditedSwims = useMemo(
    () => getAthleteCreditedSwims(scoredResults, athlete.team, athlete.name, gender),
    [scoredResults, athlete.team, athlete.name, gender]
  );
  const creditedPoints = useMemo(
    () => creditedSwims.reduce((sum, s) => sum + (s.points > 0 ? s.points : 0), 0),
    [creditedSwims]
  );

  const historyRef = (row: HistoricalSwim): HistorySwimRef =>
    row.id
      ? { id: row.id }
      : {
          name: row.name,
          team: row.team,
          gender: row.gender,
          event: row.event,
          time: row.time,
          timeType: (row.timeType as TimeType) ?? 'SCY',
        };

  const athleteHistoryRows = useMemo(
    () =>
      (workspace.athleteHistory ?? []).filter(
        h =>
          normalizeSwimmerName(h.name) === normalizeSwimmerName(athlete.name) &&
          String(h.team ?? '').trim() === athlete.team &&
          h.gender === gender
      ),
    [workspace.athleteHistory, athlete.name, athlete.team, gender]
  );

  // Links (either direction) that involve this athlete's canonical name —
  // matched via canonicalSwimmerName so "Last, First" and reordered spellings
  // still resolve to the same identity as the roster row.
  const athleteAliasLinks = useMemo(
    () =>
      (workspace.athleteAliases ?? []).filter(link => {
        if (link.gender !== gender) return false;
        return (
          canonicalSwimmerName(link.canonicalName) === athleteCanonical ||
          canonicalSwimmerName(link.aliasName) === athleteCanonical
        );
      }),
    [workspace.athleteAliases, gender, athleteCanonical]
  );

  const handleAddAlias = () => {
    if (!editable) return;
    const alias = newAliasText.trim();
    if (!alias) return;
    if (canonicalSwimmerName(alias) === athleteCanonical) {
      toast.push('error', 'That already matches the athlete name.');
      return;
    }
    applyPatch(ws =>
      addAliasLink(ws, {
        canonicalName: athlete.name,
        aliasName: alias,
        gender,
        team: athlete.team,
        source: 'manual',
      })
    );
    setNewAliasText('');
  };

  const handleRemoveAlias = (id: string) => {
    if (!editable) return;
    applyPatch(ws => removeAliasLink(ws, id));
  };

  const handleEditCreditedSwim = (swim: AthleteCreditedSwim, changes: EditCreditedSwimValues) => {
    applyPatch(ws => editCreditedSwim(ws, gender, swim.id, changes));
  };

  const handleDeleteCreditedSwim = (swim: AthleteCreditedSwim) => {
    if (swim.isRecruit) {
      applyPatch(ws => {
        const baseRecruits = ws.recruits ?? [];
        return {
          patch: { recruits: baseRecruits.filter(r => r.id !== swim.id) },
          inverse: { recruits: baseRecruits },
          description: `Remove recruit entry (${swim.event})`,
        };
      });
      return;
    }
    applyPatch(ws => removeCreditedSwim(ws, gender, swim.id));
  };

  const startHistoryEdit = (row: HistoricalSwim) => {
    setEditingHistoryId(row.id ?? `${row.name}|${row.event}|${row.time}`);
    setEditingHistoryEvent(row.event);
    setEditingHistoryTime(row.time);
    setEditingHistoryTimeType((row.timeType as TimeType) ?? 'SCY');
  };

  const cancelHistoryEdit = () => {
    setEditingHistoryId(null);
    setEditingHistoryEvent('');
    setEditingHistoryTime('');
  };

  const commitHistoryEdit = (row: HistoricalSwim) => {
    const time = editingHistoryTime.trim();
    cancelHistoryEdit();
    if (!time) return;
    if (time === row.time && editingHistoryEvent === row.event && editingHistoryTimeType === (row.timeType ?? 'SCY')) {
      return;
    }
    applyPatch(ws =>
      updateHistorySwim(ws, historyRef(row), {
        time,
        event: editingHistoryEvent,
        timeType: editingHistoryTimeType,
      })
    );
  };

  const removeHistoryRow = (row: HistoricalSwim) => {
    applyPatch(ws => removeHistorySwim(ws, historyRef(row)));
  };

  const addHistoryRow = () => {
    if (!editable || !newHistoryTime.trim()) return;
    applyPatch(ws =>
      addHistorySwim(ws, {
        name: athlete.name,
        team: athlete.team,
        gender,
        event: newHistoryEvent,
        time: newHistoryTime.trim(),
        timeType: newHistoryTimeType,
        meet: newHistoryMeet.trim() || undefined,
        date: newHistoryDate.trim() || undefined,
      })
    );
    setNewHistoryTime('');
    setNewHistoryMeet('');
    setNewHistoryDate('');
  };

  const counts = countSwimmerEntries(allResults, athlete.team, gender, athlete.name);
  const over = swimmerExceedsEntryLimits(counts, settings);

  const relayInvolvement = useMemo((): RelayInvolvement[] => {
    const pdf = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
    const nameKey = normalizeSwimmerName(athlete.name);
    const out: RelayInvolvement[] = [];
    const seen = new Set<string>();

    for (const leg of scoredResults) {
      if (!isRelayResult(leg) || String(leg.team ?? '').trim() !== athlete.team) continue;
      if (leg.name === leg.team) continue;
      const entryKey = stableRelayEntryKey(pdf, leg);
      const legIdx = leg.relayLegIndex ?? 0;
      const rowKey = `${entryKey}|${legIdx}`;
      if (seen.has(rowKey)) continue;

      const isVacant = Boolean(leg.relayLegVacant || leg.relayMissingLeg);
      const onThisLeg =
        normalizeSwimmerName(leg.name) === nameKey ||
        (isVacant &&
          pdf.some(r => {
            if (!isRelayResult(r) || r.team !== athlete.team) return false;
            if (r.event !== leg.event || r.rank !== leg.rank) return false;
            if ((r.relayLegIndex ?? -1) !== legIdx) return false;
            return normalizeSwimmerName(r.name) === nameKey;
          }) ||
          pdf.some(
            r =>
              isRelayResult(r) &&
              r.team === athlete.team &&
              r.event === leg.event &&
              r.relayNames?.[legIdx] &&
              normalizeSwimmerName(r.relayNames[legIdx].name) === nameKey
          ));

      if (!onThisLeg && !isVacant) continue;
      if (!onThisLeg && isVacant) {
        // Only show vacant if this athlete was the departed name
        const departed =
          pdf.find(
            r =>
              isRelayResult(r) &&
              r.team === athlete.team &&
              r.event === leg.event &&
              (r.relayLegIndex ?? -1) === legIdx &&
              normalizeSwimmerName(r.name) === nameKey
          ) ||
          pdf.find(
            r =>
              isRelayResult(r) &&
              r.team === athlete.team &&
              r.event === leg.event &&
              r.relayNames?.[legIdx] &&
              normalizeSwimmerName(r.relayNames[legIdx].name) === nameKey
          );
        if (!departed) continue;
      }

      seen.add(rowKey);
      let status: RelayInvolvement['status'] = 'ok';
      let statusLabel = 'OK';
      if (isVacant) {
        const scorerOff = issues.some(i => i.type === 'relay_scorer_off');
        status = scorerOff ? 'removed' : 'vacant';
        const stroke = relayMissingStrokeLabel(leg.relayMissingLeg?.stroke);
        statusLabel = scorerOff
          ? 'Removed — not a scorer; fill this leg'
          : stroke
            ? `Vacant — needs ${stroke}`
            : 'Vacant — needs filling';
      }
      out.push({
        event: leg.event,
        legIndex: legIdx,
        status,
        statusLabel,
        relayEntryKey: entryKey,
      });
    }
    return out;
  }, [athlete.name, athlete.team, gender, scoredResults, workspace.menResults, workspace.womenResults, issues]);

  const setScorer = (isScorer: boolean) => {
    if (!editable) return;
    const ws = workspaceRef.current;
    const key = scorerRosterKey(athlete.team, gender, athlete.name);
    const rest = (ws.scorerRosterOverrides ?? []).filter(
      o => scorerRosterKey(o.team, o.gender, o.name) !== key
    );
    const nextOverrides =
      isScorer === autoIsScorer
        ? rest
        : [...rest, { name: athlete.name, team: athlete.team, gender, isScorer }];

    const patch = applyScorerOffRelayPatch(ws, {
      name: athlete.name,
      team: athlete.team,
      gender,
      isScorer,
      overrides: nextOverrides,
    });
    applyRawPatch(patch);
    if (!isScorer && relayInvolvement.length > 0) {
      toast.push(
        'info',
        `${athlete.name}: non-scorers cannot swim relays — leg(s) vacated. Fill them on Relays.`
      );
    }
  };

  const addEntry = () => {
    if (!editable || !newTime.trim()) return;
    if (!canAcceptAnotherEntry(counts, settings, newEvent)) {
      toast.push('error', 'Entry limit reached for this type');
      return;
    }
    applyPatch(ws =>
      addPlannedEntry(ws, {
        name: athlete.name,
        team: athlete.team,
        gender,
        classYear: athlete.classYear,
        event: newEvent,
        time: newTime.trim(),
      })
    );
    setNewTime('');
  };

  const removeEntry = (id: string) => {
    applyPatch(ws => removePlannedEntry(ws, id));
  };

  const startTimeEdit = (p: PlannedSwimEntry) => {
    setEditingTimeId(p.id);
    setEditingTimeValue(p.time);
  };

  const cancelTimeEdit = () => {
    setEditingTimeId(null);
    setEditingTimeValue('');
  };

  const commitTimeEdit = (p: PlannedSwimEntry) => {
    const time = editingTimeValue.trim();
    cancelTimeEdit();
    if (!time || time === p.time) return;
    applyPatch(ws => updatePlannedEntry(ws, p.id, { time }));
  };

  const changeEntryEvent = (p: PlannedSwimEntry, event: string) => {
    if (event === p.event) return;
    applyPatch(ws => updatePlannedEntry(ws, p.id, { event }));
  };

  const toggleActive = (id: string) => {
    if (!editable) return;
    const target = athletePlans.find(p => p.id === id);
    if (!target) return;
    const enabling = target.active === false;
    if (enabling) {
      const without = countSwimmerEntries(
        allResults.filter(r => r.id !== id),
        athlete.team,
        gender,
        athlete.name
      );
      if (!canAcceptAnotherEntry(without, settings, target.event)) {
        toast.push('error', 'Entry limit reached — cannot re-enable');
        return;
      }
    }
    applyPatch(ws => updatePlannedEntry(ws, id, { active: enabling }));
  };

  const previewPaste = () => {
    if (!editable || !pasteText.trim()) return;
    const parsed = parseSwimCloudPasteDetailed(pasteText, {
      team: athlete.team,
      gender,
      swimmerName: athlete.name,
      division: divisionForTeamOrNull(athlete.team) ?? undefined,
    });
    if (parsed.swims.length === 0) {
      toast.push('error', parsed.warnings[0] || 'No swims parsed from paste.');
      return;
    }
    let runningCounts = { individual: counts.individual, relayCount: counts.relayCount };
    const have = new Set(athletePlans.map(p => p.event));
    const preview: Array<{ event: string; time: string; selected: boolean }> = [];
    const sorted = [...parsed.swims].sort((a, b) => {
      const aRelay = /\brelay\b/i.test(a.event) ? 1 : 0;
      const bRelay = /\brelay\b/i.test(b.event) ? 1 : 0;
      return aRelay - bRelay;
    });
    for (const swim of sorted) {
      if (have.has(swim.event)) continue;
      const probe = {
        individual: runningCounts.individual,
        relayEvents: new Set<string>(),
        relayCount: runningCounts.relayCount,
      };
      if (!canAcceptAnotherEntry(probe, settings, swim.event)) continue;
      preview.push({ event: swim.event, time: swim.time, selected: true });
      have.add(swim.event);
      if (/\brelay\b/i.test(swim.event)) runningCounts.relayCount += 1;
      else runningCounts.individual += 1;
    }
    if (preview.length === 0) {
      toast.push('error', 'No entries can be added (all events exist or limits reached).');
      return;
    }
    setParsePreview(preview);
  };

  const confirmPastePreview = () => {
    const selected = pastePreview.filter(p => p.selected);
    if (selected.length === 0) return;
    const parsed = parseSwimCloudPasteDetailed(pasteText, {
      team: athlete.team,
      gender,
      swimmerName: athlete.name,
      division: divisionForTeamOrNull(athlete.team) ?? undefined,
    });
    const selectedEvents = new Set(selected.map(p => p.event));
    const swims = parsed.swims.filter(s => selectedEvents.has(s.event));
    const next = [
      ...athletePlans,
      ...swims.map(swim =>
        createPlannedEntry({
          name: athlete.name,
          team: athlete.team,
          gender,
          classYear: athlete.classYear,
          event: swim.event,
          time: swim.time,
          timeType: swim.timeType ?? 'SCY',
          source: 'swimcloud',
          active: true,
        })
      ),
    ];
    const ws = workspaceRef.current;
    const basePlans = ws.meetEntryPlans ?? [];
    const removedPlanIds = new Set(athletePlans.map(p => p.id));
    applyRawPatch({
      meetEntryPlans: [
        ...basePlans.filter(
          p =>
            !(
              canonicalSwimmerName(p.name) === athleteCanonical &&
              String(p.team ?? '').trim() === athleteTeamTrim &&
              p.gender === gender
            )
        ),
        ...next,
      ],
      activeEntryIds: [
        ...(ws.activeEntryIds ?? []).filter(id => !removedPlanIds.has(id)),
        ...next.filter(p => p.active !== false).map(p => p.id),
      ],
      athleteHistory: [...(ws.athleteHistory ?? []), ...swims],
    });
    toast.push('success', `Added ${selected.length} lineup entr${selected.length === 1 ? 'y' : 'ies'} from paste`);
    setPasteText('');
    setParsePreview([]);
    setPasteOpen(false);
  };

  const canAddSelected = canAcceptAnotherEntry(counts, settings, newEvent);

  return (
    <>
      {/* Backdrop only below lg, where the drawer covers most of the viewport.
          On large screens the roster table must stay clickable beside the drawer
          (one-click athlete switching); Escape / X / re-clicking the row close it. */}
      <div
        className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        id="athlete-lineup-editor"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${athlete.name}`}
        className="fixed inset-y-0 right-0 z-50 flex flex-col w-[min(40rem,92vw)] surface-card border-l border-theme-soft shadow-2xl"
      >
        <div className="shrink-0 surface-overlay border-b border-theme-soft px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h5 className="text-lg font-semibold text-[var(--text-primary)] truncate">
                {athlete.name}
              </h5>
              <p className="text-ui-caption text-theme-secondary mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="truncate max-w-[10rem]" title={athlete.team}>
                  {athlete.team}
                </span>
                <span className="text-theme-muted">·</span>
                <span>{athlete.classYear || '—'}</span>
                <AthleteRoleTag role={athlete.athleteRole} isRecruit={athlete.isRecruit} />
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-theme-muted hover:text-[var(--text-primary)] shrink-0"
              aria-label="Close athlete editor"
            >
              <X size={18} />
            </button>
          </div>

          {issues.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {issues.map((issue, i) => (
                <span
                  key={`${issue.type}-${i}`}
                  className="text-ui-caption px-1.5 py-0.5 rounded-full border border-amber-400/40 text-amber-400"
                  title={issue.message}
                >
                  {issueBadgeLabel(issue)}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={athlete.isScorer}
                disabled={!editable}
                onChange={e => setScorer(e.target.checked)}
                className="accent-[var(--text-accent)]"
              />
              <span className="text-ui-label font-medium text-[var(--text-primary)]">Scorer</span>
            </label>
            <p className="text-ui-caption text-theme-muted text-right max-w-[12rem] leading-relaxed">
              Non-scorers are removed from relay legs automatically.
            </p>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={() => setAliasesOpen(v => !v)}
              aria-expanded={aliasesOpen}
              className="flex items-center gap-1.5 text-ui-caption text-theme-secondary hover:text-[var(--text-accent)] transition-colors"
            >
              <Link2 size={12} />
              Aliases{athleteAliasLinks.length > 0 ? ` (${athleteAliasLinks.length})` : ''}
              {aliasesOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {aliasesOpen ? (
              <div className="mt-2 space-y-1.5">
                {athleteAliasLinks.length > 0 ? (
                  <ul className="space-y-1">
                    {athleteAliasLinks.map(link => (
                      <li
                        key={link.id}
                        className="flex items-center justify-between gap-2 text-ui-caption"
                      >
                        <span
                          className="truncate min-w-0 text-theme-secondary"
                          title={`${link.aliasName} → ${link.canonicalName}`}
                        >
                          {link.aliasName} → {link.canonicalName}
                        </span>
                        {editable ? (
                          <button
                            type="button"
                            onClick={() => handleRemoveAlias(link.id)}
                            className="p-1 rounded-md text-theme-muted hover:text-amber-400 transition-colors shrink-0"
                            aria-label={`Remove alias ${link.aliasName}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ui-micro text-theme-muted italic">
                    No linked spellings for this athlete.
                  </p>
                )}
                {editable ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newAliasText}
                      onChange={e => setNewAliasText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAddAlias();
                      }}
                      placeholder="Add alias spelling…"
                      className="flex-1 min-w-0 glass-input rounded-lg px-2 py-1.5 text-ui-caption"
                    />
                    <button
                      type="button"
                      onClick={handleAddAlias}
                      disabled={!newAliasText.trim()}
                      className="text-ui-caption px-2 py-1.5 border border-theme-soft rounded-lg disabled:opacity-40 shrink-0"
                    >
                      Link
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {lastApplied ? (
            <button
              type="button"
              onClick={handleUndo}
              title={lastApplied.description}
              className="flex w-full items-center gap-1.5 truncate border-b border-theme-soft surface-muted-bg px-4 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
            >
              <Undo2 size={12} className="shrink-0" />
              <span className="truncate">Undo: {lastApplied.description}</span>
            </button>
          ) : null}

          {/* Keyed on athlete.key so each newly-selected athlete opens with the
              same default section states (Individual entries expanded, the rest
              collapsed) rather than inheriting whatever the previous athlete had
              toggled. */}
          <div key={athlete.key}>
            <Section title="Individual entries" icon={<Waves size={14} />} defaultOpen>
              <p className="text-ui-caption text-theme-secondary mb-2">
                {formatEntryLimitLabel(counts, settings)}
                {over.individualOver || over.relayOver || over.totalOver ? (
                  <span className="text-amber-400 ml-2">Over limit</span>
                ) : null}
              </p>
              {athletePlans.length > 0 ? (
                <ul className="space-y-1.5 mb-3">
                  {athletePlans.map(p => {
                    const cutlineResult = buildCutlineTagForTeam({
                      time: p.time,
                      gender,
                      event: p.event,
                      team: athlete.team,
                    });
                    return (
                    <li key={p.id} className="flex items-center gap-2 text-ui-body">
                      {editable ? (
                        <input
                          type="checkbox"
                          checked={p.active !== false}
                          onChange={() => toggleActive(p.id)}
                          className="accent-[var(--text-accent)] shrink-0"
                          title="Active in lineup"
                          aria-label={`Active ${p.event}`}
                        />
                      ) : null}
                      {editable ? (
                        <select
                          value={p.event}
                          onChange={e => changeEntryEvent(p, e.target.value)}
                          title={compactEventTitleAttr(p.event)}
                          className={`flex-1 min-w-0 font-mono glass-input rounded-lg px-1.5 py-1 text-ui-caption ${
                            p.active === false ? 'opacity-40' : ''
                          }`}
                        >
                          {ALL_PLAN_EVENTS.map(ev => (
                            <option key={ev} value={ev}>
                              {formatCompactEventLabel(ev)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={`flex-1 truncate font-mono min-w-0 ${
                            p.active === false ? 'opacity-40 line-through' : ''
                          }`}
                          title={compactEventTitleAttr(p.event)}
                        >
                          {formatCompactEventLabel(p.event)}
                        </span>
                      )}
                      {editingTimeId === p.id ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingTimeValue}
                          onChange={e => setEditingTimeValue(e.target.value)}
                          onBlur={() => commitTimeEdit(p)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitTimeEdit(p);
                            if (e.key === 'Escape') cancelTimeEdit();
                          }}
                          className="w-24 font-mono tabular-nums glass-input rounded-lg px-2 py-1 text-ui-caption"
                        />
                      ) : (
                        <button
                          type="button"
                          disabled={!editable}
                          onClick={() => startTimeEdit(p)}
                          className="w-24 text-left font-mono tabular-nums glass-input rounded-lg px-2 py-1 text-ui-caption disabled:cursor-default"
                          title={editable ? 'Click to edit time' : undefined}
                        >
                          {p.time}
                        </button>
                      )}
                      <CutlineTag result={cutlineResult} compact />
                      <CutlineNearMissChip
                        nextTier={cutlineResult.nextTier}
                        compact
                        className="hidden sm:inline-flex"
                      />
                      {editable ? (
                        <button
                          type="button"
                          onClick={() => removeEntry(p.id)}
                          className="p-1 rounded-md text-theme-muted hover:text-amber-400 transition-colors"
                          aria-label={`Remove ${p.event}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                    </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-ui-caption text-theme-muted mb-3 italic">No planned individual entries yet.</p>
              )}
              {editable ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2 items-end">
                    <select
                      value={newEvent}
                      onChange={e => setNewEvent(e.target.value)}
                      className="flex-1 min-w-[10rem] glass-input rounded-lg px-2 py-2 text-ui-body"
                    >
                      {ALL_PLAN_EVENTS.map(ev => (
                        <option key={ev} value={ev}>
                          {ev}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Time"
                      value={newTime}
                      onChange={e => setNewTime(e.target.value)}
                      className="w-24 font-mono glass-input rounded-lg px-2 py-2 text-ui-body"
                    />
                    <button
                      type="button"
                      onClick={addEntry}
                      disabled={!canAddSelected || !newTime.trim()}
                      title={!canAddSelected ? 'Entry limit reached for this type' : undefined}
                      className="text-ui-label px-3 py-2 border border-theme-soft rounded-lg flex items-center gap-1.5 disabled:opacity-40"
                    >
                      <Plus size={14} /> Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (pasteOpen && pastePreview.length === 0) {
                          setPasteOpen(false);
                        } else if (!pasteOpen) {
                          setPasteOpen(true);
                        }
                      }}
                      className="text-ui-label px-3 py-2 border border-theme-soft rounded-lg flex items-center gap-1.5"
                    >
                      <ClipboardPaste size={14} /> Paste
                    </button>
                  </div>
                  {pasteOpen ? (
                    <div className="space-y-2">
                      {pastePreview.length === 0 ? (
                        <>
                          <textarea
                            value={pasteText}
                            onChange={e => setPasteText(e.target.value)}
                            rows={4}
                            placeholder="Paste SwimCloud Personal Bests for this swimmer…"
                            className="w-full font-mono glass-input rounded-lg px-3 py-2 text-ui-caption resize-y"
                          />
                          <button
                            type="button"
                            onClick={previewPaste}
                            disabled={!pasteText.trim()}
                            className="text-ui-label px-3 py-2 btn-accent-outline rounded-lg disabled:opacity-40"
                          >
                            Preview suggested entries
                          </button>
                        </>
                      ) : (
                        <>
                          <p className="text-ui-caption text-theme-secondary mb-2">
                            Select entries to add (uncheck to skip):
                          </p>
                          <ul className="space-y-1.5 border border-theme-soft rounded-lg p-2 max-h-48 overflow-y-auto">
                            {pastePreview.map((item, idx) => (
                              <li
                                key={`${item.event}|${idx}`}
                                className="flex items-center gap-2 text-ui-body"
                              >
                                <input
                                  type="checkbox"
                                  checked={item.selected}
                                  onChange={() => {
                                    setParsePreview(prev =>
                                      prev.map((p, i) =>
                                        i === idx ? { ...p, selected: !p.selected } : p
                                      )
                                    );
                                  }}
                                  className="accent-[var(--text-accent)] shrink-0"
                                />
                                <span className="font-mono text-ui-caption flex-1 min-w-0">
                                  {formatCompactEventLabel(item.event)}
                                </span>
                                <span className="font-mono text-ui-caption text-theme-secondary">
                                  {item.time}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={confirmPastePreview}
                              disabled={pastePreview.every(p => !p.selected)}
                              className="flex-1 text-ui-label px-3 py-2 btn-accent-outline rounded-lg disabled:opacity-40"
                            >
                              Add selected
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setParsePreview([]);
                                setPasteText('');
                              }}
                              className="text-ui-label px-3 py-2 border border-theme-soft rounded-lg"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Section>

            <Section title="Relay involvement" icon={<ListChecks size={14} />}>
              {relayInvolvement.length === 0 ? (
                <p className="text-ui-caption text-theme-muted italic">Not on any projected relay legs.</p>
              ) : (
                <ul className="space-y-2">
                  {relayInvolvement.map(r => (
                    <li
                      key={`${r.relayEntryKey}|${r.legIndex}`}
                      className="flex items-start justify-between gap-3 text-ui-body"
                    >
                      <span className="min-w-0 truncate" title={r.event}>
                        {formatCompactEventLabel(r.event)} · leg {r.legIndex + 1}
                      </span>
                      <span
                        className={`shrink-0 text-ui-caption ${
                          r.status === 'ok' ? 'text-theme-secondary' : 'text-amber-400'
                        }`}
                      >
                        {r.statusLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              title="Credited swims"
              icon={<Medal size={14} />}
              badge={
                creditedSwims.length > 0 ? (
                  <span className="text-ui-micro text-theme-muted">({creditedSwims.length})</span>
                ) : null
              }
            >
              {creditedSwims.length > 0 ? (
                <AthleteCreditedSwimsPanel
                  athleteName={athlete.name}
                  team={athlete.team}
                  swims={creditedSwims}
                  totalPoints={creditedPoints}
                  gender={gender}
                  deletable={editable}
                  onDeleteSwim={editable ? handleDeleteCreditedSwim : undefined}
                  onEditSwim={editable ? handleEditCreditedSwim : undefined}
                  entryLimitLabel={formatEntryLimitLabel(counts, settings)}
                />
              ) : (
                <p className="text-ui-caption text-theme-muted italic">
                  No credited swims from the loaded meet yet.
                </p>
              )}
            </Section>

            <Section
              title="Supplemental history"
              icon={<History size={14} />}
              badge={
                athleteHistoryRows.length > 0 ? (
                  <span className="text-ui-micro text-theme-muted">({athleteHistoryRows.length})</span>
                ) : null
              }
            >
              <p className="text-ui-micro text-theme-muted mb-2 leading-relaxed">
                Supplemental bests (not from the loaded meet) that feed cross-course arbitrage and
                optimizer profiles.
              </p>
              {athleteHistoryRows.length > 0 ? (
                <ul className="space-y-1.5 mb-3">
                  {athleteHistoryRows.map(row => {
                    const rowKey = row.id ?? `${row.name}|${row.event}|${row.time}`;
                    const isEditing = editingHistoryId === rowKey;
                    const cutlineResult = buildCutlineTagForTeam({
                      time: row.time,
                      gender,
                      event: row.event,
                      team: athlete.team,
                      swimCourse: (row.timeType as TimeType) ?? 'SCY',
                    });
                    return (
                      <li key={rowKey} className="flex items-center gap-2 text-ui-body">
                        {isEditing ? (
                          <>
                            <select
                              value={editingHistoryEvent}
                              onChange={e => setEditingHistoryEvent(e.target.value)}
                              className="flex-1 min-w-0 font-mono glass-input rounded-lg px-1.5 py-1 text-ui-caption"
                              autoFocus
                            >
                              {ALL_PLAN_EVENTS.map(ev => (
                                <option key={ev} value={ev}>
                                  {formatCompactEventLabel(ev)}
                                </option>
                              ))}
                            </select>
                            <input
                              type="text"
                              value={editingHistoryTime}
                              onChange={e => setEditingHistoryTime(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitHistoryEdit(row);
                                if (e.key === 'Escape') cancelHistoryEdit();
                              }}
                              placeholder="Time"
                              className="w-20 font-mono tabular-nums glass-input rounded-lg px-2 py-1 text-ui-caption"
                            />
                            <select
                              value={editingHistoryTimeType}
                              onChange={e => setEditingHistoryTimeType(e.target.value as TimeType)}
                              className="w-16 glass-input rounded-lg px-1 py-1 text-ui-caption"
                            >
                              {TIME_TYPES.map(t => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => commitHistoryEdit(row)}
                              className="p-1 rounded-md text-theme-muted hover:text-points-positive hover:bg-points-positive/10 transition-colors"
                              aria-label={`Save history ${row.event}`}
                            >
                              <Check size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={cancelHistoryEdit}
                              className="p-1 rounded-md text-theme-muted hover:text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
                              aria-label={`Cancel history edit ${row.event}`}
                            >
                              <X size={14} />
                            </button>
                          </>
                        ) : (
                          <>
                            <span
                              className="flex-1 truncate font-mono min-w-0"
                              title={compactEventTitleAttr(row.event)}
                            >
                              {formatCompactEventLabel(row.event)}
                            </span>
                            <span className="w-20 shrink-0 font-mono tabular-nums text-ui-caption text-theme-secondary">
                              {row.time}
                            </span>
                            <span className="w-10 shrink-0 text-ui-micro text-theme-muted uppercase">
                              {row.timeType ?? 'SCY'}
                            </span>
                            {row.meetLabel ? (
                              <span
                                className="hidden sm:inline text-ui-micro text-theme-muted truncate max-w-[6rem]"
                                title={row.meetLabel}
                              >
                                {row.meetLabel}
                              </span>
                            ) : null}
                            {/* Hidden below sm — this row is already tight on mobile
                                (event, time, course, meet label all compete for space). */}
                            <CutlineTag className="hidden sm:inline-flex" compact result={cutlineResult} />
                            <CutlineNearMissChip
                              className="hidden sm:inline-flex"
                              compact
                              nextTier={cutlineResult.nextTier}
                            />
                            {editable ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => startHistoryEdit(row)}
                                  className="p-1 rounded-md text-theme-muted hover:text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors shrink-0"
                                  aria-label={`Edit history ${row.event}`}
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeHistoryRow(row)}
                                  className="p-1 rounded-md text-theme-muted hover:text-amber-400 transition-colors shrink-0"
                                  aria-label={`Remove history ${row.event}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </>
                            ) : null}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-ui-caption text-theme-muted mb-3 italic">
                  No supplemental history for this athlete.
                </p>
              )}
              {editable ? (
                <div className="flex flex-wrap gap-2 items-end">
                  <select
                    value={newHistoryEvent}
                    onChange={e => setNewHistoryEvent(e.target.value)}
                    className="flex-1 min-w-[9rem] glass-input rounded-lg px-2 py-2 text-ui-body"
                  >
                    {ALL_PLAN_EVENTS.map(ev => (
                      <option key={ev} value={ev}>
                        {ev}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Time"
                    value={newHistoryTime}
                    onChange={e => setNewHistoryTime(e.target.value)}
                    className="w-20 font-mono glass-input rounded-lg px-2 py-2 text-ui-body"
                  />
                  <select
                    value={newHistoryTimeType}
                    onChange={e => setNewHistoryTimeType(e.target.value as TimeType)}
                    className="w-16 glass-input rounded-lg px-1 py-2 text-ui-body"
                  >
                    {TIME_TYPES.map(t => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Meet (optional)"
                    value={newHistoryMeet}
                    onChange={e => setNewHistoryMeet(e.target.value)}
                    className="w-28 glass-input rounded-lg px-2 py-2 text-ui-body"
                  />
                  <input
                    type="text"
                    placeholder="Date (optional)"
                    value={newHistoryDate}
                    onChange={e => setNewHistoryDate(e.target.value)}
                    className="w-28 glass-input rounded-lg px-2 py-2 text-ui-body"
                  />
                  <button
                    type="button"
                    onClick={addHistoryRow}
                    disabled={!newHistoryTime.trim()}
                    className="text-ui-label px-3 py-2 border border-theme-soft rounded-lg flex items-center gap-1.5 disabled:opacity-40"
                  >
                    <Plus size={14} /> Add
                  </button>
                </div>
              ) : null}
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}
