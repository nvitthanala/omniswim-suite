/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The built-in scoring presets, and the rule that there is exactly one place in
 * this repo a Rule 7 number is written down.
 *
 * `scoringDefaults.ts` generates every NCAA preset from `NCAA_FORMAT_RULESETS`
 * at module load rather than transcribing tables into JSON files or a second
 * constant. These tests assert the generated tables are *identical objects of
 * numbers* to the rulebook constant, and separately pin the headline tables as
 * literals so an upstream edition change breaks CI instead of silently
 * re-baselining the app. See CLAUDE.md § "Data provenance".
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILT_IN_SCORING_PRESETS,
  BUILT_IN_SCORING_PRESET_BY_ID,
  GENERIC_TOP16_SETTINGS,
  HostPublishedTableRequiredError,
  NSISC_PRESET_SETTINGS,
  builtInScoringPresetMeta,
  isBuiltInScoringPresetId,
  mergeScoringSettings,
  ncaaPresetId,
  presetIdForConference,
  scoringPresetFromNcaaRuleset,
  scoringSettingsLock,
  settingsForBuiltInScoringPreset,
  settingsFromPresetPayload,
  setUserConferencePresetBindings,
} from '@omniswim/core/lib/scoringDefaults';
import {
  NCAA_FORMAT_RULESETS,
  NCAA_MEET_FORMATS,
  isNcaaHostPublishedTable,
  type NcaaPointTable,
} from '@omniswim/core/lib/ncaaScoringRules';
import type { ScoringSettings } from '@omniswim/core/types';

afterEach(() => {
  // The conference registry is module-global by design (a synchronous lookup
  // called from components that never see this module). Reset it between tests.
  setUserConferencePresetBindings([]);
});

