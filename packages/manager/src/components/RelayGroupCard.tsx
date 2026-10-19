/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One relay-group card (event header, team splits, and its four leg cards)
 * in IndRelayManagementView's relay list — split out of the view's own
 * function body.
 */
import {
  RELAY_LEG_ESTIMATE_LABEL,
  formatLegSplitSummary,
  formatTeamSplitSummary,
  relayLegTimeView,
} from '@omniswim/core/lib/relaySplits';
import {
  hasRelayLegOverride,
  isValidRelayLegIndex,
  relayLegIsVacant,
  relayLegRequirements,
  relayMissingStrokeLabel,
} from '@omniswim/core/lib/relayLegMatching';
import type { RelayLegOverride } from '@omniswim/core/types';
import { Button } from '@omniswim/ui';
import type { RelayGroup } from './indRelayGroupsView';
import type { DragPayload } from './IndRelayManagementView';

type Props = {
  group: RelayGroup;
  isSelected: boolean;
  /** A relay of a theoretical meet: built from individual bests, never swum. Shows an estimated tag. */
  estimated?: boolean;
  whatIfMode: boolean;
  dragOverLeg: string | null;
  manualTimes: Record<string, string>;
  overrides: RelayLegOverride[];
  onSelect: () => void;
  onAutofillAllVacant: () => void;
  onAutofillLeg: (legIndex: number) => void;
  onAssignDragPayload: (legIndex: number, payload: DragPayload) => void;
  onSetDragOverLeg: (key: string | null) => void;
  onManualTimeChange: (fieldKey: string, value: string) => void;
  onSaveManualLeg: (legIndex: number) => void;
  onClearLegOverride: (legIndex: number) => void;
  /**
   * Deletes the stored override at an invalid leg index. Offered on a problem row
   * only when an override is stored there. It works outside what-if mode.
   */
  onRemoveInvalidLeg?: (legIndex: number) => void;
};

/** The label shown for a leg index that names no leg. */
export const INVALID_RELAY_LEG_LABEL = 'Invalid relay leg on this entry';

/**
 * Leg indexes of this relay that name no leg: a scored leg row that carries one,
 * and a stored override at one (the scorer ignores it, so no leg row shows it).
 * In order of first appearance, one per index.
 */
function invalidLegIndexes(group: RelayGroup, overrides: RelayLegOverride[]): number[] {
  const eventLower = group.event.toLowerCase();
  const found: number[] = [];
  const note = (legIndex: number) => {
    if (!isValidRelayLegIndex(eventLower, legIndex) && !found.includes(legIndex)) found.push(legIndex);
  };
  for (const leg of group.legs) note(leg.relayLegIndex ?? 0);
  for (const o of overrides) if (o.relayEntryKey === group.key) note(o.legIndex);
  return found;
}

