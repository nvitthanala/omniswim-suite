/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `ScoringSettingsFields`'s two optional points-table sections (relay scoring,
 * diving points) and the per-team/per-event scoring-caps section. Pure
 * extraction from `ScoringSettingsFields.tsx` — no behavior change. Each
 * optional-table reader/writer (`relayTable` / `divingTable`) is built by the
 * parent's `optionalPointsField` and passed through unchanged.
 */

import { NumberField, SegmentedControl } from '@omniswim/ui';
import type { ScoringSettings } from '@omniswim/core/types';

export interface OptionalPointsField {
  points: number[];
  enabled: boolean;
  enable: () => void;
  disable: () => void;
  setCount: (count: number) => void;
  setPoint: (index: number, value: number) => void;
}

/**
 * One "Place N" points input.
 *
 * `NumberField` publishes only a complete, finite, non-negative value, and
 * reverts a blank or malformed draft on blur. The inputs used to read
 * `parseFloat(text) || 0`, so a cleared cell silently saved as 0 points and a
 * real 0 rendered as an empty box. A place value is a published competition
 * number: a blank is "not yet entered", never "worth nothing".
 */
export function PlacePointInput({ value, ariaLabel, onValueChange }: { value: number; ariaLabel: string; onValueChange: (v: number) => void }) {
  return (
    <NumberField
      aria-label={ariaLabel}
      min={0}
      step={0.01}
      value={value}
      onValueChange={onValueChange}
      className="glass-input w-full font-mono text-xs"
    />
  );
}

/** One "Place N" points input grid, shared by the relay and diving tables. */
function PlacePointsGrid({ points, ariaPrefix, onSetPoint }: { points: number[]; ariaPrefix: string; onSetPoint: (i: number, v: number) => void }) {
  return (
    <div className="grid grid-cols-4 md:grid-cols-6 gap-3">
      {points.map((pt, i) => (
        <div key={i} className="flex flex-col gap-1">
          <span className="text-[9px] text-theme-secondary font-mono">Place {i + 1}</span>
          <PlacePointInput value={pt} ariaLabel={`${ariaPrefix} points for place ${i + 1}`} onValueChange={v => onSetPoint(i, v)} />
        </div>
      ))}
    </div>
  );
}

interface RelayScoringFieldsProps {
  relayTable: OptionalPointsField;
}

export function RelayScoringFields({ relayTable }: RelayScoringFieldsProps) {
  return (
    <div className="p-3 rounded-lg border border-theme-soft surface-overlay">
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="text-ui-caption text-theme-secondary font-medium">Relay scoring</label>
        <SegmentedControl
          layout="inline"
          ariaLabel="Relay scoring mode"
          value={relayTable.enabled ? 'table' : 'multiplier'}
          onChange={v => (v === 'table' ? relayTable.enable() : relayTable.disable())}
          options={[
            { value: 'multiplier', label: 'Multiplier', ariaLabel: 'Score relays from the relay multiplier' },
            { value: 'table', label: 'Explicit table', ariaLabel: 'Score relays from an explicit relay place table' },
          ]}
        />
      </div>
      {relayTable.enabled ? (
        <>
          <p className="text-[9px] text-theme-muted mb-2 normal-case tracking-normal">
            This rule set carries its own relay place table — relays score from these values directly, and the relay
            multiplier above is ignored (shown disabled). Right for a dual meet: NCAA Rule 7-1-1 scores relays
            11-4-2, not individual 9-4-3-2-1 doubled.
          </p>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[9px] text-theme-secondary font-mono">Relay places</span>
            <input
              type="number"
              min={1}
              max={24}
              aria-label="Number of relay scoring places"
              value={relayTable.points.length}
              onChange={e => relayTable.setCount(parseInt(e.target.value, 10) || 1)}
              className="glass-input w-20 font-mono text-xs"
            />
          </div>
          <PlacePointsGrid points={relayTable.points} ariaPrefix="Relay" onSetPoint={relayTable.setPoint} />
        </>
      ) : (
        <p className="text-[9px] text-theme-muted normal-case tracking-normal">
          Relays score as {`scoringPoints[place] × relayMultiplier`} (correct for championship formats, where the
          relay table is exactly double the individual one). Switch to an explicit table for a dual meet or any
          format whose relay values are not simply doubled.
        </p>
      )}
    </div>
  );
}

interface DivingPointsFieldsProps {
  divingTable: OptionalPointsField;
  divingMaxScorersPerTeamPerEvent: ScoringSettings['divingMaxScorersPerTeamPerEvent'];
  onChangeMaxScorers: (value: number | undefined) => void;
}

