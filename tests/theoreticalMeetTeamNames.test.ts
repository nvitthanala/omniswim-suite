/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * School names on the Teams step: the division tag, the grouping rule, the server-side name
 * reader for old captures, and the extension label path. Provenance: names come from the
 * committed roster fixtures through the real parser. No competition value is typed here.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTeamRosterHtml } from '../packages/swimcloud/src/parser';
import { FileSystemSwimCloudCaptureStore } from '../packages/swimcloud/src/captureStore';
import { decideTeamName, readCaptureTeamName, withTeamName } from '../apps/shell/lib/swimcloudCaptureTeamName';
import { groupCaptures, teamDivisionTag, type CaptureListRecord } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import { FIXTURE_ROOT, fixtureRecords } from './theoreticalMeetUiFixtures';
import { PAGES, makeHarness, run } from './helpers/multiTeamDriverHarness';

const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('teamDivisionTag', () => {
  it('names the division the table holds, never D1 by default', () => {
    for (const name of ['Henderson State University', 'Ouachita Baptist University', 'Delta State University']) {
      const tag = teamDivisionTag(name);
      expect(tag.division, name).not.toBeNull();
      expect(tag.text).toBe(`NCAA ${tag.division}`);
      expect(tag.canonicalTeam).not.toBeNull();
    }
  });

  it('says unknown division for a school the table does not hold, and for no name', () => {
    expect(teamDivisionTag('Nowhere Community College')).toMatchObject({ text: 'unknown division', division: null });
    expect(teamDivisionTag(null)).toMatchObject({ text: 'unknown division', division: null });
    expect(teamDivisionTag('   ')).toMatchObject({ text: 'unknown division', division: null });
  });
});

