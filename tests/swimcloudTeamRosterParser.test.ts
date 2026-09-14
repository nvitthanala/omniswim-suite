/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `parseTeamRosterHtml` against **real** SwimCloud markup.
 *
 * Both fixtures are pages SwimCloud actually served on 2026-09-09 — Henderson
 * State's men's and women's rosters, captured through the browser extension and
 * archived with their provenance in each file's own header comment. They
 * resolved OQ-3 ("real roster page markup") in
 * `docs/reference/SWIMCLOUD_CAPTURE_STATE.json`.
 *
 * Every value asserted here is a value on that page. The row counts (35 and 16)
 * and the spot-checked rows are snapshots of the source, so a SwimCloud layout
 * change or a parser regression breaks CI instead of quietly returning a
 * shorter roster. A silently short roster is the exact failure mode `CLAUDE.md`
 * calls out: it reads as "that's the whole team", not as an error.
 *
 * The synthetic-fixture cases for this parser live in
 * `tests/swimcloudParser.test.ts` and cover the branches these real pages do
 * not reach — a missing table, a page with no season card, a caller supplying
 * gender and season.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTeamRosterHtml, type SwimCloudParseContext } from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

const MEN_HTML = fixture('swimcloud-real-team-roster-58-gender-m.html');
const WOMEN_HTML = fixture('swimcloud-real-team-roster-58-gender-f.html');

/** The real capture URLs, verbatim from the fixtures' provenance headers. */
const MEN_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=29&sort=name',
  retrievedAt: '2026-09-09T02:08:38.793Z',
  track: 'browser-extension',
};

const WOMEN_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/team/58/roster/?page=1&gender=F&season_id=29&sort=name',
  retrievedAt: '2026-09-09T02:08:50.769Z',
  track: 'browser-extension',
};

function parseMen() {
  const result = parseTeamRosterHtml(MEN_HTML, MEN_CONTEXT);
  if (!result.ok) throw new Error(`expected success, got ${result.failure.code}: ${result.failure.message}`);
  return result;
}

function parseWomen() {
  const result = parseTeamRosterHtml(WOMEN_HTML, WOMEN_CONTEXT);
  if (!result.ok) throw new Error(`expected success, got ${result.failure.code}: ${result.failure.message}`);
  return result;
}