export function DivingPointsFields({ divingTable, divingMaxScorersPerTeamPerEvent, onChangeMaxScorers }: DivingPointsFieldsProps) {
  return (
    <div className="p-3 rounded-lg border border-theme-soft surface-overlay">
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="text-ui-caption text-theme-secondary font-medium">Diving points table</label>
        <SegmentedControl
          layout="inline"
          ariaLabel="Diving points table"
          value={divingTable.enabled ? 'table' : 'none'}
          onChange={v => (v === 'table' ? divingTable.enable() : divingTable.disable())}
          options={[
            { value: 'none', label: 'None', ariaLabel: 'No separate diving points table' },
            { value: 'table', label: 'Explicit table', ariaLabel: 'Score diving from its own place table' },
          ]}
        />
      </div>
      {divingTable.enabled ? (
        <>
          <p className="text-[9px] text-theme-muted mb-2 normal-case tracking-normal">
            Diving scores from this table by place instead of the diver scorer weight below (e.g. NCAA Rule 7-1-4
            dual diving: 7-1 for three or fewer divers, 12-1 for six or more).
          </p>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[9px] text-theme-secondary font-mono">Diving places</span>
            <input
              type="number"
              min={1}
              max={24}
              aria-label="Number of diving scoring places"
              value={divingTable.points.length}
              onChange={e => divingTable.setCount(parseInt(e.target.value, 10) || 1)}
              className="glass-input w-20 font-mono text-xs"
            />
          </div>
          <PlacePointsGrid points={divingTable.points} ariaPrefix="Diving" onSetPoint={divingTable.setPoint} />
          <div className="mt-3">
            <label className="block text-ui-caption text-theme-secondary mb-1">
              Max scoring divers / team / event
            </label>
            <input
              type="number"
              aria-label="Maximum scoring divers per team per diving event"
              value={divingMaxScorersPerTeamPerEvent ?? ''}
              placeholder="No separate cap"
              onChange={e => {
                const raw = e.target.value;
                onChangeMaxScorers(raw === '' ? undefined : parseInt(raw, 10) || undefined);
              }}
              className="glass-input w-full font-mono text-xs"
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

interface PerEventCapsFieldsProps {
  maxIndividualScorersPerTeamPerEvent: ScoringSettings['maxIndividualScorersPerTeamPerEvent'];
  onChangeMaxIndividualScorersPerTeamPerEvent: (value: number | undefined) => void;
  overCapPlaceBehavior: ScoringSettings['overCapPlaceBehavior'];
  onChangeOverCapPlaceBehavior: (value: 'holds-place' | 'removed-from-consideration') => void;
  showConflictWarning: boolean;
}

export function PerEventCapsFields({
  maxIndividualScorersPerTeamPerEvent,
  onChangeMaxIndividualScorersPerTeamPerEvent,
  overCapPlaceBehavior,
  onChangeOverCapPlaceBehavior,
  showConflictWarning,
}: PerEventCapsFieldsProps) {
  return (
    <div className="p-3 rounded-lg border border-theme-soft surface-overlay">
      <label className="block text-ui-caption text-theme-secondary font-medium mb-2">
        Per-team, per-event scoring caps
      </label>
      <p className="text-[9px] text-theme-muted mb-2 normal-case tracking-normal">
        Independent of the meet/event scorer pool above — this caps how many of one team&apos;s swimmers can score
        places in a single event, per NCAA Rule 7-2 (e.g. best 2 per team in a dual). Cannot be combined with a
        full-meet scorer pool scope; the server rejects that combination.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-ui-caption text-theme-secondary mb-1">
            Max individual scorers / team / event
          </label>
          <input
            type="number"
            aria-label="Maximum individual scorers per team per event"
            value={maxIndividualScorersPerTeamPerEvent ?? ''}
            placeholder="No per-event cap"
            onChange={e => {
              const raw = e.target.value;
              onChangeMaxIndividualScorersPerTeamPerEvent(raw === '' ? undefined : parseInt(raw, 10) || undefined);
            }}
            className="glass-input w-full font-mono text-xs"
          />
        </div>
        <div>
          <label className="block text-ui-caption text-theme-secondary mb-1">Over-cap swimmer behavior</label>
          <select
            className="glass-input w-full text-xs"
            aria-label="Behavior for a swimmer over the per-team place cap"
            value={overCapPlaceBehavior ?? 'holds-place'}
            onChange={e => onChangeOverCapPlaceBehavior(e.target.value as 'holds-place' | 'removed-from-consideration')}
          >
            <option value="holds-place">Holds place (later teammates still move up)</option>
            <option value="removed-from-consideration">Removed from consideration</option>
          </select>
        </div>
      </div>
      {showConflictWarning ? (
        <p className="mt-2 p-2 rounded-lg badge-warning text-[9px] normal-case tracking-normal">
          A per-event place cap cannot be combined with a full-meet scorer pool (&quot;Scorer cap scope&quot; = Full
          meet, with the max individual scorers below 999). Saving this will be rejected — switch scorer cap scope to
          &quot;Per event&quot; or clear the meet-wide cap.
        </p>
      ) : null}
    </div>
  );
}
