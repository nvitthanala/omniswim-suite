/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Drop flags" and "Open-slot adds" — the drop-only and add-only ranking
 * sections of CrossCourseArbitragePanel. Split out of the former
 * crossCourseArbitrageSections.tsx (see git history); these two are paired
 * here because they share one shape (a ranked row list with an Apply button,
 * a not-meaningful/empty/populated switch) even though they read from
 * different rankings. Pure extraction, no behavior change.
 */

import React from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@omniswim/ui';
import {
  AthleteButton,
  DROP_SOURCE_LABEL,
  Section,
  ShowAllToggle,
  StalePill,
  UndoLastSwapButton,
  VerifyPill,
  type LastApplied,
} from './crossCourseArbitrageParts';
import { formatPoints } from './crossCourseArbitrageView';
import type {
  AddOnlyRanking,
  AddOnlyRow,
  DropOnlyRanking,
  DropOnlyRow,
} from '@omniswim/core/lib/crossCourseArbitrage';

/** One over-entry/cap-blocked drop row inside DropFlagsSection's list. */
function DropRow({
  drop,
  canApplySwaps,
  onApplyDrop,
  onJumpAthlete,
}: {
  drop: DropOnlyRow;
  canApplySwaps: boolean;
  onApplyDrop: (drop: DropOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <li
      key={`${drop.dropSource}|${drop.dropEntryId}`}
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
    >
      <div className="flex items-center justify-between gap-2">
        <AthleteButton
          name={drop.athlete}
          onJumpAthlete={onJumpAthlete}
          className="text-ui-caption max-w-[8rem]"
        />
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
            {formatPoints(drop.deltaPoints)}
          </span>
          {canApplySwaps ? (
            <Button variant="outline" size="sm" onClick={() => onApplyDrop(drop)} className="px-2 py-1">
              Apply
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
        −{drop.dropEvent}
        {drop.dropTime ? ` (${drop.dropTime})` : ''} · {DROP_SOURCE_LABEL[drop.dropSource]} entry
      </p>
      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
        {drop.capRelief
          ? `over entry cap — dropping restores ${(drop.voidedPointsRestored ?? 0).toFixed(1)} voided pts`
          : 'frees a team scoring slot for higher-value entries'}
      </p>
    </li>
  );
}

export function DropFlagsSection({
  dropRanking,
  drops,
  shownDrops,
  dropsExpanded,
  dropsLimit,
  onToggleExpanded,
  lastApplied,
  onUndo,
  canApplySwaps,
  onApplyDrop,
  onJumpAthlete,
}: {
  dropRanking: DropOnlyRanking | undefined;
  drops: DropOnlyRow[];
  shownDrops: DropOnlyRow[];
  dropsExpanded: boolean;
  dropsLimit: number;
  onToggleExpanded: () => void;
  lastApplied: LastApplied;
  onUndo: () => void;
  canApplySwaps: boolean;
  onApplyDrop: (drop: DropOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Drop flags"
      icon={<AlertTriangle size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={dropRanking?.pointsMeaningful ? `(${drops.length})` : undefined}
    >
      <UndoLastSwapButton lastApplied={lastApplied} onUndo={onUndo} />
      {!dropRanking || !dropRanking.pointsMeaningful ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {dropRanking?.reason ?? 'Drop deltas are not available for this team.'}
        </p>
      ) : drops.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No entry would score more by being dropped — no over-entered swimmers or cap-blocked
          points detected for this team.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shownDrops.map(drop => (
              <DropRow
                key={`${drop.dropSource}|${drop.dropEntryId}`}
                drop={drop}
                canApplySwaps={canApplySwaps}
                onApplyDrop={onApplyDrop}
                onJumpAthlete={onJumpAthlete}
              />
            ))}
          </ul>
          <ShowAllToggle
            shown={dropsLimit}
            total={drops.length}
            expanded={dropsExpanded}
            onToggle={onToggleExpanded}
          />
          <p className="text-ui-micro text-theme-muted mt-2.5">
            {dropRanking.candidatesEvaluated} droppable entr
            {dropRanking.candidatesEvaluated === 1 ? 'y' : 'ies'} evaluated.
          </p>
        </>
      )}
    </Section>
  );
}

/** One open-slot add row inside OpenSlotAddsSection's list. */
function AddRow({
  add,
  canApplySwaps,
  onApplyAdd,
  onJumpAthlete,
}: {
  add: AddOnlyRow;
  canApplySwaps: boolean;
  onApplyAdd: (add: AddOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <li
      key={`${add.athlete}|${add.addEvent}`}
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
    >
      <div className="flex items-center justify-between gap-2">
        <AthleteButton
          name={add.athlete}
          onJumpAthlete={onJumpAthlete}
          className="text-ui-caption max-w-[8rem]"
        />
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
            {formatPoints(add.deltaPoints)}
          </span>
          {canApplySwaps ? (
            <Button variant="outline" size="sm" onClick={() => onApplyAdd(add)} className="px-2 py-1">
              Apply
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
        +{add.addEvent} ({add.addTime}
        {add.addTimeConverted ? 'c' : ''})
        {add.addTimeStale ? (
          <>
            {' '}
            <StalePill />
          </>
        ) : null}
        {add.confidence === 'verify' ? (
          <>
            {' '}
            <VerifyPill />
          </>
        ) : null}
      </p>
      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
        adds without dropping anything — swimmer has entry room under the caps
      </p>
    </li>
  );
}

export function OpenSlotAddsSection({
  addRanking,
  adds,
  shownAdds,
  addsExpanded,
  addsLimit,
  onToggleExpanded,
  lastApplied,
  onUndo,
  canApplySwaps,
  onApplyAdd,
  onJumpAthlete,
}: {
  addRanking: AddOnlyRanking | undefined;
  adds: AddOnlyRow[];
  shownAdds: AddOnlyRow[];
  addsExpanded: boolean;
  addsLimit: number;
  onToggleExpanded: () => void;
  lastApplied: LastApplied;
  onUndo: () => void;
  canApplySwaps: boolean;
  onApplyAdd: (add: AddOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Open-slot adds"
      icon={<Plus size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={addRanking?.pointsMeaningful ? `(${adds.length})` : undefined}
    >
      <UndoLastSwapButton lastApplied={lastApplied} onUndo={onUndo} />
      {!addRanking || !addRanking.pointsMeaningful ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {addRanking?.reason ?? 'Add deltas are not available for this team.'}
        </p>
      ) : adds.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No open-slot addition scores points — every swimmer with entry room is already placed
          where they can score.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shownAdds.map(add => (
              <AddRow
                key={`${add.athlete}|${add.addEvent}`}
                add={add}
                canApplySwaps={canApplySwaps}
                onApplyAdd={onApplyAdd}
                onJumpAthlete={onJumpAthlete}
              />
            ))}
          </ul>
          <ShowAllToggle
            shown={addsLimit}
            total={adds.length}
            expanded={addsExpanded}
            onToggle={onToggleExpanded}
          />
          <p className="text-ui-micro text-theme-muted mt-2.5">
            {addRanking.candidatesEvaluated} open-slot add
            {addRanking.candidatesEvaluated === 1 ? '' : 's'} evaluated.
          </p>
        </>
      )}
    </Section>
  );
}
