import { describe, expect, it } from 'vitest';
import { BUILTIN_RULE_PRESETS, requireComplete } from '@omniswim/engine';
import type { CompleteRulePreset } from '@omniswim/engine';
import type { Setting } from '@omniswim/engine';
import { simulatorPointTable, simulatorRulePreset, simulatorSettingsFromRulePreset } from '@omniswim/swimcloud/browser';

function sourcePreset() {
  return requireComplete(simulatorRulePreset({ pointSystem: 'scoring16', maxScorersPerTeam: 3, maxIndrecordsPerAthlete: 3, maxIndrecordsPerTeam: 0, maxRelaysPerAthlete: 2, maxRelaysPerTeam: 0, maxTotalPerAthlete: 7 }).preset);
}
function value<T>(setting: Setting<T>): T {
  expect(setting.state).toBe('set');
  return (setting as { state: 'set'; value: T }).value;
}

describe('simulator reverse rule mapping', () => {
  it('maps exact page tables and numeric swimmer limits, never team limits', () => {
    const result = simulatorSettingsFromRulePreset(sourcePreset());
    expect(result).toEqual({ ok: true, settings: { pointSystem: 'scoring16', maxScorersPerTeam: 3, maxIndrecordsPerAthlete: 3, maxRelaysPerAthlete: 2, maxTotalPerAthlete: 7 } });
    if (result.ok) {
      expect(result.settings).not.toHaveProperty('maxIndrecordsPerTeam');
      const roundTrip = requireComplete(simulatorRulePreset({ ...result.settings, maxIndrecordsPerTeam: 0, maxRelaysPerTeam: 0 }).preset);
      expect(value(roundTrip.scoring.individualPoints)).toEqual(value(sourcePreset().scoring.individualPoints));
      expect(value(roundTrip.scoring.relayPoints)).toEqual(value(sourcePreset().scoring.relayPoints));
      expect(value(roundTrip.entries.maxIndividualPerSwimmer)).toBe(value(sourcePreset().entries.maxIndividualPerSwimmer));
      expect(value(roundTrip.entries.maxRelayPerSwimmer)).toBe(value(sourcePreset().entries.maxRelayPerSwimmer));
      expect(value(roundTrip.entries.maxTotalPerSwimmer)).toBe(value(sourcePreset().entries.maxTotalPerSwimmer));
    }
  });

  it('refuses a near miss table and an unlimited entry cap by name', () => {
    const nearMiss = structuredClone(sourcePreset()) as CompleteRulePreset;
    (nearMiss.scoring.individualPoints as { state: 'set'; value: readonly number[] }).value = [...value(nearMiss.scoring.individualPoints), 0];
    const tableResult = simulatorSettingsFromRulePreset(nearMiss);
    expect(tableResult.ok).toBe(false);
    if (!tableResult.ok) expect(tableResult.refusals.some(r => r.setting === 'pointSystem')).toBe(true);
    const unlimited = structuredClone(sourcePreset()) as CompleteRulePreset;
    (unlimited.entries.maxIndividualPerSwimmer as { state: 'set'; value: 'unlimited' }).value = 'unlimited';
    const limitResult = simulatorSettingsFromRulePreset(unlimited);
    expect(limitResult.ok).toBe(false);
    if (!limitResult.ok) expect(limitResult.refusals.some(r => r.setting === 'maxIndrecordsPerAthlete')).toBe(true);
  });

  it('refuses different relay scoring caps and the R67 exhibition rule', () => {
    const preset = structuredClone(sourcePreset()) as CompleteRulePreset;
    (preset.scorers.scoringRelaysPerTeamPerEvent as { state: 'set'; value: number }).value = 2;
    (preset.scorers.relayOverCap as { state: 'set'; value: 'exhibition' }).value = 'exhibition';
    const result = simulatorSettingsFromRulePreset(preset);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map(r => r.setting)).toEqual(expect.arrayContaining(['maxScorersPerTeam', 'scorers.relayOverCap']));
  });

  it('round trips mapped settings and records built-in mapping outcomes', () => {
    const outcomes = BUILTIN_RULE_PRESETS.map(b => {
      try { return { id: `${b.id}@${b.version}`, result: simulatorSettingsFromRulePreset(requireComplete(b.preset)) }; }
      catch { return { id: `${b.id}@${b.version}`, result: undefined }; }
    });
    for (const outcome of outcomes) {
      if (!outcome.result?.ok) continue;
      const rebuilt = requireComplete(simulatorRulePreset({ ...outcome.result.settings, maxIndrecordsPerTeam: 0, maxRelaysPerTeam: 0 }).preset);
      const table = simulatorPointTable(outcome.result.settings.pointSystem)!;
      expect(value(rebuilt.scoring.individualPoints)).toEqual(table.individual);
      expect(value(rebuilt.scoring.relayPoints)).toEqual({ kind: 'table', points: table.relay });
      expect(value(rebuilt.scoring.divingPoints)).toEqual({ kind: 'same-as-individual' });
      expect(value(rebuilt.entries.maxIndividualPerSwimmer)).toBe(outcome.result.settings.maxIndrecordsPerAthlete);
      expect(value(rebuilt.entries.maxRelayPerSwimmer)).toBe(outcome.result.settings.maxRelaysPerAthlete);
      expect(value(rebuilt.entries.maxTotalPerSwimmer)).toBe(outcome.result.settings.maxTotalPerAthlete);
    }
    expect(outcomes.every(o => !o.result?.ok)).toBe(true);
  });
});
