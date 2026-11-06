/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a (plans/2026-10-25/D7-DATA-SOURCING.md section 4): `readRosterFetch`.
 *
 * Fixtures. The REAL pages are the committed captures of 2026-09 (Henderson State 58, Ouachita 412, UWF 10002824), all season
 * 2025-2026 (option 29). D7's T-R1 numbers (42 members; FR 8, SO 12, JR 12, SR 7, 3 absent) describe a 2026-2027 page that was
 * never captured (D7 section 9: "fixtures stay synthetic until a capture is approved"), so no test here pins them. The counts
 * below are computed from the real files. Every `edit(...)` case below is the real page with ONE cell or tag changed. It is
 * SYNTHETIC and says so by name.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readRosterFetch, findRosterPagination } from '@omniswim/swimcloud/browser';
import type { RosterFetchOutcome, RosterFetchTarget } from '@omniswim/swimcloud/browser';
import { fetchPathFor } from '../apps/extension/src/shared/fetchProtocol';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const AT = '2026-11-06T00:00:00.000Z';

const REAL = {
  m58: { file: 'swimcloud-real-team-roster-58-gender-m.html', teamId: '58', gender: 'M' as const },
  f58: { file: 'swimcloud-real-team-roster-58-gender-f.html', teamId: '58', gender: 'F' as const },
  m412: { file: 'swimcloud/team-412-roster-gender-M-page.html', teamId: '412', gender: 'M' as const },
  f412: { file: 'swimcloud/team-412-roster-gender-F-page.html', teamId: '412', gender: 'F' as const },
  mUwf: { file: 'swimcloud/team-10002824-roster-gender-M-page.html', teamId: '10002824', gender: 'M' as const },
  fUwf: { file: 'swimcloud/team-10002824-roster-gender-F-page.html', teamId: '10002824', gender: 'F' as const },
};

const season2526: RosterFetchTarget['season'] = { kind: 'option', value: '29', label: '2025-2026' };
const targetOf = (r: { teamId: string; gender: 'M' | 'F' }, season: RosterFetchTarget['season'] = season2526): RosterFetchTarget => ({ teamId: r.teamId, gender: r.gender, season });

function readPage(html: string, target: RosterFetchTarget, over: Partial<{ requestedPath: string; finalPath: string; expectedSeasonLabel: string }> = {}): RosterFetchOutcome {
  const requestedPath = over.requestedPath ?? fetchPathFor({ kind: 'team-roster', ...target });
  return readRosterFetch(html, { target, requestedPath, finalPath: over.finalPath ?? requestedPath, fetchedAt: AT, ...(over.expectedSeasonLabel === undefined ? {} : { expectedSeasonLabel: over.expectedSeasonLabel }) });
}
const real = (r: keyof typeof REAL, season?: RosterFetchTarget['season']): RosterFetchOutcome => readPage(read(REAL[r].file), targetOf(REAL[r], season));

/** SYNTHETIC: the real page with the first occurrence of `from` replaced. Fails if `from` is not there, so an edit cannot silently do nothing. */
function edit(html: string, from: string | RegExp, to: string): string {
  const out = html.replace(from, to);
  expect(out, `the edit ${String(from)} matched nothing`).not.toBe(html);
  return out;
}
const refusedCode = (o: RosterFetchOutcome): string => (o.kind === 'refused' ? o.code : `not refused: ${o.kind}`);

function tally(ids: Readonly<Record<string, string>> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of Object.values(ids ?? {})) out[c] = (out[c] ?? 0) + 1;
  return out;
}