export default function RelayGroupCard({
  group,
  isSelected,
  estimated = false,
  whatIfMode,
  dragOverLeg,
  manualTimes,
  overrides,
  onSelect,
  onAutofillAllVacant,
  onAutofillLeg,
  onAssignDragPayload,
  onSetDragOverLeg,
  onManualTimeChange,
  onSaveManualLeg,
  onClearLegOverride,
  onRemoveInvalidLeg,
}: Props) {
  const eventLower = group.event.toLowerCase();
  const badLegIndexes = invalidLegIndexes(group, overrides);
  const readableLegs = group.legs.filter(l => isValidRelayLegIndex(eventLower, l.relayLegIndex ?? 0));
  const vacantCount = readableLegs.filter(l => relayLegIsVacant(l)).length;

  return (
    <div
      className={`surface-overlay border rounded-lg p-3 ${
        isSelected ? 'border-[var(--text-accent)]/40' : 'border-theme-soft'
      }`}
      onClick={onSelect}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div>
          <p className="text-ui-label font-medium text-[var(--text-primary)]">
            {group.event}
            {estimated ? <span className="ml-2 rounded border border-warning-faint px-1 text-ui-micro font-normal text-warning">estimated</span> : null}
          </p>
          <p className="text-ui-micro text-theme-secondary">
            {group.roundSwam} · Pl {group.rank > 0 ? group.rank : '—'}
            {vacantCount > 0 ? <span className="text-warning ml-2">{vacantCount} vacant leg(s)</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {whatIfMode && vacantCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="px-2 py-0.5 text-theme-secondary"
              onClick={e => {
                e.stopPropagation();
                onAutofillAllVacant();
              }}
            >
              Auto-fill all
            </Button>
          ) : null}
          <p className="text-ui-caption font-mono text-[var(--text-accent)] tabular-nums">Team {group.teamTotal}</p>
        </div>
      </div>
      {group.teamSplits ? (
        <p className="text-ui-micro text-theme-secondary mb-3 font-mono">{formatTeamSplitSummary(group.teamSplits)}</p>
      ) : null}
      <div className="grid sm:grid-cols-2 gap-2">
        {badLegIndexes.map(badIndex => (
          <div
            key={`invalid-${String(badIndex)}`}
            role="alert"
            data-invalid-relay-leg={String(badIndex)}
            className="border border-warning bg-warning-faint rounded-lg px-2 py-1.5 text-ui-caption"
          >
            <p className="text-warning font-medium">{INVALID_RELAY_LEG_LABEL}</p>
            <p className="text-ui-micro text-theme-secondary mt-0.5">
              Leg index {String(badIndex)} names no leg of this relay.
            </p>
            {onRemoveInvalidLeg && hasRelayLegOverride(overrides, group.key, badIndex) ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-1.5 px-2 py-0.5"
                onClick={e => {
                  e.stopPropagation();
                  onRemoveInvalidLeg(badIndex);
                }}
              >
                Remove
              </Button>
            ) : (
              <p className="text-ui-micro text-theme-muted italic mt-1">
                The saved result row carries this index. Re-import the meet to correct it.
              </p>
            )}
          </div>
        ))}
        {readableLegs.map(leg => {
          const legIndex = leg.relayLegIndex ?? 0;
          const req = relayLegRequirements(group.event, legIndex);
          const isVacant = relayLegIsVacant(leg);
          const legDropKey = `${group.key}|${legIndex}`;
          const fieldKey = legDropKey;
          const legView = relayLegTimeView(leg);
          return (
            <div
              key={leg.id}
              className={`border rounded-lg px-2 py-1.5 text-ui-caption transition-colors ${
                isVacant ? 'border-warning bg-warning-faint' : 'border-theme-soft/60'
              } ${dragOverLeg === legDropKey ? 'ring-1 ring-[var(--text-accent)]' : ''}`}
              onDragOver={e => {
                if (!whatIfMode || !isVacant) return;
                e.preventDefault();
                onSetDragOverLeg(legDropKey);
              }}
              onDragLeave={() => onSetDragOverLeg(null)}
              onDrop={e => {
                e.preventDefault();
                onSetDragOverLeg(null);
                if (!whatIfMode || !isVacant) return;
                const raw = e.dataTransfer.getData('application/x-omni-relay-leg');
                if (!raw) return;
                try {
                  onAssignDragPayload(legIndex, JSON.parse(raw) as DragPayload);
                } catch {
                  /* ignore */
                }
              }}
            >
              <div className="flex justify-between gap-2">
                <span className="text-[var(--text-primary)] truncate">
                  L{legIndex + 1}{' '}
                  {isVacant && (!leg.name || leg.name === '—') ? (
                    <span className="text-warning">
                      {req.legDistanceYards == null
                        ? 'Missing — distance unreadable'
                        : `Missing — ${relayMissingStrokeLabel(req.stroke)} ${req.legDistanceYards}`}
                    </span>
                  ) : (
                    leg.name
                  )}
                </span>
                <span className="font-mono text-[var(--text-accent)] shrink-0 tabular-nums">
                  {legView?.time ?? '—'}
                  {legView?.kind === 'estimate' ? (
                    <span
                      className="ml-1 text-ui-micro font-sans text-theme-muted"
                      title={legView.basis ? `Estimated leg time: ${legView.basis}` : 'Estimated leg time'}
                    >
                      {RELAY_LEG_ESTIMATE_LABEL}
                    </span>
                  ) : null}
                </span>
              </div>
              {leg.relayLegSplitDetail ? (
                <p className="text-ui-micro text-theme-secondary font-mono mt-1 leading-snug">
                  {formatLegSplitSummary(leg.relayLegSplitDetail)}
                </p>
              ) : null}
              <p className="text-ui-micro text-theme-muted mt-0.5 tabular-nums">
                {typeof leg.points === 'number' ? `${leg.points.toFixed(1)} pts` : '—'}
              </p>
              {whatIfMode && isVacant ? (
                <div className="mt-2 space-y-1.5 border-t border-theme-soft/40 pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[var(--text-accent)] hover:underline"
                    onClick={() => onAutofillLeg(legIndex)}
                  >
                    Auto-fill best
                  </Button>
                  {req.legDistanceYards == null ? (
                    <p className="text-ui-micro text-theme-muted italic">
                      Distance unreadable — fix the relay's event label to enter a leg time.
                    </p>
                  ) : (
                    <div className="flex gap-1">
                      <input
                        type="text"
                        placeholder={`Leg time (${req.legDistanceYards}y)`}
                        value={manualTimes[fieldKey] ?? ''}
                        onChange={e => onManualTimeChange(fieldKey, e.target.value)}
                        className="flex-1 min-w-0 surface-muted-bg border border-theme-soft rounded-md px-1.5 py-0.5 text-ui-micro font-mono"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="px-1.5 py-0.5"
                        onClick={() => onSaveManualLeg(legIndex)}
                      >
                        Set
                      </Button>
                    </div>
                  )}
                  {hasRelayLegOverride(overrides, group.key, legIndex) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-theme-muted hover:text-warning"
                      onClick={() => onClearLegOverride(legIndex)}
                    >
                      Clear override
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
