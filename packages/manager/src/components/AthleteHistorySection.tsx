/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Supplemental history" section of the athlete drawer. Split out of
 * AthleteLineupEditorPanel: every piece of state here (the new-row fields and
 * the inline edit fields) is read by this section and nowhere else, so it owns
 * them. Workspace mutation still goes through the parent's `applyPatch`, which
 * keeps the undo chip and the compose-ref in one place.
 */

import React, { useEffect, useState } from 'react';
import { Check, History, Pencil, Plus, Trash2, X } from 'lucide-react';
import { CutlineNearMissChip, CutlineTag } from '@omniswim/ui';
import { Gender, HistoricalSwim, Workspace } from '@omniswim/core/types';
import { ALL_PLAN_EVENTS } from '@omniswim/core/lib/eventCatalog';
import { buildCutlineTagForTeam } from '@omniswim/core/lib/cutlineTags';
import { compactEventTitleAttr, formatCompactEventLabel } from '@omniswim/core/lib/utils';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import {
  addHistorySwim,
  removeHistorySwim,
  updateHistorySwim,
  type HistorySwimRef,
  type WorkspaceEditorPatch,
} from '@omniswim/core/lib/swimEditor';
import DrawerSection from './DrawerSection';

type TimeType = 'SCY' | 'LCM' | 'SCM';
const TIME_TYPES: TimeType[] = ['SCY', 'LCM', 'SCM'];

type Props = {
  rows: HistoricalSwim[];
  athlete: ScorerRosterRow;
  gender: Gender;
  editable: boolean;
  applyPatch: (build: (ws: Workspace) => WorkspaceEditorPatch) => void;
};

export default function AthleteHistorySection({ rows, athlete, gender, editable, applyPatch }: Props) {
  // Kept under the original name so the moved JSX below is unchanged.
  const athleteHistoryRows = rows;

  const [newHistoryEvent, setNewHistoryEvent] = useState<string>(ALL_PLAN_EVENTS[0]);
  const [newHistoryTime, setNewHistoryTime] = useState('');
  const [newHistoryTimeType, setNewHistoryTimeType] = useState<TimeType>('SCY');
  const [newHistoryMeet, setNewHistoryMeet] = useState('');
  const [newHistoryDate, setNewHistoryDate] = useState('');
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null);
  const [editingHistoryEvent, setEditingHistoryEvent] = useState('');
  const [editingHistoryTime, setEditingHistoryTime] = useState('');
  const [editingHistoryTimeType, setEditingHistoryTimeType] = useState<TimeType>('SCY');

  // A fresh athlete selection must not inherit an open inline editor. This
  // mirrors the reset the parent drawer performs for its own editors on the
  // same key; only the id is cleared, exactly as before the split.
  useEffect(() => {
    setEditingHistoryId(null);
  }, [athlete.key]);

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

  return (
    <DrawerSection
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
    </DrawerSection>
  );
}