function rec(overrides: Partial<CaptureListRecord> & { captureId: string }): CaptureListRecord {
  return {
    subject: { kind: 'team', teamId: '48', season: '2026-2027' },
    completeness: 'every-planned-page-fetched',
    plannedPageCount: 1,
    pages: [],
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('groupCaptures school names', () => {
  it('uses the server team name or the stored label, and tags the division', () => {
    const groups = groupCaptures(
      [
        rec({ captureId: 'team-48-2026-2027', label: 'Delta State University' }),
        rec({ captureId: 'team-5-2026-2027', subject: { kind: 'team', teamId: '5', season: '2026-2027' }, teamName: 'Henderson State University' }),
      ],
      NOW
    );
    const labelled = groups.find(g => g.teamId === '48')!;
    const byServer = groups.find(g => g.teamId === '5')!;
    expect(labelled).toMatchObject({ teamId: '48', title: 'Delta State University', named: true });
    expect(labelled.divisionTag.division).not.toBeNull();
    expect(byServer).toMatchObject({ title: 'Henderson State University', named: true });
  });

  it('keeps the numeric id, with no division claim, when no name is known', () => {
    const [g] = groupCaptures([rec({ captureId: 'team-48-2026-2027' })], NOW);
    expect(g).toMatchObject({ title: 'Team 48', named: false, nameWarning: null });
    expect(g.divisionTag).toMatchObject({ text: 'unknown division', division: null });
  });

  it('shows neither name, and warns, when two captures of a team disagree', () => {
    const [g] = groupCaptures(
      [
        rec({ captureId: 'team-48-2026-2027', label: 'Delta State University' }),
        rec({ captureId: 'team-48-2025-2026', subject: { kind: 'team', teamId: '48', season: '2025-2026' }, label: 'Ouachita Baptist University' }),
      ],
      NOW
    );
    expect(g.title).toBe('Team 48');
    expect(g.named).toBe(false);
    expect(g.nameWarning).toContain('different school names');
  });

  it('keeps the numeric id and shows the server warning', () => {
    const [g] = groupCaptures([rec({ captureId: 'team-48-2026-2027', teamNameWarning: 'pages disagree' })], NOW);
    expect(g).toMatchObject({ title: 'Team 48', named: false, nameWarning: 'pages disagree' });
  });
});

describe('decideTeamName', () => {
  it('returns one name, nothing, or a warning', () => {
    expect(decideTeamName('c', ['A U', ' A U '])).toEqual({ teamName: 'A U' });
    expect(decideTeamName('c', [])).toEqual({});
    expect(decideTeamName('c', ['A U', 'B U']).teamName).toBeUndefined();
    expect(decideTeamName('c', ['A U', 'B U']).teamNameWarning).toContain('A U / B U');
  });
});

describe('readCaptureTeamName on stored captures', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function copyStore(): FileSystemSwimCloudCaptureStore {
    const dir = mkdtempSync(join(tmpdir(), 'omni-names-'));
    dirs.push(dir);
    cpSync(FIXTURE_ROOT, dir, { recursive: true });
    return new FileSystemSwimCloudCaptureStore(dir);
  }

  it('reads the name the roster pages print and caches it as the label once', async () => {
    const store = copyStore();
    const before = await store.getCapture('team-412-2026-2027');
    expect(before?.label).toBeUndefined();
    const read = await readCaptureTeamName(store, before!);
    expect(read.teamName).toMatch(/\S/);

    const listed = await withTeamName(store, before!);
    expect(listed.teamName).toBe(read.teamName);
    expect((await store.getCapture('team-412-2026-2027'))?.label).toBe(read.teamName);

    // Second call: the label is already there, the answer is the same.
    const again = await withTeamName(store, (await store.getCapture('team-412-2026-2027'))!);
    expect(again.teamName).toBe(read.teamName);
  });

  it('does not write while the crawl is still running', async () => {
    const store = copyStore();
    const before = (await store.getCapture('team-412-2026-2027'))!;
    const listed = await withTeamName(store, { ...before, completeness: 'in-progress' });
    expect(listed.teamName).toBeDefined();
    expect((await store.getCapture('team-412-2026-2027'))?.label).toBeUndefined();
  });

  it('gives no name and no label for a capture with no roster page', async () => {
    const store = copyStore();
    const before = (await store.getCapture('team-412-2026-2027'))!;
    const stripped = { ...before, pages: before.pages.filter(p => p.resourceKind !== 'teamRoster') };
    const listed = await withTeamName(store, stripped);
    expect(listed.teamName).toBeUndefined();
    expect(listed.label).toBeUndefined();
  });

  it('lists the fixture records without a label (the unlabelled case)', async () => {
    expect((await fixtureRecords()).every(r => r.label === undefined)).toBe(true);
  });
});

describe('the multi-team driver label path', () => {
  // The fixtures print the school in the page <h1>. The expected names come from the real parser.
  // The 10002824 men's page is the "No rosters found" page and prints no name, so that team's name comes from its women's page.
  const nameOf = (team: string, g: 'M' | 'F'): string => {
    const p = parseTeamRosterHtml(
      PAGES[`${team}|${g}`],
      { sourceUrl: `https://www.swimcloud.com/team/${team}/roster/?gender=${g}`, retrievedAt: '2026-10-03T00:00:00.000Z', track: 'browser-extension' },
      { gender: g === 'M' ? 'Men' : 'Women', season: '2025-2026', teamId: team as never }
    );
    if (!p.ok || p.data.teamName === undefined) throw new Error('fixture prints no team name');
    return p.data.teamName;
  };
  const seasonMarks = (h: ReturnType<typeof makeHarness>) =>
    h.marks.filter(m => m.subject.kind === 'team' && m.subject.season !== undefined);
  const teamOf = (m: { subject: { kind: string } }) => (m.subject.kind === 'team' ? (m.subject as { teamId: string }).teamId : '');

  it('passes the printed school name on the season captures', async () => {
    const h = makeHarness({ serveBySeason: true });
    await run(h);
    const marks = seasonMarks(h);
    expect(marks.length).toBe(2);
    for (const m of marks) expect(m.label).toBe(nameOf(teamOf(m), teamOf(m) === '412' ? 'M' : 'F'));
  });

  it('leaves the label absent when the pages print no name', async () => {
    const pages = Object.fromEntries(Object.entries(PAGES).map(([k, html]) => [k, html.replace(/<h1 class="c-toolbar__title">[\s\S]*?<\/h1>/, '<h1 class="c-toolbar__title"></h1>')]));
    const h = makeHarness({ serveBySeason: true, pages });
    await run(h);
    expect(seasonMarks(h).length).toBe(2);
    expect(seasonMarks(h).every(m => m.label === undefined)).toBe(true);
  });

  it('leaves the label absent when the two roster pages print different names', async () => {
    const pages = { ...PAGES };
    pages['412|F'] = pages['412|F'].split(nameOf('412', 'F')).join('Some Other University');
    const h = makeHarness({ serveBySeason: true, pages });
    await run(h);
    const marks = seasonMarks(h);
    expect(marks.find(m => teamOf(m) === '412')?.label).toBeUndefined();
    expect(marks.find(m => teamOf(m) === '10002824')?.label).toBe(nameOf('10002824', 'F'));
  });
});
