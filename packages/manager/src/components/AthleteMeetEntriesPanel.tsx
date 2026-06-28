/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Gender, PlannedSwimEntry, ScoringSettings, Workspace } from '@omniswim/core/types';
import { ALL_PLAN_EVENTS } from '@omniswim/core/lib/eventCatalog';
import { createPlannedEntry } from '@omniswim/core/lib/whatIfProjection';
import {
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '@omniswim/core/lib/swimmerEntryLimits';

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
  const [newEvent, setNewEvent] = useState<string>(ALL_PLAN_EVENTS[0]);
  const [newTime, setNewTime] = useState('');

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

  const patchPlans = (next: PlannedSwimEntry[]) => {
    const rest = plans.filter(
      p => !(p.name === athleteName && p.team === team && p.gender === gender)
    );
    onUpdate({ meetEntryPlans: [...rest, ...next] });
  };

  const addEntry = () => {
    if (!editable || !newTime.trim()) return;
    if (over.individualOver && !newEvent.toLowerCase().includes('relay')) return;
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
    patchPlans([...athletePlans, entry]);
    setNewTime('');
  };

  const removeEntry = (id: string) => {
    patchPlans(athletePlans.filter(p => p.id !== id));
  };

  const updateTime = (id: string, time: string) => {
    patchPlans(athletePlans.map(p => (p.id === id ? { ...p, time } : p)));
  };

  if (!editable && athletePlans.length === 0) return null;

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
              <span className="flex-1 truncate">{p.event}</span>
              <input
                type="text"
                value={p.time}
                disabled={!editable}
                onChange={e => updateTime(p.id, e.target.value)}
                className="w-20 font-mono surface-muted-bg border border-theme-soft rounded px-1 py-0.5 text-[9px]"
              />
              {editable ? (
                <button type="button" onClick={() => removeEntry(p.id)} className="text-theme-muted hover:text-amber-400">
                  <Trash2 size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
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
            className="text-[9px] px-2 py-1 border border-theme-soft rounded flex items-center gap-1"
          >
            <Plus size={10} /> Add
          </button>
        </div>
      ) : null}
    </div>
  );
}
