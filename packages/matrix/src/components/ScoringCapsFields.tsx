/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `ScoringSettingsFields`'s scorer-cap grid: scorer cap scope, diver scorer
 * weight, the individual/relay/total entry caps, the entry-cap policy
 * checkboxes, the relay multiplier, half-rate relay swimmers, and the
 * relay-eligibility checkbox. Pure extraction from `ScoringSettingsFields.tsx`
 * — no behavior change. Lock state and the field updater stay in the parent.
 */

import { useId } from 'react';
import type { ScoringSettings } from '@omniswim/core/types';
import { entryCapPolicy, relayLegsAllowTimeTrials } from '@omniswim/core/lib/scoringDefaults';
import { NumberField } from '@omniswim/ui';

interface LockState {
  message?: string | null;
  isLocked: (key: keyof ScoringSettings) => boolean;
  lockProps: (key: keyof ScoringSettings) => Record<string, unknown>;
}

interface ScoringCapsFieldsProps {
  local: ScoringSettings;
  update: (patch: Partial<ScoringSettings>) => void;
  lock: LockState;
}

export function ScoringCapsFields({ local, update, lock }: ScoringCapsFieldsProps) {
  const { isLocked, lockProps } = lock;
  const policy = entryCapPolicy(local);
  const relayTimeTrialHelperId = useId();
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Scorer cap scope</label>
        <select
          className={`glass-input w-full text-xs ${isLocked('scorerCapScope') ? ' opacity-60 cursor-not-allowed' : ''}`}
          aria-label="Scorer cap scope"
          disabled={isLocked('scorerCapScope')}
          title={isLocked('scorerCapScope') ? lock.message ?? undefined : undefined}
          value={local.scorerCapScope ?? 'event'}
          onChange={e => update({ scorerCapScope: e.target.value as 'meet' | 'event' })}
        >
          <option value="event">Per event</option>
          <option value="meet">Full meet</option>
        </select>
      </div>
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Diver scorer weight</label>
        <NumberField
          aria-label="Diver scorer weight"
          step={0.01}
          min={0}
          max={1}
          value={local.diverScorerWeight ?? 1}
          onValueChange={value => update({ diverScorerWeight: value })}
          {...lockProps('diverScorerWeight')}
        />
      </div>
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Max individual scorers / team</label>
        <NumberField
          aria-label="Maximum individual scorers per team"
          value={local.maxIndividualScorersPerTeam}
          min={0}
          onValueChange={value => update({ maxIndividualScorersPerTeam: value })}
          {...lockProps('maxIndividualScorersPerTeam')}
        />
      </div>
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Max scoring relays / team / relay event</label>
        <NumberField
          aria-label="Maximum scoring relays per team per event"
          value={local.maxRelaysScoringPerTeam}
          min={0}
          onValueChange={value => update({ maxRelaysScoringPerTeam: value })}
          {...lockProps('maxRelaysScoringPerTeam')}
        />
      </div>
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Max ind entries / swimmer</label>
        <NumberField
          aria-label="Maximum individual entries per swimmer"
          value={local.maxIndividualEntriesPerSwimmer ?? 999}
          min={1}
          onValueChange={value => update({ maxIndividualEntriesPerSwimmer: value })}
          {...lockProps('maxIndividualEntriesPerSwimmer')}
        />
      </div>
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Max relay entries / swimmer</label>
        <NumberField
          aria-label="Maximum relay entries per swimmer"
          value={local.maxRelayEntriesPerSwimmer ?? 999}
          min={1}
          onValueChange={value => update({ maxRelayEntriesPerSwimmer: value })}
          {...lockProps('maxRelayEntriesPerSwimmer')}
        />
      </div>
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Max total entries / swimmer</label>
        <NumberField
          aria-label="Maximum total entries per swimmer"
          value={local.maxTotalEntriesPerSwimmer ?? 999}
          min={1}
          onValueChange={value => update({ maxTotalEntriesPerSwimmer: value })}
          {...lockProps('maxTotalEntriesPerSwimmer')}
        />
      </div>
      <div className="col-span-2 flex flex-col gap-2">
        <label className="flex items-center gap-2 text-ui-micro text-theme-secondary cursor-pointer">
          <input
            type="checkbox"
            aria-label="Time trials count toward the entry cap"
            checked={policy.countsTimeTrials}
            onChange={e => update({ entryCapCountsTimeTrials: e.target.checked })}
            className="accent-[var(--text-accent)]"
          />
          Time trials count toward the entry cap
        </label>
        <label className="flex items-center gap-2 text-ui-micro text-theme-secondary cursor-pointer">
          <input
            type="checkbox"
            aria-label="Exhibition swims count toward the entry cap"
            checked={policy.countsExhibition}
            onChange={e => update({ entryCapCountsExhibition: e.target.checked })}
            className="accent-[var(--text-accent)]"
          />
          Exhibition swims count toward the entry cap
        </label>
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-2 text-ui-micro text-theme-secondary cursor-pointer">
            <input
              type="checkbox"
              aria-describedby={relayTimeTrialHelperId}
              checked={relayLegsAllowTimeTrials(local)}
              onChange={e => update({ relayLegsAllowTimeTrials: e.target.checked })}
              className="accent-[var(--text-accent)]"
            />
            Let time trials fill relay legs
          </label>
          <p id={relayTimeTrialHelperId} className="pl-6 text-ui-micro text-theme-muted">
            Off by default. A time trial is outside the meet&apos;s program. A leg filled from one is marked Time trial.
          </p>
        </div>
      </div>
      <div>
        <label className="block text-ui-caption text-theme-secondary mb-1">Relay multiplier</label>
        <NumberField
          aria-label="Relay multiplier"
          value={local.relayMultiplier}
          min={0}
          step={0.01}
          onValueChange={value => update({ relayMultiplier: value })}
          {...lockProps('relayMultiplier')}
        />
      </div>
      <div className="flex items-end">
        <label className="flex items-center gap-2 text-ui-micro text-theme-secondary cursor-pointer">
          <input
            type="checkbox"
            aria-label="Half-rate relay swimmers"
            checked={local.halfRateRelaySwimmer}
            onChange={e => update({ halfRateRelaySwimmer: e.target.checked })}
            className="accent-[var(--text-accent)]"
          />
          Half-rate relay swimmers
        </label>
      </div>
      <div className="col-span-2">
        <label
          className={`flex items-center gap-2 text-ui-micro text-theme-secondary ${
            isLocked('relayEligibleFromScorerPool') ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
          }`}
          title={isLocked('relayEligibleFromScorerPool') ? lock.message ?? undefined : undefined}
        >
          <input
            type="checkbox"
            aria-label="Require relay legs to be in individual scorer pool"
            disabled={isLocked('relayEligibleFromScorerPool')}
            checked={local.relayEligibleFromScorerPool === true}
            onChange={e => update({ relayEligibleFromScorerPool: e.target.checked })}
            className="accent-[var(--text-accent)]"
          />
          Relays only if all legs are in individual scorer pool
        </label>
      </div>
    </div>
  );
}
