/** Exact reverse mapping of an OmniSwim preset onto SwimCloud's native settings. */
import type { CompleteRulePreset } from '@omniswim/engine';
import { SIMULATOR_POINT_TABLES } from './pointTables';
import type { SimulatorSettingsInput } from './simulatorTypes';

export type SimulatorRuleSettings = Pick<SimulatorSettingsInput, 'pointSystem' | 'maxScorersPerTeam' | 'maxIndrecordsPerAthlete' | 'maxRelaysPerAthlete' | 'maxTotalPerAthlete'>;
export interface SimulatorRuleRefusal { readonly setting: string; readonly reason: string }
export type SimulatorRuleReverseMapping =
  | { readonly ok: true; readonly settings: SimulatorRuleSettings }
  | { readonly ok: false; readonly refusals: readonly SimulatorRuleRefusal[] };

/** Map only when the complete preset can be represented exactly by native page settings. */
export function simulatorSettingsFromRulePreset(preset: CompleteRulePreset): SimulatorRuleReverseMapping {
  const refusals: SimulatorRuleRefusal[] = [];
  const pageCap = (value: unknown, setting: string): number | undefined => {
    if (value === 'unlimited') return 0;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 998) return value;
    refusals.push({ setting, reason: value === 0 ? 'The page interprets 0 as unlimited, while the preset means a numeric cap of 0.' : 'The preset value is pending or outside the page numeric limit range.' });
    return undefined;
  };
  const individual = preset.scoring.individualPoints.state === 'set' ? preset.scoring.individualPoints.value : undefined;
  const relay = preset.scoring.relayPoints.state === 'set' ? preset.scoring.relayPoints.value : undefined;
  const diving = preset.scoring.divingPoints.state === 'set' ? preset.scoring.divingPoints.value : undefined;
  const pointSystem = individual && relay && diving ? Object.entries(SIMULATOR_POINT_TABLES).find(([, table]) =>
    JSON.stringify(table.individual) === JSON.stringify(individual) && relay.kind === 'table' &&
    JSON.stringify(table.relay) === JSON.stringify(relay.points) &&
    (diving.kind === 'same-as-individual' || (diving.kind === 'table' && JSON.stringify(diving.points) === JSON.stringify(individual)))
  )?.[0] : undefined;
  if (!pointSystem) refusals.push({ setting: 'pointSystem', reason: 'Individual, relay, and diving point tables do not exactly match one SwimCloud point system.' });

  const perEvent = preset.scorers.perEventScorerCap.state === 'set' ? preset.scorers.perEventScorerCap.value : undefined;
  const relayCap = preset.scorers.scoringRelaysPerTeamPerEvent.state === 'set' ? preset.scorers.scoringRelaysPerTeamPerEvent.value : undefined;
  const scorerCap = perEvent?.cap;
  const numericScorerCap = pageCap(scorerCap, 'maxScorersPerTeam');
  if (relayCap !== scorerCap) refusals.push({ setting: 'maxScorersPerTeam', reason: 'SwimCloud uses the same cap for individual events and relays, but the preset caps differ or one is pending.' });
  if (preset.scorers.relayOverCap.state !== 'set' || preset.scorers.relayOverCap.value !== 'holds-place') refusals.push({ setting: 'scorers.relayOverCap', reason: 'R67 relay exhibition behavior has no page setting.' });
  const maxIndrecordsPerAthlete = pageCap(preset.entries.maxIndividualPerSwimmer.state === 'set' ? preset.entries.maxIndividualPerSwimmer.value : undefined, 'maxIndrecordsPerAthlete');
  const maxRelaysPerAthlete = pageCap(preset.entries.maxRelayPerSwimmer.state === 'set' ? preset.entries.maxRelayPerSwimmer.value : undefined, 'maxRelaysPerAthlete');
  const maxTotalPerAthlete = pageCap(preset.entries.maxTotalPerSwimmer.state === 'set' ? preset.entries.maxTotalPerSwimmer.value : undefined, 'maxTotalPerAthlete');
  if (refusals.length || !pointSystem || numericScorerCap === undefined || maxIndrecordsPerAthlete === undefined || maxRelaysPerAthlete === undefined || maxTotalPerAthlete === undefined) return { ok: false, refusals };
  return { ok: true, settings: { pointSystem, maxScorersPerTeam: numericScorerCap, maxIndrecordsPerAthlete, maxRelaysPerAthlete, maxTotalPerAthlete } };
}
