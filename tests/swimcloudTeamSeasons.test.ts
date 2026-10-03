/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/swimcloud/src/teamSeasons.ts` tests.
 *
 * ## Fixtures
 *
 * The four HTML files in `tests/fixtures/swimcloud/team-*-roster-gender-*-season-form.html`
 * are byte-exact slices of one element in four real pages: the roster filter
 * `<form>` of the SwimCloud pages captured on 2026-09-22 for team 412 and team
 * 10002824 (both genders). Nothing in them was written or edited by hand. The
 * source captures live in the git-ignored `data/swimcloud-captures/pages/`, so
 * the slice is what CI can read. The slice holds no login form and no CSRF token.
 *
 * Tests that need a broken page start from the real slice and change one thing
 * with `replace`. They never write an `<option>` list by hand.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  TeamSeasonParseError,
  hasTeamSeasonOptionShape,
  parseTeamSeasonOptions,
  resolveSeasonOption,
  type TeamSeasonOption,
  type TeamSeasonParseErrorCode,
} from '../packages/swimcloud/src/teamSeasons';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'swimcloud');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

const TEAM_412_F = fixture('team-412-roster-gender-F-season-form.html');
const TEAM_412_M = fixture('team-412-roster-gender-M-season-form.html');
const TEAM_10002824_F = fixture('team-10002824-roster-gender-F-season-form.html');
const TEAM_10002824_M = fixture('team-10002824-roster-gender-M-season-form.html');

/** What the real page prints, as data: `[value, label]` in page order. The source of truth for this file. */
const REAL_TABLE: readonly (readonly [string, string])[] = [
  ['30', '2026-2027'],
  ['29', '2025-2026'],
  ['28', '2024-2025'],
  ['27', '2023-2024'],
  ['26', '2022-2023'],
  ['25', '2021-2022'],
  ['24', '2020-2021'],
  ['23', '2019-2020'],
  ['22', '2018-2019'],
  ['21', '2017-2018'],
  ['20', '2016-2017'],
  ['19', '2015-2016'],
  ['18', '2014-2015'],
  ['17', '2013-2014'],
  ['16', '2012-2013'],
  ['15', '2011-2012'],
  ['14', '2010-2011'],
  ['13', '2009-2010'],
  ['12', '2008-2009'],
];

function codeOf(run: () => unknown): TeamSeasonParseErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof TeamSeasonParseError) return error.code;
    throw error;
  }
  throw new Error('expected parseTeamSeasonOptions to throw');
}

function table(options: readonly TeamSeasonOption[]): (readonly [string, string])[] {
  return options.map((o) => [o.seasonId, o.label] as const);
}

describe('parseTeamSeasonOptions on the real team 412 roster form', () => {
  const options = parseTeamSeasonOptions(TEAM_412_F);

  it('returns every season the page prints, in page order, with the id verbatim', () => {
    expect(table(options)).toStrictEqual(REAL_TABLE);
  });

  it('does not return the "All Seasons" option, which has an empty value', () => {
    expect(TEAM_412_F).toContain('----- All Seasons -----');
    expect(options.some((o) => o.label.includes('All Seasons'))).toBe(false);
    expect(options.some((o) => o.seasonId === '')).toBe(false);
  });

  it('marks only the option the page marked selected (2025-2026, not the newest)', () => {
    expect(options.filter((o) => o.selected).map((o) => o.seasonId)).toStrictEqual(['29']);
    expect(options[0].selected).toBe(false);
  });

  it('reads start and end years from the label, with end = start + 1', () => {
    const season = resolveSeasonOption(options, '2025-2026');
    expect(season).toMatchObject({ seasonId: '29', label: '2025-2026', startYear: 2025, endYear: 2026, selected: true });
    expect(options.every((o) => o.endYear === o.startYear + 1)).toBe(true);
  });

  it('keeps ids as strings of digits', () => {
    expect(options.every((o) => typeof o.seasonId === 'string' && /^[0-9]+$/.test(o.seasonId))).toBe(true);
  });
});

describe('the id is never computed from the label', () => {
  it('returns whatever value the page prints, even when it breaks the usual pattern', () => {
    // Start from the real slice and re-number two options. A parser that offset
    // an id from the label, or from the first option, would not return these.
    const renumbered = TEAM_412_F.replace('<option value="29" selected>', '<option value="777" selected>').replace(
      '<option value="28">',
      '<option value="5">',
    );
    const options = parseTeamSeasonOptions(renumbered);
    expect(resolveSeasonOption(options, '2025-2026')?.seasonId).toBe('777');
    expect(resolveSeasonOption(options, '2024-2025')?.seasonId).toBe('5');
    expect(resolveSeasonOption(options, '2026-2027')?.seasonId).toBe('30');
  });

  it('keeps the order the page lists the options in, and does not sort by id', () => {
    const reversedFirstTwo = TEAM_412_F.replace('<option value="30">2026-2027</option>', '<option value="30">TMP</option>')
      .replace('<option value="29" selected>2025-2026</option>', '<option value="30">2026-2027</option>')
      .replace('<option value="30">TMP</option>', '<option value="29" selected>2025-2026</option>');
    const options = parseTeamSeasonOptions(reversedFirstTwo);
    expect(options.slice(0, 2).map((o) => o.seasonId)).toStrictEqual(['29', '30']);
    expect(options.slice(0, 2).map((o) => o.label)).toStrictEqual(['2025-2026', '2026-2027']);
    expect(options.find((o) => o.selected)?.seasonId).toBe('29');
  });

  it('accepts the select with its attributes in the other order', () => {
    const swapped = TEAM_412_F.replace(
      '<select name="season_id" class=" form-control" id="id_season_id">',
      '<select id="id_season_id" class=" form-control" name="season_id">',
    );
    expect(swapped).not.toBe(TEAM_412_F);
    expect(table(parseTeamSeasonOptions(swapped))).toStrictEqual(REAL_TABLE);
  });
});

describe('season tables of team 412 and team 10002824, recorded as data', () => {
  /**
   * Observed 2026-10-03 on the four captured roster pages. This is a record of
   * two teams, not a proof about SwimCloud: two teams agreeing says nothing
   * about a third. The API therefore still makes every caller resolve a season
   * from each team's own page.
   */
  const OBSERVED = {
    teamsCompared: ['412', '10002824'],
    gendersCompared: ['F', 'M'],
    optionCountPerPage: 19,
    allFourPagesIdentical: true,
    selectedSeasonIdOnEveryPage: '29',
  } as const;

  const pages = {
    '412 F': parseTeamSeasonOptions(TEAM_412_F),
    '412 M': parseTeamSeasonOptions(TEAM_412_M),
    '10002824 F': parseTeamSeasonOptions(TEAM_10002824_F),
    '10002824 M': parseTeamSeasonOptions(TEAM_10002824_M),
  };

  it('matches the recorded observation', () => {
    const tables = Object.values(pages).map((options) => JSON.stringify(table(options)));
    const selected = Object.values(pages).map((options) => options.find((o) => o.selected)?.seasonId);
    const observedNow = {
      teamsCompared: ['412', '10002824'],
      gendersCompared: ['F', 'M'],
      optionCountPerPage: new Set(Object.values(pages).map((o) => o.length)).size === 1 ? pages['412 F'].length : -1,
      allFourPagesIdentical: new Set(tables).size === 1,
      selectedSeasonIdOnEveryPage: new Set(selected).size === 1 ? selected[0] : 'differs',
    };
    expect(observedNow).toStrictEqual(OBSERVED);
  });

  it('team 10002824 has the same id-to-label table as team 412', () => {
    expect(table(pages['10002824 F'])).toStrictEqual(table(pages['412 F']));
    expect(table(pages['10002824 F'])).toStrictEqual(REAL_TABLE);
  });

  it('a caller resolves per team: the same label resolves from each team\'s own options', () => {
    const own412 = resolveSeasonOption(pages['412 F'], '2024-2025');
    const own10002824 = resolveSeasonOption(pages['10002824 F'], '2024-2025');
    expect(own412?.seasonId).toBe('28');
    expect(own10002824?.seasonId).toBe('28');
    // Equal values, separate objects: nothing shares one team's option with another.
    expect(own412).not.toBe(own10002824);
  });
});

describe('parseTeamSeasonOptions fails loudly', () => {
  it('throws when the page has no season select', () => {
    const withoutSelect = TEAM_412_F.replace(/<select name="season_id"[\s\S]*?<\/select>/, '');
    expect(withoutSelect).not.toContain('name="season_id"');
    expect(codeOf(() => parseTeamSeasonOptions(withoutSelect))).toBe('season-select-missing');
    expect(codeOf(() => parseTeamSeasonOptions(''))).toBe('season-select-missing');
  });

  it('throws when a label is not YYYY-YYYY', () => {
    const bad = TEAM_412_F.replace('<option value="28">2024-2025</option>', '<option value="28">Spring 2025</option>');
    expect(codeOf(() => parseTeamSeasonOptions(bad))).toBe('season-label-invalid');
    const short = TEAM_412_F.replace('<option value="28">2024-2025</option>', '<option value="28">2024-25</option>');
    expect(codeOf(() => parseTeamSeasonOptions(short))).toBe('season-label-invalid');
  });

  it('throws when the end year is not the start year plus one', () => {
    const bad = TEAM_412_F.replace('2024-2025', '2024-2026');
    expect(codeOf(() => parseTeamSeasonOptions(bad))).toBe('season-label-invalid');
    const same = TEAM_412_F.replace('2024-2025', '2024-2024');
    expect(codeOf(() => parseTeamSeasonOptions(same))).toBe('season-label-invalid');
  });

  it('throws when a season option carries an empty or non-digit id', () => {
    const letters = TEAM_412_F.replace('<option value="28">', '<option value="28a">');
    expect(codeOf(() => parseTeamSeasonOptions(letters))).toBe('season-id-invalid');
    const urlBreaker = TEAM_412_F.replace('<option value="28">', '<option value="28&amp;sort=perf">');
    expect(codeOf(() => parseTeamSeasonOptions(urlBreaker))).toBe('season-id-invalid');
  });

  it('throws when an option has no value attribute', () => {
    const bad = TEAM_412_F.replace('<option value="28">', '<option>');
    expect(codeOf(() => parseTeamSeasonOptions(bad))).toBe('option-value-missing');
  });

  it('throws on a select that holds only "All Seasons"', () => {
    const onlyAll = TEAM_412_F.replace(/<option value="[0-9]+"[^>]*>[0-9-]+<\/option>/g, '');
    expect(onlyAll).toContain('----- All Seasons -----');
    expect(codeOf(() => parseTeamSeasonOptions(onlyAll))).toBe('no-season-options');
  });

  it('throws on a repeated id or a repeated label', () => {
    const sameId = TEAM_412_F.replace('<option value="28">', '<option value="29">');
    expect(codeOf(() => parseTeamSeasonOptions(sameId))).toBe('season-duplicate');
    const sameLabel = TEAM_412_F.replace('2024-2025', '2025-2026');
    expect(codeOf(() => parseTeamSeasonOptions(sameLabel))).toBe('season-duplicate');
  });

  it('throws when two season selects make the team\'s own table ambiguous', () => {
    expect(codeOf(() => parseTeamSeasonOptions(TEAM_412_F + TEAM_412_M))).toBe('season-select-ambiguous');
  });

  it('throws when more than one option is selected', () => {
    const two = TEAM_412_F.replace('<option value="28">', '<option value="28" selected>');
    expect(codeOf(() => parseTeamSeasonOptions(two))).toBe('season-selected-ambiguous');
  });

  it('does not read "selected" out of text inside a value', () => {
    const tricky = TEAM_412_F.replace('<option value="28">', '<option value="28" data-x="a selected b">');
    const options = parseTeamSeasonOptions(tricky);
    expect(resolveSeasonOption(options, '2024-2025')?.selected).toBe(false);
  });
});

describe('resolveSeasonOption', () => {
  const options = parseTeamSeasonOptions(TEAM_412_F);

  it('returns the option with exactly that label', () => {
    expect(resolveSeasonOption(options, '2026-2027')?.seasonId).toBe('30');
    expect(resolveSeasonOption(options, '2008-2009')?.seasonId).toBe('12');
  });

  it('returns undefined, not an error and not a nearby season, for a label the page does not offer', () => {
    expect(resolveSeasonOption(options, '2027-2028')).toBeUndefined();
    expect(resolveSeasonOption(options, '2007-2008')).toBeUndefined();
    expect(resolveSeasonOption(options, '2025-26')).toBeUndefined();
    expect(resolveSeasonOption(options, ' 2025-2026')).toBeUndefined();
    expect(resolveSeasonOption(options, '')).toBeUndefined();
    expect(resolveSeasonOption([], '2025-2026')).toBeUndefined();
  });
});

describe('hasTeamSeasonOptionShape', () => {
  const real = parseTeamSeasonOptions(TEAM_412_F)[1];

  it('accepts a parsed option, also after a JSON round trip', () => {
    expect(hasTeamSeasonOptionShape(real)).toBe(true);
    expect(hasTeamSeasonOptionShape(JSON.parse(JSON.stringify(real)))).toBe(true);
  });

  it('rejects a bare string, a missing field, a bad id and a label that disagrees with its years', () => {
    expect(hasTeamSeasonOptionShape('29')).toBe(false);
    expect(hasTeamSeasonOptionShape(null)).toBe(false);
    expect(hasTeamSeasonOptionShape({ seasonId: '29', label: '2025-2026' })).toBe(false);
    expect(hasTeamSeasonOptionShape({ ...real, seasonId: '' })).toBe(false);
    expect(hasTeamSeasonOptionShape({ ...real, seasonId: '29&sort=perf' })).toBe(false);
    expect(hasTeamSeasonOptionShape({ ...real, startYear: 2024 })).toBe(false);
    expect(hasTeamSeasonOptionShape({ ...real, label: '2025-2027', endYear: 2027 })).toBe(false);
  });
});

describe('attribute names are anchored and comments are not content', () => {
  const FIRST = '<option value="30">2026-2027</option>';
  const SELECT_OPEN = '<select name="season_id" class=" form-control" id="id_season_id">';

  it('reads `value`, not `data-value`, even when data-value comes first', () => {
    expect(TEAM_412_F).toContain(FIRST);
    const tricked = TEAM_412_F.replace(FIRST, '<option data-value="31" value="30">2026-2027</option>');
    expect(table(parseTeamSeasonOptions(tricked))).toStrictEqual(REAL_TABLE);
  });

  it('does not read `value` from inside another attribute\'s quoted text', () => {
    const tricked = TEAM_412_F.replace(FIRST, '<option title=" value=\'31\' " value="30">2026-2027</option>');
    expect(table(parseTeamSeasonOptions(tricked))).toStrictEqual(REAL_TABLE);
  });

  it('an option that has only `data-value` has no value attribute', () => {
    const bad = TEAM_412_F.replace(FIRST, '<option data-value="30">2026-2027</option>');
    expect(codeOf(() => parseTeamSeasonOptions(bad))).toBe('option-value-missing');
  });

  it('ignores an <option> inside an HTML comment in the select', () => {
    expect(TEAM_412_F).toContain(FIRST);
    const commented = TEAM_412_F.replace(FIRST, `<!-- <option value="31">2027-2028</option> -->\n${FIRST}`);
    expect(table(parseTeamSeasonOptions(commented))).toStrictEqual(REAL_TABLE);
  });

  it('ignores a whole commented-out second season select, so the page is not ambiguous', () => {
    const commented = `<!-- ${SELECT_OPEN}<option value="5">2000-2001</option></select> -->${TEAM_412_F}`;
    expect(table(parseTeamSeasonOptions(commented))).toStrictEqual(REAL_TABLE);
  });

  it('a page whose only season select is commented out has no season select', () => {
    const onlyComment = `<!-- ${TEAM_412_F} -->`;
    expect(codeOf(() => parseTeamSeasonOptions(onlyComment))).toBe('season-select-missing');
  });

  it('matches `name`, not `data-name`', () => {
    const dataOnly = TEAM_412_F.replace(SELECT_OPEN, '<select data-name="season_id" class=" form-control">');
    expect(dataOnly).not.toBe(TEAM_412_F);
    expect(codeOf(() => parseTeamSeasonOptions(dataOnly))).toBe('season-select-missing');
  });

  it('a `data-name="season_id"` select beside the real one does not make the page ambiguous', () => {
    const extra = '<select data-name="season_id"><option value="5">2000-2001</option></select>';
    expect(table(parseTeamSeasonOptions(extra + TEAM_412_F))).toStrictEqual(REAL_TABLE);
  });
});