describe('parseTeamRosterHtml — real Henderson State roster captures', () => {
  it('walks the whole men\'s table: 35 rows, 35 athletes, no dropped row', () => {
    const { data } = parseMen();
    expect(data.rowCount).toBe(35);
    expect(data.athletes).toHaveLength(35);
  });

  it('walks the whole women\'s table: 16 rows, 16 athletes', () => {
    const { data } = parseWomen();
    expect(data.rowCount).toBe(16);
    expect(data.athletes).toHaveLength(16);
  });

  it('reads the team id from the capture URL and the name from the page title', () => {
    for (const parsed of [parseMen(), parseWomen()]) {
      expect(parsed.data.swimCloudTeamId).toBe('58');
      // <title>Roster - Henderson State University</title>; the "Roster - "
      // prefix is stripped, the school name is not truncated.
      expect(parsed.data.teamName).toBe('Henderson State University');
    }
  });

  it('reads gender from the page, not from the URL\'s ?gender= value', () => {
    const men = parseMen();
    expect(men.data.gender).toBe('Men');
    expect(men.data.genderSource).toBe('page');

    const women = parseWomen();
    expect(women.data.gender).toBe('Women');
    expect(women.data.genderSource).toBe('page');
  });

  it('extracts the season label from both pages\' own headings', () => {
    // "Season 2025-2026 Men" / "Season 2025-2026 Women".
    for (const parsed of [parseMen(), parseWomen()]) {
      expect(parsed.data.season).toBe('2025-2026');
      expect(parsed.data.seasonSource).toBe('page');
    }
  });

  it('builds the team record from page-stated facts alone, with no caller options', () => {
    expect(parseMen().data.team).toEqual({
      swimCloudTeamId: '58',
      gender: 'Men',
      name: 'Henderson State University',
      season: '2025-2026',
    });
  });

  it('spot-checks a real men\'s row end to end: Colin Candebat', () => {
    const { data } = parseMen();
    const colin = data.athletes.find((a) => a.name === 'Colin Candebat');
    expect(colin).toEqual({
      swimCloudSwimmerId: '1865160',
      name: 'Colin Candebat',
      swimCloudTeamId: '58',
      classYear: 'SO',
      gender: 'Men',
      season: '2025-2026',
      hometown: 'Norco, LA',
    });
  });

  it('spot-checks a real women\'s row end to end: Emma Crowe', () => {
    const { data } = parseWomen();
    const emma = data.athletes.find((a) => a.name === 'Emma Crowe');
    expect(emma).toEqual({
      swimCloudSwimmerId: '1828356',
      name: 'Emma Crowe',
      swimCloudTeamId: '58',
      classYear: 'SO',
      gender: 'Women',
      season: '2025-2026',
      hometown: 'Hot Springs National Park, AR',
    });
  });

  it('keeps a non-ASCII printed name exactly as printed', () => {
    // Row 24 of the men's table. Nothing folds the accents; a name is not
    // normalized on the way in.
    const olivér = parseMen().data.athletes.find((a) => a.swimCloudSwimmerId === '2253944');
    expect(olivér?.name).toBe('Olivér Pózvai');
  });

  it('reads every class year on the men\'s page into the known vocabulary', () => {
    const { data, warnings } = parseMen();
    expect(data.athletes.every((a) => a.classYear !== undefined)).toBe(true);
    expect(data.athletes.every((a) => a.classYear !== 'unknown')).toBe(true);
    expect(warnings.filter((w) => w.code === 'unmapped-class-year')).toHaveLength(0);
    // The real page's actual FR/SO/JR/SR split, snapshotted. Counted straight
    // out of the fixture's own `<td class="c-table-clean__col-fit">` cells, not
    // read back off the parser: 12 + 9 + 7 + 7 = 35, the full table.
    const counts = data.athletes.reduce<Record<string, number>>((acc, a) => {
      acc[String(a.classYear)] = (acc[String(a.classYear)] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ FR: 12, SO: 9, JR: 7, SR: 7 });
  });

  it('finds a /swimmer/{id} link on every real row', () => {
    for (const parsed of [parseMen(), parseWomen()]) {
      expect(parsed.data.athletes.every((a) => a.swimCloudSwimmerId !== undefined)).toBe(true);
      expect(parsed.warnings.filter((w) => w.code === 'missing-athlete-link')).toHaveLength(0);
    }
  });

  it('holds a bare country-code hometown apart from a real hometown, and never emits ""', () => {
    const { data } = parseMen();
    // "MEX" with no city — the cell SwimCloud prints for some international
    // swimmers. It is not a hometown, so `hometown` is absent, not "MEX" and
    // not "".
    const alan = data.athletes.find((a) => a.swimCloudSwimmerId === '1863744');
    expect(alan?.name).toBe('Alan Alejan Gonzalez Mujica');
    expect(alan?.hometown).toBeUndefined();
    expect(alan?.hometownCountryCode).toBe('MEX');

    // A city-bearing cell keeps the whole printed string and sets no code.
    const bartu = data.athletes.find((a) => a.swimCloudSwimmerId === '2352628');
    expect(bartu?.hometown).toBe('Mersin, TUR');
    expect(bartu?.hometownCountryCode).toBeUndefined();

    // Nothing anywhere is the empty string.
    expect(data.athletes.some((a) => a.hometown === '')).toBe(false);
  });

  it('holds "USA" apart on the women\'s page for the same reason', () => {
    const katie = parseWomen().data.athletes.find((a) => a.swimCloudSwimmerId === '2508045');
    expect(katie?.name).toBe('Katie Batts');
    expect(katie?.hometown).toBeUndefined();
    expect(katie?.hometownCountryCode).toBe('USA');
  });

  it('excludes the power index: no roster field carries 727.45', () => {
    // Every row links /swimmer/{id}/score/?season_id=… with a power-index
    // number. It is a computed rating, not a roster fact, and this parser
    // deliberately drops it rather than inventing a field for it.
    const serialized = JSON.stringify(parseMen().data);
    expect(serialized).not.toContain('727.45');
    expect(serialized).not.toContain('score/?season_id');
  });

  it('records no season_id anywhere in its output', () => {
    // The page filters by season_id=29 and publishes a whole id-to-label table.
    // Nothing here stores an id or reverses a label back into one.
    for (const parsed of [parseMen(), parseWomen()]) {
      const serialized = JSON.stringify(parsed.data);
      expect(serialized).not.toContain('season_id');
      expect(serialized).not.toContain('seasonId');
      expect(serialized).not.toContain('"29"');
    }
  });

  it('parses cleanly: the only warnings are ones a real page earns', () => {
    for (const parsed of [parseMen(), parseWomen()]) {
      expect(parsed.warnings).toStrictEqual([]);
    }
  });

  it('reports real-capture-verified confidence and the capture provenance', () => {
    const men = parseMen();
    expect(men.confidence).toBe('real-capture-verified');
    expect(men.provenance).toEqual({
      sourceUrl: MEN_CONTEXT.sourceUrl,
      retrievedAt: MEN_CONTEXT.retrievedAt,
      track: 'browser-extension',
    });
  });
});

describe('parseTeamRosterHtml — the page outranks a caller-supplied option', () => {
  it('keeps the page\'s gender and says the caller disagreed, rather than mislabelling 35 men', () => {
    const result = parseTeamRosterHtml(MEN_HTML, MEN_CONTEXT, { gender: 'Women' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.gender).toBe('Men');
    expect(result.data.genderSource).toBe('page');
    expect(result.data.athletes.every((a) => a.gender === 'Men')).toBe(true);

    const conflict = result.warnings.find((w) => w.code === 'contradicted-page-declaration');
    expect(conflict).toBeDefined();
    expect(conflict?.raw).toBe('Men vs Women');
  });

  it('keeps the page\'s season and flags a disagreeing option the same way', () => {
    const result = parseTeamRosterHtml(MEN_HTML, MEN_CONTEXT, { season: '2019-2020' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.season).toBe('2025-2026');
    expect(result.data.seasonSource).toBe('page');
    expect(result.warnings.map((w) => w.code)).toContain('contradicted-page-declaration');
  });

  it('stays silent when the caller-supplied values agree with the page', () => {
    const result = parseTeamRosterHtml(MEN_HTML, MEN_CONTEXT, {
      gender: 'Men',
      season: '2025-2026',
    });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.warnings).toStrictEqual([]);
  });
});

describe('parseTeamRosterHtml — season labels outside YYYY-YYYY', () => {
  it('reports an unfamiliar label verbatim and records no season, rather than reshaping it', () => {
    // The season filter's own option list includes labels like "2008 and
    // Under". If one of those ever reaches the card heading, the label is
    // surfaced and `season` stays absent — a season key is not worth guessing,
    // same rule as an unrecognized meet date.
    const html = MEN_HTML.replace('Season 2025-2026 Men', 'Season 2008 and Under Men');
    const result = parseTeamRosterHtml(html, MEN_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.season).toBeUndefined();
    expect(result.data.seasonSource).toBeUndefined();
    expect(result.data.gender).toBe('Men'); // the gender word is still read
    const warning = result.warnings.find((w) => w.code === 'unrecognized-season-label');
    expect(warning?.raw).toBe('2008 and Under');
  });

  it('still parses all 35 rows when the season label is unusable', () => {
    const html = MEN_HTML.replace('Season 2025-2026 Men', 'Season 2008 and Under Men');
    const result = parseTeamRosterHtml(html, MEN_CONTEXT);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.athletes).toHaveLength(35);
    expect(result.data.athletes.every((a) => a.season === undefined)).toBe(true);
  });
});

describe('parseTeamRosterHtml — the page contradicting itself', () => {
  it('keeps the heading\'s gender and warns when the filter form disagrees', () => {
    // Flip the men's page's checked radio onto the Women control, leaving the
    // heading and all 35 rows as they are. The heading governs the table, so it
    // wins — but a caller is told the page disagreed with itself.
    const html = MEN_HTML.replace(
      '<label for="F" class="btn btn-primary"><input type="radio" id="F" name="gender" value="F">Women</label>',
      '<label for="F" class="btn btn-primary active"><input type="radio" id="F" name="gender" value="F" checked="">Women</label>',
    ).replace(
      '<input type="radio" id="M" name="gender" value="M" checked="">Men',
      '<input type="radio" id="M" name="gender" value="M">Men',
    );
    expect(html).not.toBe(MEN_HTML); // the replacement actually matched

    const result = parseTeamRosterHtml(html, MEN_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.gender).toBe('Men');
    const conflict = result.warnings.find((w) => w.code === 'contradicted-page-declaration');
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain("filter form's checked control");
  });

  it('falls back to the filter form when the card heading names no gender', () => {
    const html = MEN_HTML.replace('Season 2025-2026 Men', 'Season 2025-2026');
    const result = parseTeamRosterHtml(html, MEN_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.gender).toBe('Men');
    expect(result.data.genderSource).toBe('page');
    expect(result.data.season).toBe('2025-2026');
  });
});

describe('parseTeamRosterHtml — absent is never empty, on a real page', () => {
  it('fails loudly when the real roster table is removed, instead of reporting an empty team', () => {
    const tableStart = MEN_HTML.indexOf('<table');
    const tableEnd = MEN_HTML.indexOf('</table>') + '</table>'.length;
    const html = MEN_HTML.slice(0, tableStart) + MEN_HTML.slice(tableEnd);

    const result = parseTeamRosterHtml(html, MEN_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure.code).toBe('expected-table-missing');
  });

  it('reports zero-data-rows when the real table exists and lists nobody', () => {
    const bodyStart = MEN_HTML.indexOf('<tbody>');
    const bodyEnd = MEN_HTML.indexOf('</tbody>') + '</tbody>'.length;
    const html = `${MEN_HTML.slice(0, bodyStart)}<tbody></tbody>${MEN_HTML.slice(bodyEnd)}`;

    const result = parseTeamRosterHtml(html, MEN_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.data.athletes).toStrictEqual([]);
    expect(result.data.rowCount).toBe(0);
    expect(result.warnings.map((w) => w.code)).toContain('zero-data-rows');
    // An empty roster still knows whose roster it is. That is what makes
    // "nobody is listed" distinguishable from "the parse failed".
    expect(result.data.teamName).toBe('Henderson State University');
    expect(result.data.gender).toBe('Men');
  });
});
