/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One row of AthleteCreditedSwimsPanel's swim table, split into named cells
 * so the edit-vs-display branching for each column lives in its own small
 * function instead of one long row-rendering closure.
 */

import React from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import type { Gender } from '@omniswim/core/types';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import { formatLegSplitSummary } from '@omniswim/core/lib/relaySplits';
import { compactEventTitleAttr, formatCompactEventLabel } from '@omniswim/core/lib/utils';
import { ALL_PLAN_EVENTS } from '@omniswim/core/lib/eventCatalog';
import { buildCutlineTagForTeam } from '@omniswim/core/lib/cutlineTags';
import { CutlineTag, CutlineNearMissChip } from '@omniswim/ui';
import type { EditCreditedSwimValues } from './AthleteCreditedSwimsPanel';

type AnchorExpected = { prelims?: number; psych?: number };

type RowProps = {
  swim: AthleteCreditedSwim;
  dimmed: boolean;
  team: string;
  gender?: Gender;
  editingId: string | null;
  editEvent: string;
  editTime: string;
  onEditEventChange: (event: string) => void;
  onEditTimeChange: (time: string) => void;
  editable: boolean;
  deletable: boolean;
  showAnchors: boolean;
  anchorExpected?: AnchorExpected;
  onStartEdit: (swim: AthleteCreditedSwim) => void;
  onCancelEdit: () => void;
  onCommitEdit: (swim: AthleteCreditedSwim) => void;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
};

function EventCell({
  swim,
  isEditing,
  editEvent,
  onEditEventChange,
}: {
  swim: AthleteCreditedSwim;
  isEditing: boolean;
  editEvent: string;
  onEditEventChange: (event: string) => void;
}) {
  if (!isEditing) return <>{formatCompactEventLabel(swim.event)}</>;
  const editEventIsCustom = editEvent && !(ALL_PLAN_EVENTS as readonly string[]).includes(editEvent);
  return (
    <select
      value={editEvent}
      onChange={e => onEditEventChange(e.target.value)}
      className="glass-input text-ui-caption font-mono rounded-md px-1.5 py-1 max-w-[10rem]"
      autoFocus
    >
      {editEventIsCustom ? <option value={editEvent}>{formatCompactEventLabel(editEvent)}</option> : null}
      {ALL_PLAN_EVENTS.map(ev => (
        <option key={ev} value={ev}>
          {formatCompactEventLabel(ev)}
        </option>
      ))}
    </select>
  );
}

function TimeDisplay({ swim, team, gender }: { swim: AthleteCreditedSwim; team: string; gender?: Gender }) {
  const showCutline = Boolean(gender) && swim.kind === 'individual';
  return (
    <>
      <div className="flex items-center gap-1">
        <span>{swim.displayTime || swim.time || '—'}</span>
        {showCutline ? <SwimCutlineTag swim={swim} team={team} gender={gender as Gender} /> : null}
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
  );
}

function SwimCutlineTag({ swim, team, gender }: { swim: AthleteCreditedSwim; team: string; gender: Gender }) {
  const cutlineResult = buildCutlineTagForTeam({ time: swim.time, gender, event: swim.event, team });
  return (
    <span className="hidden sm:inline-flex items-center gap-1 shrink-0">
      <CutlineTag compact result={cutlineResult} />
      <CutlineNearMissChip compact nextTier={cutlineResult.nextTier} />
    </span>
  );
}

function TimeCell({
  swim,
  team,
  gender,
  isEditing,
  editTime,
  onEditTimeChange,
  onCommitEdit,
  onCancelEdit,
}: {
  swim: AthleteCreditedSwim;
  team: string;
  gender?: Gender;
  isEditing: boolean;
  editTime: string;
  onEditTimeChange: (time: string) => void;
  onCommitEdit: (swim: AthleteCreditedSwim) => void;
  onCancelEdit: () => void;
}) {
  if (!isEditing) return <TimeDisplay swim={swim} team={team} gender={gender} />;
  return (
    <input
      type="text"
      value={editTime}
      onChange={e => onEditTimeChange(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') onCommitEdit(swim);
        if (e.key === 'Escape') onCancelEdit();
      }}
      placeholder="mm:ss.hh"
      className="glass-input w-20 font-mono tabular-nums text-ui-caption rounded-md px-1.5 py-1"
    />
  );
}

