/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One row of TeamCard's expanded "Team Matrix" list, split into the three
 * pieces it was already built from: the time column (with its click-to-edit
 * input), the points column, and the row that composes them.
 *
 * Pure extraction from `TeamCard.tsx` — no behavior change. The edit state
 * still lives in `TeamCard`; this file only receives it and reports back.
 */

import type { Gender, SwimmerResult } from '@omniswim/core/types';
import type { PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import { entryKey, prelimsOuOverUnderForDisplay } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import { psychExpectedForResult } from '@omniswim/core/lib/psychProjection';
import { displayTimeForRelayLeg, formatLegSplitSummary } from '@omniswim/core/lib/relaySplits';
import { AthleteName, CompactEventLabel, PlacementExpectedValue, PointsValue, PrelimsOuValue } from './matrixPresentation';
import { CutlineVerdict } from './TeamCardParts';
import { buildTeamRowCutlineTags, relayMissingStrokeLabel, type TeamRowCutlineTags } from './teamCardView';

interface TeamMatrixSwimmerRowProps {
  res: SwimmerResult;
  gender: Gender | string;
  teamName: string;
  viewMode: 'swimmer' | 'event';
  onUpdateTime?: (id: string, newTime: string) => void;
  editingResultId: string | null;
  editValue: string;
  onStartEdit: (id: string, time: string) => void;
  onEditValueChange: (value: string) => void;
  onCancelEdit: () => void;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
}

interface InlineTimeEditFormProps {
  res: SwimmerResult;
  editValue: string;
  onUpdateTime?: (id: string, newTime: string) => void;
  onEditValueChange: (value: string) => void;
  onCancelEdit: () => void;
}

/** The single time-edit input that replaces a matrix row's time once it's clicked into edit mode. */
export function InlineTimeEditForm({ res, editValue, onUpdateTime, onEditValueChange, onCancelEdit }: InlineTimeEditFormProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (onUpdateTime && res.id) onUpdateTime(res.id, editValue);
        onCancelEdit();
      }}
      className="flex w-full mt-1 border border-theme-soft rounded overflow-hidden"
    >
      <input
        type="text"
        autoFocus
        aria-label={`Edit time for ${res.name}`}
        value={editValue}
        onChange={e => onEditValueChange(e.target.value)}
        className="surface-muted-bg text-ui-micro px-1 py-0.5 outline-none font-mono flex-1 text-[var(--text-primary)]"
        onBlur={onCancelEdit}
      />
    </form>
  );
}

interface TeamMatrixTimeCellProps {
  res: SwimmerResult;
  rowTags: TeamRowCutlineTags;
  timeColorClass: string;
  relaySplitPrimary: any;
  onStartEdit: () => void;
  editingResultId: string | null;
  editValue: string;
  onUpdateTime?: (id: string, newTime: string) => void;
  onEditValueChange: (value: string) => void;
  onCancelEdit: () => void;
}

/** A matrix row's time column: prelim time, the primary (split/final/plain) time with its
 * cutline color and click-to-edit, any relay verdict that isn't already anchored to a split,
 * and the inline edit form when this row is being edited. */
export function TeamMatrixTimeCell({
  res,
  rowTags,
  timeColorClass,
  relaySplitPrimary,
  onStartEdit,
  editingResultId,
  editValue,
  onUpdateTime,
  onEditValueChange,
  onCancelEdit,
}: TeamMatrixTimeCellProps) {
  const timeClassName = `font-mono font-medium cursor-pointer hover:underline ${timeColorClass}`;

  return (
    <div className="flex flex-col items-end gap-0.5 justify-center w-1/3 text-right">
      {res.prelimsTime && (
        <div className="text-ui-micro text-theme-secondary font-mono">
          Prelim: {res.prelimsTime}
        </div>
      )}
      {relaySplitPrimary && (
        <div className={timeClassName} onClick={onStartEdit}>
          <span className="inline-flex items-center gap-1 flex-wrap">
            <span>Split: {displayTimeForRelayLeg(res)}</span>
            {/* The leg's own individual verdict — only present when this leg is eligible. */}
            {rowTags.kind === 'relay' && rowTags.tags.legQualification ? (
              <span className="inline-flex items-center gap-1 no-underline">
                <CutlineVerdict result={rowTags.tags.legQualification} />
              </span>
            ) : null}
          </span>
          {res.relayLegSplitDetail ? (
            <span className="block text-ui-micro text-theme-muted font-sans">
              {formatLegSplitSummary(res.relayLegSplitDetail)}
            </span>
          ) : null}
          <span className="block text-ui-micro text-theme-secondary font-normal">
            <span className="inline-flex items-center gap-1 flex-wrap">
              <span>Relay {res.relayTeamTime || res.finalsTime || res.time}</span>
              {/* The relay's own verdict — anchored to the relay team time it
                  actually describes, not the swimmer's split above. */}
              {rowTags.kind === 'relay' ? (
                <span className="inline-flex items-center gap-1 no-underline">
                  <CutlineVerdict result={rowTags.tags.relay} />
                </span>
              ) : null}
            </span>
          </span>
        </div>
      )}
      {res.finalsTime && !relaySplitPrimary && (
        <div className={timeClassName} onClick={onStartEdit}>
          Final: {res.finalsTime}
        </div>
      )}
      {!res.finalsTime && !res.prelimsTime && !relaySplitPrimary && (
        <div className={timeClassName} onClick={onStartEdit}>
          {res.time}
        </div>
      )}
      {/* A relay row without a recorded split still needs its team-time
          verdict shown somewhere — the two branches above cover the split
          case inline, this covers the finalsTime/plain-time fallbacks. */}
      {!relaySplitPrimary && rowTags.kind === 'relay' ? (
        <div className="flex items-center justify-end gap-1 flex-wrap">
          <CutlineVerdict result={rowTags.tags.relay} />
        </div>
      ) : null}
      {editingResultId === res.id && (
        <InlineTimeEditForm
          res={res}
          editValue={editValue}
          onUpdateTime={onUpdateTime}
          onEditValueChange={onEditValueChange}
          onCancelEdit={onCancelEdit}
        />
      )}
    </div>
  );
}