describe('T-R1 real pages: members', () => {
  it('Henderson State men 2025-2026: 35 members, class years as the file prints them', () => {
    const o = real('m58');
    if (o.kind !== 'members') throw new Error(`expected members, got ${o.kind}: ${JSON.stringify(o)}`);
    expect(o.teamId).toBe('58');
    expect(o.seasonLabel).toBe('2025-2026');
    expect(o.gender).toBe('Men');
    expect(o.memberIds).toHaveLength(35);
    expect(new Set(o.memberIds).size).toBe(35);
    expect(o.memberIds[0]).toBe('2352628'); // Bartu Akin, first row of the file
    expect(o.classYears?.['2352628']).toBe('FR');
    expect(o.classYears?.['1130590']).toBe('SR'); // Steven Balistreri, row 2
    expect(tally(o.classYears)).toEqual({ FR: 12, SO: 9, JR: 7, SR: 7 });
    expect(Object.keys(o.classYears ?? {}).length).toBe(35);
    expect(o.parser).toEqual({ name: 'readRosterFetch', confidence: 'real-capture-verified' });
  });

  it('each real members page keeps its own team, gender and class tally', () => {
    const expected: Record<string, [number, 'Men' | 'Women', Record<string, number>]> = {
      m58: [35, 'Men', { FR: 12, SO: 9, JR: 7, SR: 7 }],
      f58: [16, 'Women', { FR: 7, SO: 5, JR: 2, SR: 2 }],
      m412: [39, 'Men', { FR: 14, SO: 12, JR: 5, SR: 8 }],
      f412: [23, 'Women', { FR: 13, SO: 3, JR: 5, SR: 2 }],
      fUwf: [27, 'Women', { FR: 8, SO: 5, JR: 4, SR: 10 }],
    };
    for (const [key, [count, gender, classes]] of Object.entries(expected)) {
      const o = real(key as keyof typeof REAL);
      if (o.kind !== 'members') throw new Error(`${key}: expected members, got ${JSON.stringify(o)}`);
      expect(o.memberIds, key).toHaveLength(count);
      expect(o.gender, key).toBe(gender);
      expect(tally(o.classYears), key).toEqual(classes);
    }
  });

  it('a "-" or an empty Class cell is absent for that swimmer, and nothing else fills it (SYNTHETIC: two cells of the real page edited)', () => {
    let html = read(REAL.m58.file);
    html = edit(html, /(href="\/swimmer\/2352628">[^<]*<\/a><\/td><td[^>]*>[^<]*<\/td><td[^>]*>)FR/, '$1–'); // U+2013, as the live page prints it
    html = edit(html, /(href="\/swimmer\/1130590">[^<]*<\/a><\/td><td[^>]*>[^<]*<\/td><td[^>]*>)SR/, '$1');
    const o = readPage(html, targetOf(REAL.m58));
    if (o.kind !== 'members') throw new Error(JSON.stringify(o));
    expect(o.memberIds).toHaveLength(35);
    expect(o.memberIds).toContain('2352628');
    expect(Object.hasOwn(o.classYears ?? {}, '2352628')).toBe(false);
    expect(Object.hasOwn(o.classYears ?? {}, '1130590')).toBe(false);
    expect(tally(o.classYears)).toEqual({ FR: 11, SO: 9, JR: 7, SR: 6 });
  });

  it('a page whose Class cells are all "-" has members and no classYears key (SYNTHETIC)', () => {
    const html = read(REAL.m58.file).replace(/(<td class="c-table-clean__col-fit">)(FR|SO|JR|SR)(<\/td>)/g, '$1–$3');
    const o = readPage(html, targetOf(REAL.m58));
    if (o.kind !== 'members') throw new Error(JSON.stringify(o));
    expect(o.memberIds).toHaveLength(35);
    expect('classYears' in o).toBe(false);
  });

  it('a page with no Class column is refused, so it is not read as "every swimmer unknown" (SYNTHETIC, architect ruling 4)', () => {
    const html = edit(read(REAL.m58.file), '<th class="c-table-clean__col-fit">Class</th>', '');
    const o = readPage(html, targetOf(REAL.m58));
    expect(refusedCode(o)).toBe('class-column-missing');
    expect(Object.keys(o).sort()).toEqual(['code', 'detail', 'kind']);
  });

  it('GR maps to GR (D7 section 4 lists FR, SO, JR, SR, GR) (SYNTHETIC)', () => {
    const html = edit(read(REAL.m58.file), /(href="\/swimmer\/2352628">[^<]*<\/a><\/td><td[^>]*>[^<]*<\/td><td[^>]*>)FR/, '$1GR');
    const o = readPage(html, targetOf(REAL.m58));
    if (o.kind !== 'members') throw new Error(JSON.stringify(o));
    expect(o.classYears?.['2352628']).toBe('GR');
  });

  it('a server-current target is read from the page: the label comes from the selected option', () => {
    const t = targetOf(REAL.m58, { kind: 'server-current' });
    const o = readPage(read(REAL.m58.file), t, { expectedSeasonLabel: '2025-2026' });
    expect(o.kind).toBe('members');
    expect(readPage(read(REAL.m58.file), t, { expectedSeasonLabel: '2026-2027' })).toMatchObject({ kind: 'refused', code: 'season-mismatch' });
  });
});

