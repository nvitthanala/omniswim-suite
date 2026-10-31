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

  it('refuses a near miss table and maps unlimited page caps to zero', () => {
    const nearMiss = structuredClone(sourcePreset()) as CompleteRulePreset;
    (nearMiss.scoring.individualPoints as { state: 'set'; value: readonly number[] }).value = [...value(nearMiss.scoring.individualPoints), 0];
    const tableResult = simulatorSettingsFromRulePreset(nearMiss);
    expect(tableResult.ok).toBe(false);
    if (!tableResult.ok) expect(tableResult.refusals.some(r => r.setting === 'pointSystem')).toBe(true);
    const unlimited = structuredClone(sourcePreset()) as CompleteRulePreset;
    (unlimited.scorers.perEventScorerCap as { state: 'set'; value: { cap: 'unlimited' } }).value = { cap: 'unlimited' };
    (unlimited.scorers.scoringRelaysPerTeamPerEvent as { state: 'set'; value: 'unlimited' }).value = 'unlimited';
    (unlimited.entries.maxIndividualPerSwimmer as { state: 'set'; value: 'unlimited' }).value = 'unlimited';
    (unlimited.entries.maxRelayPerSwimmer as { state: 'set'; value: 'unlimited' }).value = 'unlimited';
    (unlimited.entries.maxTotalPerSwimmer as { state: 'set'; value: 'unlimited' }).value = 'unlimited';
    const limitResult = simulatorSettingsFromRulePreset(unlimited);
    expect(limitResult).toEqual({ ok: true, settings: { pointSystem: 'scoring16', maxScorersPerTeam: 0, maxIndrecordsPerAthlete: 0, maxRelaysPerAthlete: 0, maxTotalPerAthlete: 0 } });
    if (limitResult.ok) {
      const rebuilt = requireComplete(simulatorRulePreset({ ...limitResult.settings, maxIndrecordsPerTeam: 0, maxRelaysPerTeam: 0 }).preset);
      expect(value(rebuilt.scorers.perEventScorerCap)).toEqual(value(unlimited.scorers.perEventScorerCap));
      expect(value(rebuilt.scorers.scoringRelaysPerTeamPerEvent)).toEqual(value(unlimited.scorers.scoringRelaysPerTeamPerEvent));
      expect(value(rebuilt.entries.maxIndividualPerSwimmer)).toBe('unlimited');
      expect(value(rebuilt.entries.maxRelayPerSwimmer)).toBe('unlimited');
      expect(value(rebuilt.entries.maxTotalPerSwimmer)).toBe('unlimited');
    }
  });

  it('still refuses numeric zero and a mismatched non-page relay cap', () => {
    const zero = structuredClone(sourcePreset()) as CompleteRulePreset;
    (zero.entries.maxIndividualPerSwimmer as { state: 'set'; value: number }).value = 0;
    const zeroResult = simulatorSettingsFromRulePreset(zero);
    expect(zeroResult.ok).toBe(false);
    if (!zeroResult.ok) expect(zeroResult.refusals).toContainEqual({ setting: 'maxIndrecordsPerAthlete', reason: 'The page interprets 0 as unlimited, while the preset means a numeric cap of 0.' });

    const mismatch = structuredClone(sourcePreset()) as CompleteRulePreset;
    (mismatch.scorers.scoringRelaysPerTeamPerEvent as { state: 'set'; value: 'unlimited' }).value = 'unlimited';
    const mismatchResult = simulatorSettingsFromRulePreset(mismatch);
    expect(mismatchResult.ok).toBe(false);
    if (!mismatchResult.ok) expect(mismatchResult.refusals.some(r => r.setting === 'maxScorersPerTeam' && r.reason.includes('caps differ'))).toBe(true);

    const pending = structuredClone(sourcePreset()) as CompleteRulePreset;
    (pending.entries.maxRelayPerSwimmer as { state: 'pending'; question: string; blocks: readonly string[] }) = { state: 'pending', question: 'Not set.', blocks: ['entries.maxRelayPerSwimmer'] };
    const pendingResult = simulatorSettingsFromRulePreset(pending);
    expect(pendingResult.ok).toBe(false);
    if (!pendingResult.ok) expect(pendingResult.refusals.some(r => r.setting === 'maxRelaysPerAthlete' && r.reason.includes('pending'))).toBe(true);
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
    expect(outcomes.find(o => o.id === 'nsisc@4')?.result).toEqual({ ok: false, refusals: [
      { setting: 'maxScorersPerTeam', reason: 'SwimCloud uses the same cap for individual events and relays, but the preset caps differ or one is pending.' },
      { setting: 'scorers.relayOverCap', reason: 'R67 relay exhibition behavior has no page setting.' },
    ] });
    expect(outcomes.every(o => !o.result?.ok)).toBe(true);
  });
});
