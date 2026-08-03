/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Check, Pencil, Trash2, X, Waves } from 'lucide-react';
import type { Gender } from '@omniswim/core/types';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import { formatLegSplitSummary } from '@omniswim/core/lib/relaySplits';
import { compactEventTitleAttr, formatCompactEventLabel } from '@omniswim/core/lib/utils';
import { ALL_PLAN_EVENTS } from '@omniswim/core/lib/eventCatalog';
import { buildCutlineTagForTeam } from '@omniswim/core/lib/cutlineTags';
import { CutlineTag, CutlineNearMissChip } from '@omniswim/ui';

export type EditCreditedSwimValues = { time: string; event: string };

type Props = {
  athleteName: string;
  team: string;
  swims: AthleteCreditedSwim[];
  totalPoints: number;
  /**
   * When supplied, individual credited swims get a compact cutline tag next
   * to the time. Relay legs are left untagged — `swim.time` on a relay row is
   * the leg split/team time, not a standalone swim eligible for an individual
   * standard, and getting that distinction wrong risks a misleading badge.
   * Optional and additive: omit it and the panel renders exactly as before.
   */
  gender?: Gender;
  /** Omit to render without a close affordance (e.g. embedded inline in another panel). */
  onClose?: () => void;
  deletable?: boolean;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
  /** Per-row edit (time and/or event) for individual credited swims. Relay legs are read-only here. */
  onEditSwim?: (swim: AthleteCreditedSwim, changes: EditCreditedSwimValues) => void;
  entryLimitLabel?: string;
  /** Optional prelims/psych placement expected points keyed by swim id. */
  anchorExpectedBySwimId?: Map<string, { prelims?: number; psych?: number }>;
};