interface TeamMatrixPointsCellProps {
  res: SwimmerResult;
  rowTags: TeamRowCutlineTags;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
}

/** A matrix row's trailing column: the non-relay cutline verdict slot, points, and the
 * prelims/psych over-under boxes. */
export function TeamMatrixPointsCell({
  res,
  rowTags,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
}: TeamMatrixPointsCellProps) {
  return (
    <div className="flex items-center justify-end gap-2 w-1/3 flex-wrap">
      {/* Relay verdicts are already anchored next to the relay team
          time / leg split above; only a non-relay row's single verdict
          belongs in this generic slot. */}
      {rowTags.kind === 'single' ? <CutlineVerdict result={rowTags.result} /> : null}
      <div className="flex flex-col items-end gap-0.5">
        <PointsValue
          signed={false}
          value={typeof res.points === 'number' ? res.points : res.points}
        />
        {showPrelimsPerformance && prelimsOuByEntry ? (
          <PlacementExpectedValue
            label="Prelims"
            value={prelimsOuByEntry.get(entryKey(res))?.expected}
          />
        ) : null}
        {showPsychPerformance && psychOuByEntry ? (
          <PlacementExpectedValue
            label="Psych"
            value={psychExpectedForResult(res, psychOuByEntry)}
          />
        ) : null}
        {showPrelimsPerformance && prelimsOuByEntry ? (
          <PrelimsOuValue
            value={prelimsOuOverUnderForDisplay(res, prelimsOuByEntry)}
            compact
          />
        ) : null}
      </div>
    </div>
  );
}

/** One swimmer row inside the expanded team's swimmer/event matrix list. */
export function TeamMatrixSwimmerRow({
  res,
  gender,
  teamName,
  viewMode,
  onUpdateTime,
  editingResultId,
  editValue,
  onStartEdit,
  onEditValueChange,
  onCancelEdit,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
}: TeamMatrixSwimmerRowProps) {
  const rowTags = buildTeamRowCutlineTags(res, gender, teamName, res.time);
  // Coloring keys off each row's own verdict: the relay's
  // for a relay leg (never the leg's, which was the bug —
  // a leadoff's individual split used to silently stand
  // in for the relay's own result), the single verdict
  // otherwise.
  const primaryTagResult = rowTags.kind === 'relay' ? rowTags.tags.relay : rowTags.result;
  const cutlineTier = primaryTagResult.state === 'tagged' ? primaryTagResult.tag.tier : null;
  const isACut = cutlineTier === 'A' || cutlineTier === 'Standard' || cutlineTier === 'Qualifying';
  const isBCut = cutlineTier === 'B' || cutlineTier === 'Provisional' || cutlineTier === 'Invited';
  const timeColorClass = isACut ? 'text-[var(--text-accent)]' : isBCut ? 'text-amber-400' : 'text-theme-secondary';
  const relaySplitPrimary = res.isRelay && (res.relayLegSplitDetail || res.relayLegSplit);
  const startEdit = () => {
    if (onUpdateTime && res.id) onStartEdit(res.id, res.time);
  };

  return (
    <div className="flex items-center justify-between text-ui-caption py-1.5 border-t border-theme-soft">
      <div className="flex items-center gap-2 text-theme-secondary font-mono w-1/3">
        <span className="w-4 font-medium text-theme-secondary">{res.rank || '-'}</span>
        <span className="truncate max-w-[150px]">
          {viewMode === 'swimmer' ? (
            <CompactEventLabel event={res.event} className="text-theme-secondary font-mono truncate max-w-[150px] inline-block" />
          ) : (
            <AthleteName name={res.name} className="text-theme-secondary font-mono" />
          )}
        </span>
        {res.relayMissingLeg && (
          <span className="text-ui-micro text-amber-400 shrink-0" title="Missing relay leg">
            Missing L{(res.relayMissingLeg.legIndex ?? 0) + 1}{' '}
            {relayMissingStrokeLabel(res.relayMissingLeg.stroke)}
          </span>
        )}
        {res.roundSwam && <span className="text-ui-micro surface-overlay px-1 rounded truncate max-w-[60px]">{res.roundSwam}</span>}
      </div>
      <TeamMatrixTimeCell
        res={res}
        rowTags={rowTags}
        timeColorClass={timeColorClass}
        relaySplitPrimary={relaySplitPrimary}
        onStartEdit={startEdit}
        editingResultId={editingResultId}
        editValue={editValue}
        onUpdateTime={onUpdateTime}
        onEditValueChange={onEditValueChange}
        onCancelEdit={onCancelEdit}
      />
      <TeamMatrixPointsCell
        res={res}
        rowTags={rowTags}
        showPrelimsPerformance={showPrelimsPerformance}
        prelimsOuByEntry={prelimsOuByEntry}
        showPsychPerformance={showPsychPerformance}
        psychOuByEntry={psychOuByEntry}
      />
    </div>
  );
}
