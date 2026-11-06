/**
 * F1.1a: the default-deny and defence-in-depth refusals of `readRosterFetch` that no real or edited page can reach,
 * because the parser's own warnings fire first on any page we can build. Each test replaces the parser's answer
 * (vi.mock on `rosterPage`) with a SYNTHETIC one derived from the real Henderson State men's page, so the parser
 * result is the only thing that changes. Without these, removing the check would pass every page-level test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RosterFetchOutcome, RosterFetchTarget } from '@omniswim/swimcloud/browser';
import { fetchPathFor } from '../apps/extension/src/shared/fetchProtocol';

vi.mock('../packages/swimcloud/src/rosterPage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../packages/swimcloud/src/rosterPage')>();
  return { ...original, parseTeamRosterHtml: vi.fn(original.parseTeamRosterHtml) };
});

import { parseTeamRosterHtml } from '../packages/swimcloud/src/rosterPage';
import { readRosterFetch } from '@omniswim/swimcloud/browser';

type Parsed = ReturnType<typeof parseTeamRosterHtml>;
type Ok = Extract<Parsed, { ok: true }>;

const HTML = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'swimcloud-real-team-roster-58-gender-m.html'), 'utf8');
const TARGET: RosterFetchTarget = { teamId: '58', gender: 'M', season: { kind: 'option', value: '29', label: '2025-2026' } };
const PATH = fetchPathFor({ kind: 'team-roster', ...TARGET });
const AT = '2026-11-06T00:00:00.000Z';

const mocked = vi.mocked(parseTeamRosterHtml);
const realParse = (): Ok => {
  const original = mocked.getMockImplementation()!;
  const r = original(HTML, { sourceUrl: `https://www.swimcloud.com${PATH}`, retrievedAt: AT, track: 'browser-extension' });
  if (!r.ok) throw new Error('the real page must parse');
  return r;
};
const read = (): RosterFetchOutcome => readRosterFetch(HTML, { target: TARGET, requestedPath: PATH, finalPath: PATH, fetchedAt: AT });
const withParsed = (change: (r: Ok) => Ok): void => {
  mocked.mockImplementationOnce(() => change(realParse()));
};
const code = (o: RosterFetchOutcome): string => (o.kind === 'refused' ? o.code : `not refused: ${o.kind}`);

afterEach(() => mocked.mockClear());

describe('readRosterFetch defence in depth (SYNTHETIC parser answers)', () => {
  it('control: the unchanged real parser answer is read as members', () => {
    expect(read().kind).toBe('members');
  });

  it('default deny: a parser warning the code does not know refuses as unexpected-warning', () => {
    withParsed((r) => ({ ...r, warnings: [...r.warnings, { code: 'unrecognized-season-label', message: 'a warning added to the parser later' } as Ok['warnings'][number]] }));
    expect(code(read())).toBe('unexpected-warning');
  });

  it('an empty-state answer that also lists swimmers refuses as unexpected-parse', () => {
    withParsed((r) => ({ ...r, warnings: [{ code: 'no-roster-posted', message: 'No rosters found' } as Ok['warnings'][number]] }));
    expect(code(read())).toBe('unexpected-parse');
  });

  it('an empty-state answer with any other warning refuses as unexpected-warning', () => {
    withParsed((r) => ({
      ...r,
      data: { ...r.data, athletes: [], rowCount: 0 },
      warnings: [{ code: 'no-roster-posted', message: 'No rosters found' }, { code: 'zero-data-rows', message: 'x' }] as Ok['warnings'],
    }));
    expect(code(read())).toBe('unexpected-warning');
  });

  it('the parser reading the season or gender from a fallback, not the page, refuses as unexpected-parse', () => {
    withParsed((r) => ({ ...r, data: { ...r.data, seasonSource: 'url' } as unknown as Ok['data'] }));
    expect(code(read())).toBe('unexpected-parse');
    withParsed((r) => ({ ...r, data: { ...r.data, genderSource: 'url' } as unknown as Ok['data'] }));
    expect(code(read())).toBe('unexpected-parse');
    withParsed((r) => ({ ...r, data: { ...r.data, season: '2024-2025' } }));
    expect(code(read())).toBe('unexpected-parse');
  });

  it('fewer swimmers than table rows, or none, refuses as unexpected-parse', () => {
    withParsed((r) => ({ ...r, data: { ...r.data, athletes: r.data.athletes.slice(1) } }));
    expect(code(read())).toBe('unexpected-parse');
    withParsed((r) => ({ ...r, data: { ...r.data, athletes: [], rowCount: 0 } }));
    expect(code(read())).toBe('unexpected-parse');
  });

  it('a swimmer with no id, past the warnings, refuses as missing-athlete-link', () => {
    withParsed((r) => ({ ...r, data: { ...r.data, athletes: r.data.athletes.map((a, i) => (i === 0 ? { ...a, swimCloudSwimmerId: undefined } : a)) } }));
    expect(code(read())).toBe('missing-athlete-link');
  });
});