export default function AthleteCreditedSwimsPanel({
  athleteName,
  team,
  swims,
  totalPoints,
  gender,
  onClose,
  deletable = false,
  onDeleteSwim,
  onEditSwim,
  entryLimitLabel,
  anchorExpectedBySwimId,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEvent, setEditEvent] = useState('');
  const [editTime, setEditTime] = useState('');

  const credited = swims.filter(s => s.points > 0);
  const other = swims.filter(s => s.points <= 0);
  const showAnchors = Boolean(anchorExpectedBySwimId?.size);
  const editable = deletable && Boolean(onEditSwim);
  const colCount = (deletable ? 7 : 6) + (showAnchors ? 2 : 0);

  const startEdit = (swim: AthleteCreditedSwim) => {
    setEditingId(swim.id);
    setEditEvent(swim.event);
    setEditTime(swim.time);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditEvent('');
    setEditTime('');
  };

  const commitEdit = (swim: AthleteCreditedSwim) => {
    const time = editTime.trim();
    if (!time) {
      cancelEdit();
      return;
    }
    const changes: EditCreditedSwimValues = { time, event: editEvent };
    cancelEdit();
    if (changes.time === swim.time && changes.event === swim.event) return;
    onEditSwim?.(swim, changes);
  };

  const renderRows = (rows: AthleteCreditedSwim[], dimmed = false) =>
    rows.map(swim => (
      <tr
        key={swim.id}
        className={`border-b border-theme-soft/50 text-ui-caption theme-hover-row transition-colors ${dimmed ? 'text-theme-muted' : 'text-[var(--text-primary)]'}`}
      >
        <td className="py-1.5 px-2" title={compactEventTitleAttr(swim.event)}>
          {editingId === swim.id ? (
            <select
              value={editEvent}
              onChange={e => setEditEvent(e.target.value)}
              className="glass-input text-ui-caption font-mono rounded-md px-1.5 py-1 max-w-[10rem]"
              autoFocus
            >
              {editEvent && !(ALL_PLAN_EVENTS as readonly string[]).includes(editEvent) ? (
                <option value={editEvent}>{formatCompactEventLabel(editEvent)}</option>
              ) : null}
              {ALL_PLAN_EVENTS.map(ev => (
                <option key={ev} value={ev}>
                  {formatCompactEventLabel(ev)}
                </option>
              ))}
            </select>
          ) : (
            formatCompactEventLabel(swim.event)
          )}
        </td>
        <td className="py-1.5 px-2 text-theme-secondary">{swim.roundSwam?.trim() || '—'}</td>
        <td className="py-1.5 px-2 font-mono tabular-nums">
          {editingId === swim.id ? (
            <input
              type="text"
              value={editTime}
              onChange={e => setEditTime(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitEdit(swim);
                if (e.key === 'Escape') cancelEdit();
              }}
              placeholder="mm:ss.hh"
              className="glass-input w-20 font-mono tabular-nums text-ui-caption rounded-md px-1.5 py-1"
            />
          ) : (
            <>
              <div className="flex items-center gap-1">
                <span>{swim.displayTime || swim.time || '—'}</span>
                {gender && swim.kind === 'individual' ? (() => {
                  const cutlineResult = buildCutlineTagForTeam({
                    time: swim.time,
                    gender,
                    event: swim.event,
                    team,
                  });
                  return (
                    <span className="hidden sm:inline-flex items-center gap-1 shrink-0">
                      <CutlineTag compact result={cutlineResult} />
                      <CutlineNearMissChip compact nextTier={cutlineResult.nextTier} />
                    </span>
                  );
                })() : null}
              </div>
              {swim.kind === 'relay' && swim.relayLegSplitDetail ? (
                <div
                  className="text-ui-micro text-theme-secondary font-sans mt-0.5 leading-snug"
                  title={formatLegSplitSummary(swim.relayLegSplitDetail)}
                >
                  {formatLegSplitSummary(swim.relayLegSplitDetail)}
                </div>
              ) : null}
            </>
          )}
        </td>
        <td className="py-1.5 px-2 text-right text-theme-secondary tabular-nums">
          {swim.rank > 0 ? swim.rank : '—'}
        </td>
        <td className="py-1.5 px-2 text-center">
          <span
            className={`text-ui-micro uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
              swim.kind === 'relay' ? 'badge-warning' : 'badge-info'
            }`}
          >
            {swim.kind === 'relay' ? 'Relay' : 'Ind'}
          </span>
        </td>
        <td
          className={`py-1.5 px-2 text-right font-mono tabular-nums font-medium ${
            swim.points > 0 ? 'text-[var(--text-accent)]' : 'text-theme-muted'
          }`}
        >
          {swim.points.toFixed(1)}
        </td>
        {showAnchors ? (
          <>
            <td className="py-1.5 px-2 text-right font-mono tabular-nums text-theme-muted text-ui-caption">
              {anchorExpectedBySwimId?.get(swim.id)?.prelims != null
                ? anchorExpectedBySwimId.get(swim.id)!.prelims!.toFixed(1)
                : '—'}
            </td>
            <td className="py-1.5 px-2 text-right font-mono tabular-nums text-theme-muted text-ui-caption">
              {anchorExpectedBySwimId?.get(swim.id)?.psych != null
                ? anchorExpectedBySwimId.get(swim.id)!.psych!.toFixed(1)
                : '—'}
            </td>
          </>
        ) : null}
        {deletable ? (
          <td className="py-1.5 px-1 text-center whitespace-nowrap">
            {editingId === swim.id ? (
              <div className="flex items-center justify-center gap-1">
                <button
                  type="button"
                  onClick={() => commitEdit(swim)}
                  className="p-1 rounded-md text-theme-muted hover:text-points-positive hover:bg-points-positive/10 transition-colors"
                  title="Save edit"
                  aria-label={`Save ${swim.event}`}
                >
                  <Check size={12} />
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="p-1 rounded-md text-theme-muted hover:text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
                  title="Cancel edit"
                  aria-label={`Cancel edit ${swim.event}`}
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-1">
                {editable && !swim.isRecruit && swim.kind === 'individual' ? (
                  <button
                    type="button"
                    onClick={() => startEdit(swim)}
                    className="p-1 rounded-md text-theme-muted hover:text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
                    title="Edit time/event"
                    aria-label={`Edit ${swim.event}`}
                  >
                    <Pencil size={12} />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onDeleteSwim?.(swim)}
                  className="p-1 rounded-md text-theme-muted hover:text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
                  title={swim.isRecruit ? 'Remove recruit entry' : 'Remove this swim from projection'}
                  aria-label={`Remove ${swim.event}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )}
          </td>
        ) : null}
      </tr>
    ));

  return (
    <div className="mt-3 surface-overlay border border-[var(--text-accent)]/25 rounded-lg overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-theme-soft bg-[var(--text-accent)]/5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Waves size={12} className="text-[var(--text-accent)] shrink-0" />
            <h5 className="text-ui-caption font-bold uppercase tracking-widest text-[var(--text-primary)] truncate">
              Credited swims — {athleteName}
            </h5>
          </div>
          <p className="text-ui-micro text-theme-secondary mt-1 truncate" title={team}>
            {team}
            {entryLimitLabel ? (
              <span className="ml-2 text-theme-muted">· {entryLimitLabel}</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-ui-caption font-mono text-[var(--text-accent)] font-bold tabular-nums">
            {totalPoints.toFixed(1)} pts
          </span>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="text-theme-muted hover:text-[var(--text-primary)] transition-colors"
              aria-label="Close swim breakdown"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {swims.length === 0 ? (
        <p className="p-4 text-ui-caption text-theme-muted italic text-center">No swims found for this athlete.</p>
      ) : (
        <>
          {deletable ? (
            <p className="px-3 py-1.5 text-ui-micro text-theme-secondary border-b border-theme-soft">
              What-if mode — {editable ? 'use the pencil to edit time/event, or ' : ''}use the trash
              icon to remove a swim from the projection.
            </p>
          ) : null}
          <div className="max-h-48 overflow-y-auto custom-scrollbar">
          <table className="w-full">
            <thead className="sticky top-0 surface-overlay text-ui-micro uppercase text-theme-secondary border-b border-theme-soft">
              <tr>
                <th className="text-left py-1.5 px-2 font-medium">Event</th>
                <th className="text-left py-1.5 px-2 font-medium">Round</th>
                <th className="text-left py-1.5 px-2 font-medium">Time</th>
                <th className="text-right py-1.5 px-2 font-medium w-10">Pl</th>
                <th className="text-center py-1.5 px-2 font-medium w-14">Type</th>
                <th className="text-right py-1.5 px-2 font-medium w-14">Pts</th>
                {showAnchors ? (
                  <>
                    <th className="text-right py-1.5 px-2 font-medium w-10">Pre</th>
                    <th className="text-right py-1.5 px-2 font-medium w-10">Psych</th>
                  </>
                ) : null}
                {deletable ? <th className="w-8" aria-label="Remove" /> : null}
              </tr>
            </thead>
            <tbody>
              {renderRows(credited)}
              {other.length > 0 ? (
                <>
                  <tr>
                    <td
                      colSpan={colCount}
                      className="py-1.5 px-2 text-ui-micro uppercase tracking-widest text-theme-muted bg-[var(--surface-muted)]/50"
                    >
                      Non-scoring swims ({other.length})
                    </td>
                  </tr>
                  {renderRows(other, true)}
                </>
              ) : null}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
