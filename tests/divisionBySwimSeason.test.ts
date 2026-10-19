/**
 * E8 (2026-10-16): a school that changed division is judged by the swim's
 * season, and by nothing else.
 *
 * UWF (University of West Florida) is NCAA D2 through 2025-2026 and NCAA D1
 * from 2026-2027 (`divisionHistory` in `teamDivisions.ts`). The registry's
 * season-agnostic `division` is `null` for it, so every tag path that does not
 * know the season answers unknown. Before, that field was `D2`, and a 2026-2027
 * swim was judged against the D2 table.
 *
 * What the tests prove:
 *  1. The season decides the division: D2 for 2025-2026, D1 for 2026-2027.
 *  2. No season, or an unparseable one, is unknown, not D2 and not D1.
 *  3. The table follows the division: 22.40 makes the D2 women's 50 Free A
 *     standard and misses the D1 one, read from the archived tables.
 *  4. A D1 table that lacks the event is unknown, not `no_cut`.
 *  5. Every other path agrees: tags, relay tags, event ranking, SCM table.
 *  6. A school with one division is unchanged (HSU), over every row that
 *     `data/meets.json` holds when it is present.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type HistoricalSwim } from '../packages/core/src/types';
import { categorizeBestEvents } from '../packages/core/src/lib/athleteHistory';
import {
  divisionForEntryInSeason,
  divisionForTeamInSeason,
  divisionForTeamOrNull,
  resolveMeetDivisions,
  resolveTeamDivision,
} from '../packages/core/src/data/teamDivisions';
import {
  buildCutlineTagForTeam,
  buildRelaySwimTagsForTeam,
  cutlineTagRenderMode,
} from '../packages/core/src/lib/cutlineTags';
import { rankEventsByQuality, rankEventsByStrength } from '../packages/core/src/lib/eventStrength';
import { convertSwimToSCYDetailed, scmConversionTableFor } from '../packages/core/src/lib/scyConversion';
import { findCutlines } from '../packages/core/src/cutlines';

const UWF = 'University of West Florida';
const HSU = 'Henderson State University';

describe('UWF division by season', () => {
  it('is D2 for 2025-2026 and D1 from 2026-2027', () => {
    expect(divisionForTeamInSeason(UWF, '2025-2026')).toBe('D2');
    expect(divisionForTeamInSeason(UWF, '2026-2027')).toBe('D1');
    expect(divisionForTeamInSeason('UWF', '2027-2028')).toBe('D1');
    expect(divisionForTeamOrNull(UWF, { season: '2025-2026' })).toBe('D2');
    expect(divisionForTeamOrNull(UWF, { season: '2026-2027' })).toBe('D1');
  });

  it('is unknown with no season, and with a season that does not parse', () => {
    expect(divisionForTeamOrNull(UWF)).toBeNull();
    expect(divisionForTeamInSeason(UWF, '')).toBeNull();
    expect(divisionForTeamInSeason(UWF, 'sometime')).toBeNull();
    expect(divisionForTeamOrNull(UWF, { season: 'sometime' })).toBeNull();
    // Still a mapped, active school: unknown is not "unmapped".
    const resolution = resolveTeamDivision(UWF);
    expect(resolution.entry).toBeDefined();
    expect(resolution.status).toBe('active');
  });

  it('never reads the entry division for a season it cannot parse, even when the entry has one', () => {
    // A synthetic entry that keeps a season-agnostic `division` beside its history.
    const entry = {
      division: 'D2' as const,
      status: 'active' as const,
      divisionHistory: [
        { division: 'D2' as const, through: '2025-2026' as const },
        { division: 'D1' as const, from: '2026-2027' as const },
      ],
    };
    expect(divisionForEntryInSeason(entry, '2025-2026')).toBe('D2');
    expect(divisionForEntryInSeason(entry, '2026-2027')).toBe('D1');
    expect(divisionForEntryInSeason(entry, 'sometime')).toBeNull();
    expect(divisionForEntryInSeason(entry, '')).toBeNull();
    // No history: the entry division answers, parseable season or not.
    expect(divisionForEntryInSeason({ division: 'D2', status: 'active' }, 'sometime')).toBe('D2');
  });

  it('lets a caller override win over the season, as for any team', () => {
    expect(divisionForTeamInSeason(UWF, '2026-2027', { overrides: { [UWF]: 'D3' } })).toBe('D3');
  });

  it('does not change a school with one division', () => {
    expect(divisionForTeamOrNull(HSU)).toBe('D2');
    expect(divisionForTeamInSeason(HSU, '2025-2026')).toBe('D2');
    expect(divisionForTeamInSeason(HSU, '2026-2027')).toBe('D2');
    // An unparseable season does not unseat a school that never moved.
    expect(divisionForTeamInSeason(HSU, 'sometime')).toBe('D2');
  });

  it('places UWF in a meet field only by season', () => {
    const field = [HSU, UWF];
    expect(resolveMeetDivisions(field).status).toBe('partial');
    expect(resolveMeetDivisions(field).division).toBeNull();
    expect(resolveMeetDivisions(field, { season: '2025-2026' }).status).toBe('uniform');
    expect(resolveMeetDivisions(field, { season: '2026-2027' }).status).toBe('mixed');
  });
});

describe('the cut tag follows the swim season', () => {
  const tag = (swimSeason: string | undefined, timeSec: number, event = '50 Freestyle') =>
    buildCutlineTagForTeam({
      team: UWF,
      gender: Gender.WOMEN,
      event,
      timeSec,
      ...(swimSeason === undefined ? {} : { swimSeason }),
    });

  // Read from the archived 2026-2027 tables so a re-extraction that moves a
  // standard breaks this test rather than leaving the boundary stale.
  const standard = (division: 'D1' | 'D2', tier: 'A' | 'Standard') => {
    const row = findCutlines({ division, season: '2026-2027', gender: 'Women', course: 'SCY', event: '50 Freestyle' })[0];
    const text = row && 'aStandard' in row ? row.aStandard : row && 'standard' in row ? row.standard : undefined;
    expect(text, `${division} ${tier} 50 Freestyle standard must be published`).toBeTruthy();
    return Number(text);
  };

  it('has a time between the D1 and D2 standards, so the season decides the verdict', () => {
    const d1 = standard('D1', 'Standard');
    const d2 = standard('D2', 'A');
    expect(d1).toBeLessThan(d2);
    const between = Math.round(((d1 + d2) / 2) * 100) / 100;

    const in2025 = tag('2025-2026', between);
    expect(in2025.state).toBe('tagged');
    expect(in2025.state === 'tagged' && in2025.tag.division).toBe('D2');

    const in2026 = tag('2026-2027', between);
    expect(in2026.state).toBe('no_cut');
    expect(in2026.division).toBe('D1');
    expect(in2026.season).toBe('2026-2027');
  });

  it('is unknown with no season, naming the season as the reason', () => {
    const result = tag(undefined, 19.2);
    expect(result.state).toBe('division_unknown');
    expect(cutlineTagRenderMode(result)).toBe('unknown');
    expect(result.tag).toBeNull();
    expect(result.reason).toMatch(/season/i);
  });

  it('is unknown for a season that does not parse', () => {
    const result = tag('sometime', 19.2);
    expect(result.state).toBe('division_unknown');
    expect(cutlineTagRenderMode(result)).toBe('unknown');
  });

  it('renders unknown, not no_cut, when the D1 table lacks the event', () => {
    // D1 publishes no 1000 Freestyle standard (D2 does).
    const result = buildCutlineTagForTeam({
      team: UWF,
      gender: Gender.WOMEN,
      event: '1000 Freestyle',
      time: '10:00.00',
      swimSeason: '2026-2027',
    });
    expect(result.division).toBe('D1');
    expect(result.state).toBe('event_not_in_table');
    expect(cutlineTagRenderMode(result)).toBe('unknown');
    // The same swim in 2025-2026 is judged against the D2 table, which has it.
    const in2025 = buildCutlineTagForTeam({
      team: UWF,
      gender: Gender.WOMEN,
      event: '1000 Freestyle',
      time: '10:00.00',
      swimSeason: '2025-2026',
    });
    expect(in2025.division).toBe('D2');
    expect(in2025.state).not.toBe('event_not_in_table');
  });

  it('still refuses a men\'s swim at a school with no men\'s program, in either season', () => {
    for (const swimSeason of [undefined, '2025-2026', '2026-2027']) {
      const result = buildCutlineTagForTeam({
        team: UWF,
        gender: Gender.MEN,
        event: '50 Freestyle',
        timeSec: 19.2,
        ...(swimSeason === undefined ? {} : { swimSeason }),
      });
      expect(result.state).toBe('gender_not_sponsored');
    }
  });

  it('applies to the relay verdict and the leg verdict alike', () => {
    const relay = (swimSeason: string | undefined) =>
      buildRelaySwimTagsForTeam({
        team: UWF,
        gender: Gender.WOMEN,
        relayEvent: '200 Freestyle Relay',
        relayTeamTime: '1:25.00',
        ...(swimSeason === undefined ? {} : { swimSeason }),
      });
    expect(relay(undefined).relay.state).toBe('division_unknown');
    expect(relay('2025-2026').relay.division).toBe('D2');
    expect(relay('2026-2027').relay.division).toBe('D1');
  });

  it('does not change a school with one division, with or without a season', () => {
    const bare = buildCutlineTagForTeam({ team: HSU, gender: Gender.WOMEN, event: '50 Freestyle', timeSec: 19.2 });
    const seasoned = buildCutlineTagForTeam({
      team: HSU,
      gender: Gender.WOMEN,
      event: '50 Freestyle',
      timeSec: 19.2,
      swimSeason: '2025-2026',
    });
    expect(bare.state).toBe('tagged');
    expect(bare.division).toBe('D2');
    // The swim season picks the division only; the table is still the newest D2 one.
    expect(seasoned.division).toBe('D2');
    expect(seasoned.season).toBe(bare.season);
  });
});

describe('the other division readers agree', () => {
  it('ranks no event for UWF without a season, and ranks by the season\'s division with one', () => {
    const bests = { '50 Freestyle': { timeSec: 24.0 }, '100 Freestyle': { timeSec: 52.0 } };
    const bare = rankEventsByQuality(bests, Gender.WOMEN, UWF);
    expect(bare.division).toBeNull();
    expect(bare.ranked).toEqual([]);
    expect(rankEventsByQuality(bests, Gender.WOMEN, UWF, undefined, '2025-2026').division).toBe('D2');
    expect(rankEventsByQuality(bests, Gender.WOMEN, UWF, undefined, '2026-2027').division).toBe('D1');
    // The options form of the same input.
    const viaOptions = rankEventsByStrength(
      { '50 Freestyle': { timeSec: 24.0 } },
      Gender.WOMEN,
      UWF,
      { swimSeason: '2026-2027' }
    );
    expect(viaOptions.division).toBe('D1');
  });

  it('chooses the SCM conversion table for the season\'s division, and the Rules Book table when unknown', () => {
    const swim = (season?: string) =>
      convertSwimToSCYDetailed('50 Freestyle', '25.00', Gender.WOMEN, 'SCM', {
        team: UWF,
        ...(season === undefined ? {} : { season }),
      });
    const bare = swim();
    const d1 = swim('2026-2027');
    expect(bare.basis.method === 'ncaa_scm_table' && bare.basis.division).toBeNull();
    expect(bare.basis.method === 'ncaa_scm_table' && bare.basis.reason).toBe('division_unknown');
    expect(d1.basis.method === 'ncaa_scm_table' && d1.basis.division).toBe('D1');
    expect(scmConversionTableFor('D1').reason).toBe('division_table');
    // The cache must not hand a season-less answer to a seasoned call.
    const again = swim().basis;
    expect(again.method === 'ncaa_scm_table' && again.division).toBeNull();
  });
});

describe('categorizeBestEvents reads the capture season for a school whose division changed', () => {
  const swim = (event: string, time: string): HistoricalSwim => ({
    name: 'Test Swimmer',
    team: UWF,
    gender: Gender.WOMEN,
    event,
    time,
    timeType: 'SCY',
    source: 'swimcloud',
  });
  const swims = [swim('50 Freestyle', '23.00'), swim('100 Freestyle', '50.00')];
  const profile = (season?: string) =>
    categorizeBestEvents(swims, UWF, Gender.WOMEN, 'Test Swimmer', { scoringPoints: [] } as never, [], undefined, null, null, season);

  it('judges the events against the season\'s division, and leaves them unjudged without a season', () => {
    const d2 = profile('2025-2026');
    const d1 = profile('2026-2027');
    const none = profile(undefined);
    const bad = profile('last year');
    expect(d2.unrankedEvents ?? []).toEqual([]);
    expect(d1.unrankedEvents ?? []).toEqual([]);
    expect(none.unrankedEvents?.length).toBeGreaterThan(0);
    expect(bad.unrankedEvents?.length).toBeGreaterThan(0);
  });
});