describe('built-in presets are generated, not transcribed', () => {
  it('covers every Rule 7 format', () => {
    for (const format of NCAA_MEET_FORMATS) {
      expect(isBuiltInScoringPresetId(ncaaPresetId(format))).toBe(true);
    }
  });

  it('carries the rulebook tables verbatim for every format that publishes one', () => {
    for (const format of NCAA_MEET_FORMATS) {
      const ruleset = NCAA_FORMAT_RULESETS[format];
      const preset = BUILT_IN_SCORING_PRESET_BY_ID[ncaaPresetId(format)];

      if (isNcaaHostPublishedTable(ruleset.individual)) {
        expect(preset.settings).toBeUndefined();
        expect(preset.requiresHostPublishedTable).toBe(true);
        continue;
      }

      const individual = ruleset.individual as NcaaPointTable;
      expect(preset.settings?.scoringPoints).toEqual([...individual.places]);
      expect(preset.settings?.maxIndividualScorersPerTeamPerEvent).toEqual(
        individual.maxScorersPerTeam ?? undefined
      );

      if (ruleset.relay && !isNcaaHostPublishedTable(ruleset.relay)) {
        expect(preset.settings?.relayPoints).toEqual([...ruleset.relay.places]);
        expect(preset.settings?.maxRelaysScoringPerTeam).toBe(
          ruleset.relay.maxScorersPerTeam ?? 999
        );
      } else if (ruleset.relay === null) {
        // Rule 7-1-4's diving duals contest no relays at all. A relay in such a
        // meet must not quietly score off the diving table.
        expect(preset.settings?.relayPoints).toBeUndefined();
        expect(preset.settings?.maxRelaysScoringPerTeam).toBe(0);
      }

      expect(preset.settings?.meetFormat).toBe(format);
      expect(preset.citation).toBe(individual.citation);
    }
  });

  it('pins the two dual tables as literals so an upstream edition change is loud', () => {
    const dual6 = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more');
    expect(dual6.scoringPoints).toEqual([9, 4, 3, 2, 1, 0]);
    expect(dual6.relayPoints).toEqual([11, 4, 2, 0]);
    expect(dual6.maxIndividualScorersPerTeamPerEvent).toBe(3);
    expect(dual6.maxRelaysScoringPerTeam).toBe(2);

    const dual5 = settingsForBuiltInScoringPreset('ncaa-dual-five-lanes-or-fewer');
    expect(dual5.scoringPoints).toEqual([5, 3, 1, 0]);
    expect(dual5.relayPoints).toEqual([7, 0]);
    expect(dual5.maxIndividualScorersPerTeamPerEvent).toBe(2);
    // Rule 7-1-2 states a per-team cap for individual events and none for
    // relays. The absence is transcribed as an absence, not copied from 7-1-1.
    expect(dual5.maxRelaysScoringPerTeam).toBe(999);

    expect(settingsForBuiltInScoringPreset('ncaa-relay-meet').scoringPoints).toEqual([
      14, 10, 8, 6, 4, 2,
    ]);
    expect(
      settingsForBuiltInScoringPreset('ncaa-double-dual-tri-quad').relayPoints
    ).toEqual([11, 4, 2]);
  });

  it('refuses to invent an invitational table', () => {
    const preset = BUILT_IN_SCORING_PRESET_BY_ID['ncaa-invitational-host-published'];
    expect(preset.settings).toBeUndefined();
    expect(preset.citation).toBe('NCAA Rule 7-4');

    // Absent, not empty and not a default. Rule 7-4 leaves the table to the host.
    expect(() => settingsForBuiltInScoringPreset('ncaa-invitational-host-published')).toThrow(
      HostPublishedTableRequiredError
    );
  });

  it('never advertises a preset whose points it cannot supply as though it could', () => {
    for (const preset of BUILT_IN_SCORING_PRESETS) {
      expect(Boolean(preset.settings)).toBe(!preset.requiresHostPublishedTable);
    }
  });

  it('keeps the two pre-existing presets byte-identical', () => {
    expect(settingsForBuiltInScoringPreset('generic-top16')).toEqual(GENERIC_TOP16_SETTINGS);
    expect(settingsForBuiltInScoringPreset('nsisc')).toEqual(NSISC_PRESET_SETTINGS);
    // Neither is an NCAA meet format; neither may claim one.
    expect(GENERIC_TOP16_SETTINGS.meetFormat).toBeUndefined();
    expect(NSISC_PRESET_SETTINGS.meetFormat).toBeUndefined();
  });

  it('gives every preset a unique, file-safe, lowercase id', () => {
    const ids = BUILT_IN_SCORING_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{0,79}$/);
  });

  it('exposes list metadata without point values', () => {
    const meta = builtInScoringPresetMeta();
    expect(meta.length).toBe(BUILT_IN_SCORING_PRESETS.length);
    for (const entry of meta) {
      expect(entry.builtIn).toBe(true);
      expect(entry).not.toHaveProperty('settings');
      expect(entry).not.toHaveProperty('scoringPoints');
    }
  });

  it('maps one ruleset to one preset through the exported function', () => {
    const preset = scoringPresetFromNcaaRuleset(NCAA_FORMAT_RULESETS['championship-16']);
    expect(preset.id).toBe('ncaa-championship-16');
    expect(preset.settings?.scoringPoints).toEqual([
      20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1,
    ]);
    // Rule 7-6-4 names the split: championship 1-8, consolation 9-16.
    expect(preset.settings?.aFinalBracketSize).toBe(8);
  });
});

describe('a preset survives the on-disk round trip', () => {
  it('keeps the new tables, the caps and the format link', () => {
    const settings = settingsForBuiltInScoringPreset(
      'ncaa-dual-six-lanes-or-more-plus-dual-diving-six-or-more'
    );
    const stored = { id: 'x', label: 'X', description: 'd', ...settings };
    const back = settingsFromPresetPayload(stored as Record<string, unknown>);

    expect(back.scoringPoints).toEqual(settings.scoringPoints);
    expect(back.relayPoints).toEqual(settings.relayPoints);
    expect(back.divingPoints).toEqual(settings.divingPoints);
    expect(back.maxIndividualScorersPerTeamPerEvent).toBe(3);
    expect(back.divingMaxScorersPerTeamPerEvent).toBe(6);
    expect(back.meetFormat).toBe('dual-six-lanes-or-more');
    expect(back).not.toHaveProperty('id');
    expect(back).not.toHaveProperty('label');
  });
});