function AnchorCells({ anchorExpected }: { anchorExpected?: AnchorExpected }) {
  return (
    <>
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-theme-muted text-ui-caption">
        {anchorExpected?.prelims != null ? anchorExpected.prelims.toFixed(1) : '—'}
      </td>
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-theme-muted text-ui-caption">
        {anchorExpected?.psych != null ? anchorExpected.psych.toFixed(1) : '—'}
      </td>
    </>
  );
}

function EditingActions({
  swim,
  onCommitEdit,
  onCancelEdit,
}: {
  swim: AthleteCreditedSwim;
  onCommitEdit: (swim: AthleteCreditedSwim) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      <button
        type="button"
        onClick={() => onCommitEdit(swim)}
        className="p-1 rounded-md text-theme-muted hover:text-points-positive hover:bg-points-positive/10 transition-colors"
        title="Save edit"
        aria-label={`Save ${swim.event}`}
      >
        <Check size={12} />
      </button>
      <button
        type="button"
        onClick={onCancelEdit}
        className="p-1 rounded-md text-theme-muted hover:text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
        title="Cancel edit"
        aria-label={`Cancel edit ${swim.event}`}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function IdleActions({
  swim,
  editable,
  onStartEdit,
  onDeleteSwim,
}: {
  swim: AthleteCreditedSwim;
  editable: boolean;
  onStartEdit: (swim: AthleteCreditedSwim) => void;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
}) {
  const showEdit = editable && !swim.isRecruit && swim.kind === 'individual';
  return (
    <div className="flex items-center justify-center gap-1">
      {showEdit ? (
        <button
          type="button"
          onClick={() => onStartEdit(swim)}
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
  );
}

function ActionsCell({
  swim,
  isEditing,
  editable,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onDeleteSwim,
}: {
  swim: AthleteCreditedSwim;
  isEditing: boolean;
  editable: boolean;
  onStartEdit: (swim: AthleteCreditedSwim) => void;
  onCancelEdit: () => void;
  onCommitEdit: (swim: AthleteCreditedSwim) => void;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
}) {
  if (isEditing) return <EditingActions swim={swim} onCommitEdit={onCommitEdit} onCancelEdit={onCancelEdit} />;
  return <IdleActions swim={swim} editable={editable} onStartEdit={onStartEdit} onDeleteSwim={onDeleteSwim} />;
}

export default function AthleteCreditedSwimsRow({
  swim,
  dimmed,
  team,
  gender,
  editingId,
  editEvent,
  editTime,
  onEditEventChange,
  onEditTimeChange,
  editable,
  deletable,
  showAnchors,
  anchorExpected,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onDeleteSwim,
}: RowProps) {
  const isEditing = editingId === swim.id;
  return (
    <tr
      className={`border-b border-theme-soft/50 text-ui-caption theme-hover-row transition-colors ${dimmed ? 'text-theme-muted' : 'text-[var(--text-primary)]'}`}
    >
      <td className="py-1.5 px-2" title={compactEventTitleAttr(swim.event)}>
        <EventCell swim={swim} isEditing={isEditing} editEvent={editEvent} onEditEventChange={onEditEventChange} />
      </td>
      <td className="py-1.5 px-2 text-theme-secondary">{swim.roundSwam?.trim() || '—'}</td>
      <td className="py-1.5 px-2 font-mono tabular-nums">
        <TimeCell
          swim={swim}
          team={team}
          gender={gender}
          isEditing={isEditing}
          editTime={editTime}
          onEditTimeChange={onEditTimeChange}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
        />
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
      {showAnchors ? <AnchorCells anchorExpected={anchorExpected} /> : null}
      {deletable ? (
        <td className="py-1.5 px-1 text-center whitespace-nowrap">
          <ActionsCell
            swim={swim}
            isEditing={isEditing}
            editable={editable}
            onStartEdit={onStartEdit}
            onCancelEdit={onCancelEdit}
            onCommitEdit={onCommitEdit}
            onDeleteSwim={onDeleteSwim}
          />
        </td>
      ) : null}
    </tr>
  );
}
