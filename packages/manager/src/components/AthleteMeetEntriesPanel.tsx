/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ClipboardPaste, Plus, Trash2 } from 'lucide-react';
import { Gender, PlannedSwimEntry, ScoringSettings, Workspace } from '@omniswim/core/types';
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
import { compactEventTitleAttr, formatCompactEventLabel } from '@omniswim/core/lib/utils';
import { useToast } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  settings: ScoringSettings;
  gender: Gender;
  athleteName: string;
  team: string;
  classYear?: string;
  editable: boolean;
  onUpdate: (patch: Partial<Workspace>) => void;
};

export default function AthleteMeetEntriesPanel({
  workspace,
  settings,
  gender,
  athleteName,
  team,
  classYear,
  editable,
  onUpdate,
}: Props) {
  const toast = useToast();
  const [newEvent, setNewEvent] = useState<string>(ALL_PLAN_EVENTS[0]);
  const [newTime, setNewTime] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const plans = workspace.meetEntryPlans ?? [];
  const athletePlans = plans.filter(
    p => p.name === athleteName && p.team === team && p.gender === gender
  );

  const allResults = [
    ...(gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? []),
    ...athletePlans.map(
      p =>
        ({
          id: p.id,
          name: p.name,
          team: p.team,
          gender: p.gender,
          event: p.event,
          time: p.time,
          isRelay: p.event.toLowerCase().includes('relay'),
        }) as const
    ),
  ];
  const counts = countSwimmerEntries(allResults as never, team, gender, athleteName);
  const over = swimmerExceedsEntryLimits(counts, settings);

  const patchPlans = (next: PlannedSwimEntry[], activeIds?: string[]) => {
    const rest = plans.filter(
      p => !(p.name === athleteName && p.team === team && p.gender === gender)
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

  const addEntry = () => {
    if (!editable || !newTime.trim()) return;
    if (!canAcceptAnotherEntry(counts, settings, newEvent)) return;
    const entry = createPlannedEntry({
      name: athleteName,
      team,
      gender,
      classYear,
      event: newEvent,
      time: newTime.trim(),
      source: 'manual',
      active: true,
    });
    const next = [...athletePlans, entry];
    patchPlans(next, next.filter(p => p.active !== false).map(p => p.id));
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

  const importFromPaste = () => {
    if (!editable || !pasteText.trim()) return;
    const parsed = parseSwimCloudPasteDetailed(pasteText, {
      team,
      gender,
      swimmerName: athleteName,
      division: divisionForTeam(team),
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
        name: athleteName,
        team,
        gender,
        classYear,
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
    // Also merge into athlete history for optimizer profiles
    onUpdate({
      meetEntryPlans: [
        ...plans.filter(p => !(p.name === athleteName && p.team === team && p.gender === gender)),
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

  if (!editable && athletePlans.length === 0) return null;

  const canAddSelected = canAcceptAnotherEntry(counts, settings, newEvent);

  return (
    <div className="mt-2 border border-theme-soft rounded-lg p-2">
      <p className="text-[9px] text-theme-secondary uppercase tracking-widest mb-1">
        Meet entries · {formatEntryLimitLabel(counts, settings)}
        {over.individualOver || over.relayOver ? (
          <span className="text-amber-400 ml-2">Over limit</span>
        ) : null}
      </p>
      {athletePlans.length > 0 ? (
        <ul className="space-y-1 mb-2">
          {athletePlans.map(p => (
            <li key={p.id} className="flex items-center gap-2 text-[10px]">
              <span className="flex-1 truncate font-mono" title={compactEventTitleAttr(p.event)}>
                {formatCompactEventLabel(p.event)}
              </span>
              <input
                type="text"
                value={p.time}
                disabled={!editable}
                onChange={e => updateTime(p.id, e.target.value)}
                className="w-20 font-mono surface-muted-bg border border-theme-soft rounded px-1 py-0.5 text-[9px]"
              />
              {editable ? (
                <button
                  type="button"
                  onClick={() => removeEntry(p.id)}
                  className="text-theme-muted hover:text-amber-400"
                >
                  <Trash2 size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1 items-end">
            <select
              value={newEvent}
              onChange={e => setNewEvent(e.target.value)}
              className="flex-1 min-w-[8rem] text-[9px] surface-muted-bg border border-theme-soft rounded px-1 py-1"
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
              className="w-20 font-mono text-[9px] surface-muted-bg border border-theme-soft rounded px-1 py-1"
            />
            <button
              type="button"
              onClick={addEntry}
              disabled={!canAddSelected}
              title={!canAddSelected ? 'Entry limit reached for this type' : undefined}
              className="text-[9px] px-2 py-1 border border-theme-soft rounded flex items-center gap-1 disabled:opacity-40"
            >
              <Plus size={10} /> Add
            </button>
            <button
              type="button"
              onClick={() => setPasteOpen(v => !v)}
              className="text-[9px] px-2 py-1 border border-theme-soft rounded flex items-center gap-1"
              title="Paste SwimCloud personal bests for this athlete"
            >
              <ClipboardPaste size={10} /> Paste
            </button>
          </div>
          {pasteOpen ? (
            <div className="space-y-1">
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={4}
                placeholder="Paste SwimCloud Personal Bests for this swimmer…"
                className="w-full text-[9px] font-mono surface-muted-bg border border-theme-soft rounded px-2 py-1 resize-y"
              />
              <button
                type="button"
                onClick={importFromPaste}
                disabled={!pasteText.trim()}
                className="text-[9px] px-2 py-1 btn-accent-outline rounded disabled:opacity-40"
              >
                Parse & add to lineup
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
