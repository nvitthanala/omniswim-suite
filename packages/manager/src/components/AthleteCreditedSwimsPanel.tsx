/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Waves } from 'lucide-react';
import type { Gender } from '@omniswim/core/types';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import AthleteCreditedSwimsRow from './AthleteCreditedSwimsRow';

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
      <AthleteCreditedSwimsRow
        key={swim.id}
        swim={swim}
        dimmed={dimmed}
        team={team}
        gender={gender}
        editingId={editingId}
        editEvent={editEvent}
        editTime={editTime}
        onEditEventChange={setEditEvent}
        onEditTimeChange={setEditTime}
        editable={editable}
        deletable={deletable}
        showAnchors={showAnchors}
        anchorExpected={anchorExpectedBySwimId?.get(swim.id)}
        onStartEdit={startEdit}
        onCancelEdit={cancelEdit}
        onCommitEdit={commitEdit}
        onDeleteSwim={onDeleteSwim}
      />
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