describe('conference bindings are declared, not hardcoded', () => {
  it('maps the conferences the old string matching handled', () => {
    expect(presetIdForConference('NSISC')).toBe('nsisc');
    expect(presetIdForConference('Gulf South / NSISC Championships')).toBe('nsisc');
    expect(presetIdForConference('ACC')).toBe('generic-top16');
    expect(presetIdForConference('SEC')).toBe('generic-top16');
    expect(presetIdForConference('Big 12')).toBe('generic-top16');
    expect(presetIdForConference('BIG12')).toBe('generic-top16');
    expect(presetIdForConference('Peach Belt')).toBeNull();
    expect(presetIdForConference(undefined)).toBeNull();
  });

  it('lets a saved preset claim a conference the app does not', () => {
    setUserConferencePresetBindings([
      { id: 'gac-house', label: 'GAC house rules', conferenceMatches: ['GAC'] },
    ]);
    expect(presetIdForConference('Great American Conference (GAC)')).toBe('gac-house');
  });

  it('does not let a saved preset capture a conference a built-in already claims', () => {
    setUserConferencePresetBindings([
      { id: 'not-nsisc', label: 'Impostor', conferenceMatches: ['NSISC'] },
    ]);
    // The NSISC lock in mergeScoringSettings hangs off this answer, so a saved
    // preset must not be able to switch it off.
    expect(presetIdForConference('NSISC')).toBe('nsisc');
  });
});

describe('settings the engine will ignore are reported as locked', () => {
  it('reports relayMultiplier inert when an explicit relay table is present', () => {
    const settings = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more');
    const lock = scoringSettingsLock(settings);
    expect(lock.reason).toBe('explicit_relay_table');
    expect([...lock.keys]).toEqual(['relayMultiplier']);
    expect(typeof lock.message).toBe('string');
  });

  it('locks nothing for a preset with no relay table and no conference', () => {
    const lock = scoringSettingsLock(GENERIC_TOP16_SETTINGS);
    expect(lock.reason).toBeNull();
    expect([...lock.keys]).toEqual([]);
  });
});

describe('a declared NCAA meet format is not replaced by the conference preset', () => {
  it('keeps the dual rules for a dual meet on an NSISC workspace', () => {
    const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more');
    const merged = mergeScoringSettings(dual, { conference: 'NSISC' });

    // Before the guard, picking the dual preset on an NSISC workspace silently
    // swapped in the conference championship's meet-wide 18-scorer pool.
    expect(merged.scoringPoints).toEqual([9, 4, 3, 2, 1, 0]);
    expect(merged.maxIndividualScorersPerTeam).toBe(999);
    expect(merged.scorerCapScope).toBe('event');
    expect(merged.maxTotalEntriesPerSwimmer).toBeUndefined();
    expect(scoringSettingsLock(dual, { conference: 'NSISC' }).reason).not.toBe('nsisc');
  });

  it('still applies the conference rules to settings that name no format', () => {
    const merged = mergeScoringSettings(
      { maxIndividualScorersPerTeam: 777 } as Partial<ScoringSettings>,
      { conference: 'NSISC' }
    );
    expect(merged.maxIndividualScorersPerTeam).toBe(NSISC_PRESET_SETTINGS.maxIndividualScorersPerTeam);
    expect(merged.scorerCapScope).toBe('meet');
    expect(merged.maxTotalEntriesPerSwimmer).toBe(7);
  });
});
