/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Unified athlete editor: scorer status, meet entries, relay involvement.
 */

import React, { useMemo, useState } from 'react';
import { ClipboardPaste, Plus, Trash2, X, Waves } from 'lucide-react';
import {
  Gender,
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
import { divisionForTeam } from '@omniswim/core/data/teamDivisions';
import {
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
import { scorerRosterKey, type ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import { useToast } from '@omniswim/ui';

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

  const plans = workspace.meetEntryPlans ?? [];
  const athletePlans = plans.filter(
    p => p.name === athlete.name && p.team === athlete.team && p.gender === gender
  );

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

  const patchPlans = (next: PlannedSwimEntry[], activeIds?: string[]) => {
    const rest = plans.filter(
      p => !(p.name === athlete.name && p.team === athlete.team && p.gender === gender)
    );
    const patch: Partial<Workspace> = { meetEntryPlans: [...rest, ...next] };
    if (activeIds) {
      const otherActive = (workspace.activeEntryIds ?? []).filter(
        id => !athletePlans.some(p => p.id === id)
      );
      patch.activeEntryIds = [...otherActive, ...activeIds];
    }
    onUpdate(patch);
  };

  const setScorer = (isScorer: boolean) => {
    if (!editable) return;
    const key = scorerRosterKey(athlete.team, gender, athlete.name);
    const rest = (workspace.scorerRosterOverrides ?? []).filter(
      o => scorerRosterKey(o.team, o.gender, o.name) !== key
    );
    const nextOverrides =
      isScorer === autoIsScorer
        ? rest
        : [...rest, { name: athlete.name, team: athlete.team, gender, isScorer }];

    const patch = applyScorerOffRelayPatch(workspace, {
      name: athlete.name,
      team: athlete.team,
      gender,
      isScorer,
      overrides: nextOverrides,
    });
    onUpdate(patch);
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
    const entry = createPlannedEntry({
      name: athlete.name,
      team: athlete.team,
      gender,
      classYear: athlete.classYear,
      event: newEvent,
      time: newTime.trim(),
      source: 'manual',
      active: true,
    });
    const next = [...athletePlans, entry];
    patchPlans(
      next,
      next.filter(p => p.active !== false).map(p => p.id)
    );
    setNewTime('');
  };

  const removeEntry = (id: string) => {
    const next = athletePlans.filter(p => p.id !== id);
    patchPlans(
      next,
      next.filter(p => p.active !== false).map(p => p.id)
    );
  };

  const updateTime = (id: string, time: string) => {
    patchPlans(athletePlans.map(p => (p.id === id ? { ...p, time } : p)));
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
    const next = athletePlans.map(p =>
      p.id === id ? { ...p, active: enabling ? true : false } : p
    );
    patchPlans(
      next,
      next.filter(p => p.active !== false).map(p => p.id)
    );
  };

  const importFromPaste = () => {
    if (!editable || !pasteText.trim()) return;
    const parsed = parseSwimCloudPasteDetailed(pasteText, {
      team: athlete.team,
      gender,
      swimmerName: athlete.name,
      division: divisionForTeam(athlete.team),
    });
    if (parsed.swims.length === 0) {
      toast.push('error', parsed.warnings[0] || 'No swims parsed from paste.');
      return;
    }
    let runningCounts = { individual: counts.individual, relayCount: counts.relayCount };
    const have = new Set(athletePlans.map(p => p.event));
    const next = [...athletePlans];
    let added = 0;
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
      const entry = createPlannedEntry({
        name: athlete.name,
        team: athlete.team,
        gender,
        classYear: athlete.classYear,
        event: swim.event,
        time: swim.time,
        timeType: swim.timeType ?? 'SCY',
        source: 'swimcloud',
        active: true,
      });
      next.push(entry);
      have.add(swim.event);
      if (/\brelay\b/i.test(swim.event)) runningCounts.relayCount += 1;
      else runningCounts.individual += 1;
      added += 1;
    }
    onUpdate({
      meetEntryPlans: [
        ...plans.filter(
          p => !(p.name === athlete.name && p.team === athlete.team && p.gender === gender)
        ),
        ...next,
      ],
      activeEntryIds: [
        ...(workspace.activeEntryIds ?? []).filter(id => !athletePlans.some(p => p.id === id)),
        ...next.filter(p => p.active !== false).map(p => p.id),
      ],
      athleteHistory: [...(workspace.athleteHistory ?? []), ...parsed.swims],
    });
    toast.push('success', `Added ${added} lineup entr${added === 1 ? 'y' : 'ies'} from paste`);
    setPasteText('');
    setPasteOpen(false);
  };

  const canAddSelected = canAcceptAnotherEntry(counts, settings, newEvent);

  return (
    <div
      id="athlete-lineup-editor"
      className="mt-4 border border-theme-soft rounded-xl surface-overlay overflow-hidden"
    >
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-theme-soft">
        <div className="min-w-0">
          <h5 className="text-ui-label font-semibold text-[var(--text-primary)] truncate">
            {athlete.name}
          </h5>
          <p className="text-ui-caption text-theme-secondary mt-0.5">
            {athlete.classYear || '—'} · {formatEntryLimitLabel(counts, settings)}
            {over.individualOver || over.relayOver ? (
              <span className="text-amber-400 ml-2">Over limit</span>
            ) : null}
          </p>
          {issues.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {issues.map((issue, i) => (
                <span
                  key={`${issue.type}-${i}`}
                  className="text-ui-caption px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-400"
                  title={issue.message}
                >
                  {issueBadgeLabel(issue)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-theme-muted hover:text-[var(--text-primary)]"
          aria-label="Close athlete editor"
        >
          <X size={16} />
        </button>
      </div>

      <div className="px-4 py-3 border-b border-theme-soft flex items-center justify-between gap-3">
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
        <p className="text-ui-caption text-theme-muted text-right max-w-xs leading-relaxed">
          Non-scorers are removed from relay legs automatically.
        </p>
      </div>

      <div className="px-4 py-3 border-b border-theme-soft">
        <h6 className="text-ui-caption font-semibold text-theme-muted mb-2 flex items-center gap-1.5">
          <Waves size={14} /> Individual entries
        </h6>
        {athletePlans.length > 0 ? (
          <ul className="space-y-1.5 mb-3">
            {athletePlans.map(p => (
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
                <span
                  className={`flex-1 truncate font-mono min-w-0 ${
                    p.active === false ? 'opacity-40 line-through' : ''
                  }`}
                  title={compactEventTitleAttr(p.event)}
                >
                  {formatCompactEventLabel(p.event)}
                </span>
                <input
                  type="text"
                  value={p.time}
                  disabled={!editable}
                  onChange={e => updateTime(p.id, e.target.value)}
                  className="w-24 font-mono glass-input rounded-lg px-2 py-1 text-ui-caption"
                />
                {editable ? (
                  <button
                    type="button"
                    onClick={() => removeEntry(p.id)}
                    className="p-1 rounded text-theme-muted hover:text-amber-400"
                    aria-label={`Remove ${p.event}`}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </li>
            ))}
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
                onClick={() => setPasteOpen(v => !v)}
                className="text-ui-label px-3 py-2 border border-theme-soft rounded-lg flex items-center gap-1.5"
              >
                <ClipboardPaste size={14} /> Paste
              </button>
            </div>
            {pasteOpen ? (
              <div className="space-y-2">
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  rows={4}
                  placeholder="Paste SwimCloud Personal Bests for this swimmer…"
                  className="w-full font-mono glass-input rounded-lg px-3 py-2 text-ui-caption resize-y"
                />
                <button
                  type="button"
                  onClick={importFromPaste}
                  disabled={!pasteText.trim()}
                  className="text-ui-label px-3 py-2 btn-accent-outline rounded-lg disabled:opacity-40"
                >
                  Parse &amp; add to lineup
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="px-4 py-3">
        <h6 className="text-ui-caption font-semibold text-theme-muted mb-2">Relay involvement</h6>
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
      </div>
    </div>
  );
}
