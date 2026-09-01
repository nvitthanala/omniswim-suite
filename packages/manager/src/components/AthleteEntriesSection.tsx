/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Individual entries" section of the athlete drawer. Split out of
 * AthleteLineupEditorPanel: the new-entry fields, the inline time editor and
 * the paste preview are read here and nowhere else, so this owns them along
 * with their handlers.
 *
 * Mutation stays the parent's job. `applyPatch` / `applyRawPatch` are passed
 * in so the undo chip and the compose-ref live in one place, and `getWorkspace`
 * exposes the parent's compose-ref for read-after-write within a single
 * interaction WITHOUT handing a mutable ref to a leaf component. Entry-limit
 * `counts` stay in the parent too, because Credited swims reads them.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardPaste, Plus, Trash2, Waves } from 'lucide-react';
import {
  Gender,
  PlannedSwimEntry,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '@omniswim/core/types';
import { ALL_PLAN_EVENTS } from '@omniswim/core/lib/eventCatalog';
import { buildCutlineTagForTeam } from '@omniswim/core/lib/cutlineTags';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import {
  canonicalSwimmerName,
  compactEventTitleAttr,
  formatCompactEventLabel,
} from '@omniswim/core/lib/utils';
import {
  canAcceptAnotherEntry,
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '@omniswim/core/lib/swimmerEntryLimits';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import { buildAliasResolver } from '@omniswim/core/lib/athleteAliases';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import {
  addPlannedEntry,
  removePlannedEntry,
  updatePlannedEntry,
  type WorkspaceEditorPatch,
} from '@omniswim/core/lib/swimEditor';
import { CutlineNearMissChip, CutlineTag, useToast } from '@omniswim/ui';
import DrawerSection from './DrawerSection';
import { buildPastePreviewPatch, selectPastePreviewRows } from './athleteEntriesView';

type Props = {
  workspace: Workspace;
  settings: ScoringSettings;
  athlete: ScorerRosterRow;
  gender: Gender;
  allResults: SwimmerResult[];
  editable: boolean;
  counts: ReturnType<typeof countSwimmerEntries>;
  athletePlans: PlannedSwimEntry[];
  /** Latest composed workspace, for handlers that chain off an earlier patch. */
  getWorkspace: () => Workspace;
  applyPatch: (build: (ws: Workspace) => WorkspaceEditorPatch) => void;
  applyRawPatch: (patch: Partial<Workspace>) => void;
};

export default function AthleteEntriesSection({
  workspace,
  settings,
  athlete,
  gender,
  allResults,
  editable,
  counts,
  athletePlans,
  getWorkspace,
  applyPatch,
  applyRawPatch,
}: Props) {
  const toast = useToast();

  // A fresh athlete selection must not inherit an open inline time editor or a
  // half-finished paste preview. This is the reset the parent drawer performed
  // for these fields before the split, moved here with the state it clears.
  useEffect(() => {
    setEditingTimeId(null);
    setParsePreview([]);
    setPasteOpen(false);
    setPasteText('');
  }, [athlete.key]);

  // Same derivations the parent makes; recomputed here rather than threaded
  // through props, since they are pure functions of values already passed in.
  const athleteCanonical = canonicalSwimmerName(athlete.name);
  const athleteTeamTrim = String(athlete.team ?? '').trim();
  const over = swimmerExceedsEntryLimits(counts, settings);
  const aliasResolver = useMemo(() => buildAliasResolver(workspace), [workspace]);

  const [newEvent, setNewEvent] = useState<string>(ALL_PLAN_EVENTS[0]);
  const [newTime, setNewTime] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [editingTimeId, setEditingTimeId] = useState<string | null>(null);
  const [editingTimeValue, setEditingTimeValue] = useState('');
  const [pastePreview, setParsePreview] = useState<Array<{ event: string; time: string; selected: boolean }>>([]);

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
        athlete.name,
        aliasResolver
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
    const preview = selectPastePreviewRows({
      swims: parsed.swims,
      existingEvents: new Set(athletePlans.map(p => p.event)),
      counts,
      settings,
    });
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
    const patch = buildPastePreviewPatch({
      ws: getWorkspace(),
      athletePlans,
      selectedSwims: swims,
      athlete,
      gender,
      athleteCanonical,
      athleteTeamTrim,
    });
    applyRawPatch(patch);
    toast.push('success', `Added ${selected.length} lineup entr${selected.length === 1 ? 'y' : 'ies'} from paste`);
    setPasteText('');
    setParsePreview([]);
    setPasteOpen(false);
  };

  const canAddSelected = canAcceptAnotherEntry(counts, settings, newEvent);

  return (
    <DrawerSection title="Individual entries" icon={<Waves size={14} />} defaultOpen>
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
    </DrawerSection>
  );
}
