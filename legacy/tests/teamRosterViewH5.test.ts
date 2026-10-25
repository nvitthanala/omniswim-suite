/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * H5 (2026-09-25 code-health sweep): unit tests for the view-model helpers
 * pulled out of TeamRosterPanel.tsx's function body — describeStrongestEvents,
 * genderLabelFor, rosterColSpan, resolveTeamPickerMode and
 * buildRosterRowViewModel. No behavior changed; these pin what the panel
 * already did inline.
 */
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import type { AthleteEventProfile, Workspace } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import { NSISC_PRESET_SETTINGS } from '@omniswim/core/lib/scoringDefaults';
import { buildAliasResolver } from '@omniswim/core/lib/athleteAliases';
import {
  buildRosterRowViewModel,
  describeStrongestEvents,
  genderLabelFor,
  resolveTeamPickerMode,
  rosterColSpan,
} from '../packages/manager/src/components/teamRosterView';

describe('genderLabelFor', () => {
  it('labels men and women', () => {
    expect(genderLabelFor(Gender.MEN)).toBe("Men's");
    expect(genderLabelFor(Gender.WOMEN)).toBe("Women's");
  });
});

describe('rosterColSpan', () => {
  it('is 2 when not editable, 3 editable without a delete handler, 4 with one', () => {
    expect(rosterColSpan(false, false)).toBe(2);
    expect(rosterColSpan(false, true)).toBe(2);
    expect(rosterColSpan(true, false)).toBe(3);
    expect(rosterColSpan(true, true)).toBe(4);
  });
});

describe('resolveTeamPickerMode', () => {
  it('defaults to sidebar when the sidebar is shown and no mode is forced', () => {
    expect(resolveTeamPickerMode(true, undefined)).toEqual({ useDropdown: false, useSidebar: true });
  });
  it('forces dropdown when teamPickerMode is dropdown even with the sidebar shown', () => {
    expect(resolveTeamPickerMode(true, 'dropdown')).toEqual({ useDropdown: true, useSidebar: false });
  });
  it('falls back to dropdown when the sidebar is hidden and no mode is forced', () => {
    expect(resolveTeamPickerMode(false, undefined)).toEqual({ useDropdown: true, useSidebar: false });
  });
  it('keeps sidebar when explicitly requested even with showTeamSidebar false', () => {
    expect(resolveTeamPickerMode(false, 'sidebar')).toEqual({ useDropdown: false, useSidebar: false });
  });
});

describe('describeStrongestEvents', () => {
  it('ranks by quality against the published standard when a division is known', () => {
    const profile: AthleteEventProfile = {
      bestByEvent: {},
      extractedByEvent: {},
      primaryEvents: ['Event 1 Men 50 Yard Freestyle'],
      relayEvents: [],
      rankingDivision: 'D2',
      qualityByEvent: { 'Event 1 Men 50 Yard Freestyle': 0.92 },
    } as unknown as AthleteEventProfile;
    const text = describeStrongestEvents(profile);
    expect(text).toContain('published D2 standard');
    expect(text).toContain('92.0% of the standard');
  });

  it('says the division is unknown and lists unranked events when there is no standard', () => {
    const profile: AthleteEventProfile = {
      bestByEvent: {},
      extractedByEvent: {},
      primaryEvents: ['Event 1 Men 50 Yard Freestyle'],
      relayEvents: [],
      unrankedEvents: ['Event 1 Men 50 Yard Freestyle'],
    } as unknown as AthleteEventProfile;
    const text = describeStrongestEvents(profile);
    expect(text).toContain('Division unknown');
    expect(text).toContain('No published standard to judge');
  });
});

describe('buildRosterRowViewModel', () => {
  const row: ScorerRosterRow = {
    key: 'k1',
    name: 'Avery Henke',
    team: 'Henderson State University',
    gender: Gender.MEN,
    classYear: 'JR',
    athleteRole: 'swimmer',
    isScorer: true,
    source: 'auto',
  };

  it('reads meet points from the pointTotals map keyed by row.key', () => {
    const vm = buildRosterRowViewModel(row, {
      genderResults: [],
      gender: Gender.MEN,
      aliasResolver: buildAliasResolver([]),
      settings: NSISC_PRESET_SETTINGS,
      hasSelectedTeam: true,
      mergedAthleteHistory: [],
      pointTotals: new Map([['k1', 12]]),
    });
    expect(vm.meetPts).toBe(12);
    expect(vm.profile).toBeNull(); // no workspace passed
  });

  it('only builds a profile when both a workspace and hasSelectedTeam are given', () => {
    const workspace: Workspace = {
      id: 'w1',
      name: 'w',
      menResults: [],
      womenResults: [],
      recruits: [],
      createdAt: 0,
    };
    const withoutSelectedTeam = buildRosterRowViewModel(row, {
      genderResults: [],
      gender: Gender.MEN,
      aliasResolver: buildAliasResolver([]),
      settings: NSISC_PRESET_SETTINGS,
      workspace,
      hasSelectedTeam: false,
      mergedAthleteHistory: [],
      pointTotals: new Map(),
    });
    expect(withoutSelectedTeam.profile).toBeNull();

    const withSelectedTeam = buildRosterRowViewModel(row, {
      genderResults: [],
      gender: Gender.MEN,
      aliasResolver: buildAliasResolver([]),
      settings: NSISC_PRESET_SETTINGS,
      workspace,
      hasSelectedTeam: true,
      mergedAthleteHistory: [],
      pointTotals: new Map(),
    });
    expect(withSelectedTeam.profile).not.toBeNull();
  });

  it('surfaces an audit issue as a warning label', () => {
    const vm = buildRosterRowViewModel(row, {
      genderResults: [],
      gender: Gender.MEN,
      aliasResolver: buildAliasResolver([]),
      settings: NSISC_PRESET_SETTINGS,
      hasSelectedTeam: true,
      mergedAthleteHistory: [],
      pointTotals: new Map(),
      lineupAudit: {
        athleteIssues: new Map([
          ['avery henke', [{ type: 'empty_lineup', message: 'No individual entries' }]],
        ]),
      } as never,
    });
    expect(vm.warningLabel).toBe('Empty lineup');
    expect(vm.warningMessages).toContain('Scorer with no individual entries');
  });
});