describe('T-R2 empty state and the heading checks', () => {
  it('UWF men, season 2025-2026: "No rosters found" with a matching request is verified-empty', () => {
    const o = real('mUwf');
    expect(o).toEqual({ kind: 'verified-empty', teamId: '10002824', seasonLabel: '2025-2026', gender: 'Men', parser: { name: 'readRosterFetch', confidence: 'real-capture-verified' } });
  });

  it('verified-empty takes its gender from the request (the empty page prints no heading); a checked filter radio must agree', () => {
    const html = read(REAL.mUwf.file);
    expect(html).not.toMatch(/c-title/); // no "Season ... Men" heading on the empty page
    expect(readPage(html, targetOf(REAL.mUwf))).toMatchObject({ kind: 'verified-empty', gender: 'Men' });
    // The real page checks M. The same page asked for as women's roster is a mismatch, not an empty women's roster.
    expect(refusedCode(readPage(html, targetOf({ teamId: '10002824', gender: 'F' })))).toBe('gender-mismatch');
  });

  it('verified-empty needs the selected season to equal the target label, and the final path to equal the requested path', () => {
    const html = read(REAL.mUwf.file);
    expect(refusedCode(readPage(html, targetOf(REAL.mUwf, { kind: 'option', value: '28', label: '2024-2025' })))).toBe('season-mismatch');
    expect(refusedCode(readPage(html, targetOf(REAL.mUwf, { kind: 'option', value: '29', label: '2024-2025' })))).toBe('season-mismatch');
    const t = targetOf(REAL.mUwf);
    const requestedPath = fetchPathFor({ kind: 'team-roster', ...t });
    expect(refusedCode(readPage(html, t, { finalPath: '/team/10002824/roster/?gender=M' }))).toBe('redirected');
    expect(requestedPath).toContain('season_id=29');
  });

  it('a table with a header and no data rows, and no empty-state text, is NOT verified-empty: it refuses zero-data-rows (SYNTHETIC)', () => {
    const stripped = read(REAL.m58.file).replace(/<tr><td class="c-table-clean__col-fit u-pr0[\s\S]*?<\/tr>/g, '');
    expect(stripped).not.toBe(read(REAL.m58.file));
    expect(stripped).not.toMatch(/href="\/swimmer\/\d+">/);
    expect(stripped).not.toMatch(/No rosters found/);
    const o = readPage(stripped, targetOf(REAL.m58));
    expect(o).toMatchObject({ kind: 'refused', code: 'zero-data-rows' });
  });

  it('the members heading must be exactly "Season {label} {Men|Women}" for the request', () => {
    const html = read(REAL.m58.file);
    // Heading season differs from the selected option and the target (SYNTHETIC).
    expect(refusedCode(readPage(edit(html, 'Season 2025-2026 Men', 'Season 2024-2025 Men'), targetOf(REAL.m58)))).toBe('heading-mismatch');
    // Heading gender differs from the request.
    expect(refusedCode(readPage(html, targetOf({ teamId: '58', gender: 'F' })))).toBe('gender-mismatch');
    // A heading that says something else after "Season" is not accepted.
    expect(refusedCode(readPage(edit(html, 'Season 2025-2026 Men', 'Season 2025-2026 Mixed'), targetOf(REAL.m58)))).toBe('heading-mismatch');
    expect(refusedCode(readPage(edit(html, 'Season 2025-2026 Men', 'Season 2025-2026 Mens'), targetOf(REAL.m58)))).toBe('heading-mismatch');
    // No heading at all: the parser could fall back to the form radio; this reader does not.
    expect(refusedCode(readPage(edit(html, /<h2 class="c-title c-title--small">[\s\S]*?<\/h2>/, ''), targetOf(REAL.m58)))).toBe('heading-missing');
    // The selected option differs from the target: season-mismatch comes first.
    expect(refusedCode(readPage(html, targetOf(REAL.m58, { kind: 'option', value: '30', label: '2026-2027' })))).toBe('season-mismatch');
  });

  it('two "Season ..." headings are ambiguous (SYNTHETIC)', () => {
    const html = edit(read(REAL.m58.file), /<h2 class="c-title c-title--small">/, '<h2 class="c-title">Season 2025-2026 Men</h2><h2 class="c-title c-title--small">');
    expect(refusedCode(readPage(html, targetOf(REAL.m58)))).toBe('heading-ambiguous');
  });

  it('the filter form contradicting the heading refuses (SYNTHETIC)', () => {
    const html = edit(read(REAL.m58.file), '<input type="radio" id="M" name="gender" value="M" checked="">', '<input type="radio" id="M" name="gender" value="M">')
      .replace('<input type="radio" id="F" name="gender" value="F">', '<input type="radio" id="F" name="gender" value="F" checked="">');
    expect(refusedCode(readPage(html, targetOf(REAL.m58)))).toBe('contradicted-page-declaration');
  });

  it('the requested path must name this team, gender and season', () => {
    const html = read(REAL.m58.file);
    const t = targetOf(REAL.m58);
    expect(refusedCode(readPage(html, t, { requestedPath: '/team/48/roster/?page=1&gender=M&season_id=29&sort=name' }))).toBe('request-mismatch');
    expect(refusedCode(readPage(html, t, { requestedPath: '/team/58/roster/?page=1&gender=F&season_id=29&sort=name' }))).toBe('request-mismatch');
    expect(refusedCode(readPage(html, t, { requestedPath: '/team/58/roster/?page=1&gender=M&season_id=30&sort=name' }))).toBe('request-mismatch');
    expect(refusedCode(readPage(html, t, { requestedPath: '/team/58/roster/?gender=M' }))).toBe('request-mismatch');
  });
});

describe('T-R3 every refusal (the caller writes nothing)', () => {
  const html = read(REAL.m58.file);
  const t = targetOf(REAL.m58);

  it('an unmapped Class word refuses the whole roster (U7)', () => {
    const o = readPage(edit(html, /(href="\/swimmer\/2352628">[^<]*<\/a><\/td><td[^>]*>[^<]*<\/td><td[^>]*>)FR/, '$15Y'), t);
    expect(o).toMatchObject({ kind: 'refused', code: 'unmapped-class-year' });
    expect(o.kind === 'refused' && o.detail).toContain('5Y');
  });

  it('a row with no /swimmer/ link refuses', () => {
    const o = readPage(edit(html, /<a class="u-text-semi" href="\/swimmer\/2352628">Bartu Akin<\/a>/, 'Bartu Akin'), t);
    expect(refusedCode(o)).toBe('missing-athlete-link');
  });

  it('a row with an empty name cell refuses as an unparsed row', () => {
    const o = readPage(edit(html, /<a class="u-text-semi" href="\/swimmer\/2352628">Bartu Akin<\/a>/, ''), t);
    expect(refusedCode(o)).toBe('unparsed-row');
  });

  it('the same swimmer id twice refuses', () => {
    const o = readPage(edit(html, 'href="/swimmer/1130590">', 'href="/swimmer/2352628">'), t);
    expect(refusedCode(o)).toBe('duplicate-swimmer-id');
  });

  it('a page=2 link refuses (U8)', () => {
    expect(refusedCode(readPage(edit(html, '</tbody>', '</tbody><a href="/team/58/roster/?page=2&amp;gender=M&amp;season_id=29&amp;sort=name">2</a>'), t))).toBe('pagination');
    expect(refusedCode(readPage(edit(html, '</tbody>', '</tbody><a href="?page=3">3</a>'), t))).toBe('pagination');
    expect(refusedCode(readPage(edit(html, '</tbody>', '</tbody><a rel="next" href="#">Next</a>'), t))).toBe('pagination');
    expect(refusedCode(readPage(edit(html, '</tbody>', '</tbody><ul class="pagination"></ul>'), t))).toBe('pagination');
  });

  it('pagination markup is not found on any of the six real pages (the detector must not refuse a real roster)', () => {
    for (const [key, r] of Object.entries(REAL)) expect(findRosterPagination(read(r.file)), key).toBeNull();
    // The real page does carry the hidden form field and a "page=1" link target; they are not pagination.
    expect(read(REAL.m58.file)).toContain('name="page" value="1"');
    expect(findRosterPagination('<a href="/team/58/roster/?page=1&amp;gender=M">1</a>')).toBeNull();
  });

  it('a response that was redirected refuses', () => {
    expect(refusedCode(readPage(html, t, { finalPath: '/team/58/roster/?gender=M' }))).toBe('redirected');
  });

  it('a page with no season select, or two selected options, refuses', () => {
    expect(refusedCode(readPage(edit(html, /<select name="season_id"[\s\S]*?<\/select>/, ''), t))).toBe('season-select-invalid');
    expect(refusedCode(readPage(edit(html, '<option value="30">2026-2027</option>', '<option value="30" selected="">2026-2027</option>'), t))).toBe('season-select-invalid');
    expect(refusedCode(readPage(edit(html, '<option value="29" selected="">2025-2026</option>', '<option value="29">2025-2026</option>'), t))).toBe('season-not-selected');
  });

  it('a challenge page, an empty body and a page with no table refuse', () => {
    expect(refusedCode(readPage('<html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>', t))).toBe('season-select-invalid');
    expect(refusedCode(readPage('', t))).toBe('season-select-invalid');
    const noTable = read(REAL.m58.file).replace(/<table[\s\S]*<\/table>/, '');
    expect(refusedCode(readPage(noTable, t))).toBe('parse-failed');
  });

  it('a page with a table and the empty-state words together is not verified-empty (SYNTHETIC)', () => {
    const o = readPage(edit(html, '</tbody>', '</tbody><h3 class="c-blankslate__title">No rosters found</h3>'), t);
    expect(o.kind).toBe('members'); // the table wins: the parser never takes the empty-state branch when a table exists
    expect(o).not.toMatchObject({ kind: 'verified-empty' });
  });

  it('a refusal carries no roster fields', () => {
    const o = readPage(edit(html, 'href="/swimmer/1130590">', 'href="/swimmer/2352628">'), t);
    expect(Object.keys(o).sort()).toEqual(['code', 'detail', 'kind']);
  });
});
