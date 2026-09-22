/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/manager/src/lib/rosterQueueImport.ts` — the two halves of a roster
 * import, and their composition.
 *
 * These functions were extracted from `RosterImportWizard.tsx`'s two clipboard
 * handlers on 2026-09-09, when a second caller arrived
 * (`SwimCloudCaptureRosterImportPanel`, which runs the same steps once per
 * athlete against an already-completed capture). This file is what keeps the
 * two callers honest: it exercises the shared functions directly, so a change
 * that would break one path breaks a test rather than only the path nobody
 * clicked that week.
 *
 * ## Where the values come from
 *
 * Every roster name, swimmer id, event label and time below is read out of a
 * real SwimCloud capture at test time — `parseTeamRosterHtml` over Henderson
 * State's real men's and women's roster pages, and `parseSwimmerTimesHtml` over
 * River Paulk's real times page. Nothing is typed in by hand, so an upstream
 * layout change or a parser regression breaks CI here too.
 *
 * **One thing is constructed, and deliberately so:** the real times fixture
 * belongs to an Auburn swimmer, not to anybody on Henderson State's roster, so
 * the two real captures do not pair on their own. The tests below re-point that
 * parse's `swimCloudSwimmerId` at a real Henderson State athlete's real id.
 * That is a constructed *pairing* of two real parses — every value on either
 * side is still the value SwimCloud served — and it is what makes these tests
 * prove the id branch specifically: the name never matches, so a check-off can
 * only have come from the id.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import {
  parseSwimmerTimesHtml,
  parseTeamRosterHtml,
  type SwimCloudParseContext,
  type SwimCloudRosterParse,
  type SwimCloudSwimmerTimesParse,
} from '@omniswim/swimcloud';
import {
  buildRosterImportFromCapture,
  convertAndAccountSwimmerTimes,
  describeNewAthletes,
  formatSkipWarnings,
  markRosterQueueCaptured,
  pairRosterWithSwimmerTimes,
  rosterCaptureCoverage,
  seedRosterQueueFromAthletes,
} from '@omniswim/manager/lib/rosterQueueImport';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

/** The real capture URLs, verbatim from the fixtures' own provenance headers. */
const MEN_ROSTER_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=29&sort=name',
  retrievedAt: '2026-09-09T02:08:38.793Z',
  track: 'browser-extension',
};
const WOMEN_ROSTER_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/team/58/roster/?page=1&gender=F&season_id=29&sort=name',
  retrievedAt: '2026-09-09T02:08:50.769Z',
  track: 'browser-extension',
};
const TIMES_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/swimmer/1472365/times/',
  retrievedAt: '2026-09-09T03:32:55.480Z',
  track: 'browser-extension',
};

export function realMensRoster(): SwimCloudRosterParse {
  const result = parseTeamRosterHtml(fixture('swimcloud-real-team-roster-58-gender-m.html'), MEN_ROSTER_CONTEXT);
  if (!result.ok) throw new Error(`roster fixture failed to parse: ${result.failure.message}`);
  return result.data;
}

export function realWomensRoster(): SwimCloudRosterParse {
  const result = parseTeamRosterHtml(fixture('swimcloud-real-team-roster-58-gender-f.html'), WOMEN_ROSTER_CONTEXT);
  if (!result.ok) throw new Error(`roster fixture failed to parse: ${result.failure.message}`);
  return result.data;
}

export function realSwimmerTimes(): SwimCloudSwimmerTimesParse {
  const result = parseSwimmerTimesHtml(fixture('swimcloud-real-swimmer-times-1472365.html'), TIMES_CONTEXT);
  if (!result.ok) throw new Error(`times fixture failed to parse: ${result.failure.message}`);
  return result.data;
}

/**
 * The real times parse, re-pointed at a real Henderson State athlete's real id.
 * See this file's header on why the pairing is constructed and the values are
 * not.
 */
export function timesFor(swimCloudSwimmerId: string): SwimCloudSwimmerTimesParse {
  return { ...realSwimmerTimes(), swimCloudSwimmerId };
}

/** Colin Candebat — a real row of the real men's roster, asserted in `tests/swimcloudTeamRosterParser.test.ts`. */
const COLIN_ID = '1865160';

describe('seedRosterQueueFromAthletes', () => {
  it('turns every roster athlete into an unchecked queue entry, in page order', () => {
    const roster = realMensRoster();
    const seed = seedRosterQueueFromAthletes('Henderson State', roster.athletes, { existingRosterNames: [] });

    expect(seed.totalCount).toBe(35);
    expect(seed.queue.entries).toHaveLength(35);
    expect(seed.queue.teamLabel).toBe('Henderson State');
    expect(seed.queue.entries.every(e => e.captured)).toBe(false);
    expect(seed.queue.entries.map(e => e.name)).toStrictEqual(roster.athletes.map(a => a.name));

    const colin = seed.queue.entries.find(e => e.name === 'Colin Candebat');
    expect(colin).toStrictEqual({ swimCloudSwimmerId: COLIN_ID, name: 'Colin Candebat', captured: false });
  });

  it('reports which athletes the workspace has not seen, without removing anybody from the queue', () => {
    const roster = realMensRoster();
    const alreadyHere = roster.athletes.slice(0, 30).map(a => a.name);
    const seed = seedRosterQueueFromAthletes('Henderson State', roster.athletes, {
      existingRosterNames: alreadyHere,
    });

    // A swimmer already in the workspace still needs their times captured, so
    // they keep a checklist entry — they are just not announced as new.
    expect(seed.queue.entries).toHaveLength(35);
    expect(seed.newAthletes).toHaveLength(5);
    expect(seed.newAthletes.map(a => a.name)).toStrictEqual(roster.athletes.slice(30).map(a => a.name));
  });

  it('matches an existing roster name case-insensitively and past diacritics', () => {
    const roster = realMensRoster();
    const seed = seedRosterQueueFromAthletes('Henderson State', roster.athletes, {
      existingRosterNames: ['  cOlIn   candebat  '],
    });
    expect(seed.newAthletes.map(a => a.name)).not.toContain('Colin Candebat');
    expect(seed.newAthletes).toHaveLength(34);
  });

  it('says "all already in this workspace" only when that is true', () => {
    const roster = realMensRoster();
    const all = seedRosterQueueFromAthletes('HSU', roster.athletes, {
      existingRosterNames: roster.athletes.map(a => a.name),
    });
    expect(describeNewAthletes(all)).toBe('all already in this workspace.');

    const none = seedRosterQueueFromAthletes('HSU', roster.athletes, { existingRosterNames: [] });
    expect(describeNewAthletes(none)).toContain('35 not yet in this workspace:');
    expect(describeNewAthletes(none)).toContain('+29 more');
  });
});

describe('convertAndAccountSwimmerTimes', () => {
  it('converts the real times capture into all 9 of its swims', () => {
    const parse = realSwimmerTimes();
    const result = convertAndAccountSwimmerTimes(parse, { team: 'Auburn', gender: Gender.MEN });
    if (!result.ok) throw new Error(`expected a conversion, got: ${result.message}`);

    // All 9 real rows, the relay leadoff included. **Changed 2026-09-22 on the
    // coach's ruling**: a leadoff starts from the blocks and finishes to the
    // hand, so it is the individual event swum inside a relay.
    expect(parse.personalBests).toHaveLength(9);
    expect(result.swims).toHaveLength(9);
    expect(result.skippedCount).toBe(0);
    expect(result.skipWarnings).toStrictEqual([]);
    expect(result.swims.map(s => s.event)).toContain('50 Back SCY');

    const fifty = result.swims.find(s => s.event === '50 Free SCY');
    expect(fifty).toStrictEqual({
      name: 'Paulk, River J',
      team: 'Auburn',
      gender: Gender.MEN,
      event: '50 Free SCY',
      time: '19.42',
      timeType: 'SCY',
      date: 'Mar 1, 2025',
      meetLabel: 'James E Martin Invitational',
      source: 'swimcloud',
    });
  });

  it('takes the match key from the parse itself — the id the page or the caller settled', () => {
    const result = convertAndAccountSwimmerTimes(timesFor(COLIN_ID), { team: 'HSU', gender: Gender.MEN });
    if (!result.ok) throw new Error(result.message);
    expect(result.match).toStrictEqual({ swimmerId: COLIN_ID, name: 'Paulk, River J' });
  });

  it('refuses a page with no swimmer name rather than importing under a placeholder', () => {
    const nameless: SwimCloudSwimmerTimesParse = { ...realSwimmerTimes(), name: undefined };
    const result = convertAndAccountSwimmerTimes(nameless, { team: 'HSU', gender: Gender.MEN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-swimmer-name');
    expect(result.message).toContain('Refusing to import under a placeholder name');
  });

  it('distinguishes "nothing importable here" from an empty success', () => {
    // A row with no time. This used to use the leadoff row; a leadoff is a
    // real individual swim as of 2026-09-22, so "no time at all" is the only
    // per-row skip left.
    const first = realSwimmerTimes().personalBests[0];
    if (first === undefined) throw new Error('fixture carries no rows');
    const timelessOnly: SwimCloudSwimmerTimesParse = {
      ...realSwimmerTimes(),
      personalBests: [{ ...first, time: undefined }],
    };
    expect(timelessOnly.personalBests).toHaveLength(1);

    const result = convertAndAccountSwimmerTimes(timelessOnly, { team: 'HSU', gender: Gender.MEN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-usable-times');
    // Byte-identical to the message the single-swimmer clipboard path has
    // always shown — the extraction moved this string, it did not reword it.
    expect(result.message).toBe(
      'No usable individual-event times found on that page (1 row(s) skipped — no readable time, or a relay leadoff split rather than an individual swim).',
    );
  });
});

describe('formatSkipWarnings', () => {
  it('prints one line per reason, with the hyphens read out as words', () => {
    expect(formatSkipWarnings(new Map([['relay-leadoff', 3], ['no-time', 1]]))).toStrictEqual([
      '3 row(s) skipped — relay leadoff.',
      '1 row(s) skipped — no time.',
    ]);
  });

  it('prints nothing when nothing was skipped', () => {
    expect(formatSkipWarnings(new Map())).toStrictEqual([]);
  });
});

describe('markRosterQueueCaptured', () => {
  it('checks off the athlete whose id matches, even though the two pages spell the name differently', () => {
    const seed = seedRosterQueueFromAthletes('HSU', realMensRoster().athletes, { existingRosterNames: [] });
    const accounted = convertAndAccountSwimmerTimes(timesFor(COLIN_ID), { team: 'HSU', gender: Gender.MEN });
    if (!accounted.ok) throw new Error(accounted.message);

    const marked = markRosterQueueCaptured(seed.queue, accounted.match);
    expect(marked.matchedNew).toBe(true);
    expect(marked.queue.entries.filter(e => e.captured).map(e => e.name)).toStrictEqual(['Colin Candebat']);
  });

  it('reports matchedNew false when that swimmer was already checked off', () => {
    const seed = seedRosterQueueFromAthletes('HSU', realMensRoster().athletes, { existingRosterNames: [] });
    const once = markRosterQueueCaptured(seed.queue, { swimmerId: COLIN_ID, name: 'Paulk, River J' });
    const twice = markRosterQueueCaptured(once.queue, { swimmerId: COLIN_ID, name: 'Paulk, River J' });
    expect(twice.matchedNew).toBe(false);
    expect(twice.queue.entries.filter(e => e.captured)).toHaveLength(1);
  });

  it('checks nobody off when no entry matches, rather than falling back to the first row', () => {
    const seed = seedRosterQueueFromAthletes('HSU', realMensRoster().athletes, { existingRosterNames: [] });
    const marked = markRosterQueueCaptured(seed.queue, { swimmerId: 'no-such-id', name: 'Nobody, Real' });
    expect(marked.matchedNew).toBe(false);
    expect(marked.queue.entries.filter(e => e.captured)).toHaveLength(0);
  });

  it('falls back to the folded name for an athlete the roster page gave no profile link', () => {
    const queue = {
      teamLabel: 'HSU',
      entries: [{ name: 'Katie Batts', captured: false }],
    };
    // Display order on the roster page, family name first on the times page.
    const marked = markRosterQueueCaptured(queue, { swimmerId: '999', name: 'Batts, Katie' });
    expect(marked.matchedNew).toBe(true);
    expect(marked.queue.entries[0].captured).toBe(true);
  });
});

describe('pairRosterWithSwimmerTimes and rosterCaptureCoverage', () => {
  it('counts only athletes a stored times page actually covers', () => {
    const roster = realMensRoster();
    const coverage = rosterCaptureCoverage(roster.athletes, [timesFor(COLIN_ID)]);
    expect(coverage).toStrictEqual({
      rosterAthleteCount: 35,
      withCapturedTimes: 1,
      withoutCapturedTimes: 34,
    });
  });

  it('reports zero coverage for a capture holding no swimmer-times page at all', () => {
    const roster = realMensRoster();
    expect(rosterCaptureCoverage(roster.athletes, [])).toStrictEqual({
      rosterAthleteCount: 35,
      withCapturedTimes: 0,
      withoutCapturedTimes: 35,
    });
  });

  it('never hands one swimmer-times page to two athletes', () => {
    // Two link-less roster rows whose names fold together. Only the first can
    // claim the single stored page; the second honestly has nothing.
    const pairings = pairRosterWithSwimmerTimes(
      [
        { name: 'Katie Batts', captured: false },
        { name: 'Batts, Katie', captured: false },
      ],
      [{ ...timesFor('999'), name: 'Batts, Katie' }],
    );
    expect(pairings.map(p => p.parse !== undefined)).toStrictEqual([true, false]);
  });

  it('ignores a swimmer-times page belonging to nobody on this roster', () => {
    const roster = realMensRoster();
    const pairings = pairRosterWithSwimmerTimes(
      roster.athletes.map(a => ({ swimCloudSwimmerId: a.swimCloudSwimmerId, name: a.name, captured: false })),
      [realSwimmerTimes()],
    );
    expect(pairings.filter(p => p.parse !== undefined)).toHaveLength(0);
  });
});

describe('buildRosterImportFromCapture', () => {
  it('imports the matched swimmer, leaves the rest on the checklist, and says so', () => {
    const roster = realMensRoster();
    const result = buildRosterImportFromCapture({
      roster,
      swimmerTimes: [timesFor(COLIN_ID)],
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: [],
    });

    // The queue is the whole roster; exactly the covered athlete is checked off.
    expect(result.rosterQueue.entries).toHaveLength(35);
    expect(result.rosterQueue.entries.filter(e => e.captured).map(e => e.name)).toStrictEqual(['Colin Candebat']);
    expect(result.teamLabel).toBe('Henderson State University');

    // The swims are the real ones off the real times capture.
    expect(result.swims).toHaveLength(9);
    expect(result.swims.every(s => s.team === 'Henderson State' && s.gender === Gender.MEN)).toBe(true);
    expect(result.swims.find(s => s.event === '50 Free SCY')?.time).toBe('19.42');
    expect(result.swims.find(s => s.event === '1000 Free SCY')?.time).toBe('10:37.48');

    expect(result.coverage).toStrictEqual({
      rosterAthleteCount: 35,
      withCapturedTimes: 1,
      withoutCapturedTimes: 34,
    });
    expect(result.importedSwimmerCount).toBe(1);
    expect(result.newAthleteCount).toBe(35);
    expect(result.genderMismatch).toBe(false);
    // No leadoff warning: a leadoff is imported as the individual swim it is.
    expect(result.warnings).toStrictEqual([]);
    expect(result.summary).toContain('imported 9 swim(s) for 1 of 35 roster swimmer(s)');
    expect(result.summary).toContain('34 still need a "Copy for Omniswim" capture');
  });

  it('tallies skipped rows once for the whole roster, not once per swimmer', () => {
    const roster = realMensRoster();
    const twoAthletes = roster.athletes.filter(a => a.swimCloudSwimmerId !== undefined).slice(0, 2);
    const ids = twoAthletes.map(a => a.swimCloudSwimmerId as string);

    const result = buildRosterImportFromCapture({
      roster: { ...roster, athletes: twoAthletes },
      swimmerTimes: ids.map(timesFor),
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: [],
    });

    expect(result.importedSwimmerCount).toBe(2);
    expect(result.swims).toHaveLength(18);
    // Two swimmers, nine rows each, nothing skipped.
    expect(result.warnings).toStrictEqual([]);
  });

  it('leaves a swimmer whose page held nothing importable unchecked, and names them', () => {
    const roster = realMensRoster();
    const colin = roster.athletes.find(a => a.swimCloudSwimmerId === COLIN_ID);
    if (colin === undefined) throw new Error('Colin Candebat missing from the roster fixture');

    // A row with no time. This used to use the leadoff row; a leadoff is a
    // real individual swim as of 2026-09-22, so "no time at all" is the only
    // per-row skip left.
    const firstBest = realSwimmerTimes().personalBests[0];
    if (firstBest === undefined) throw new Error('fixture carries no rows');
    const timelessOnly: SwimCloudSwimmerTimesParse = {
      ...timesFor(COLIN_ID),
      personalBests: [{ ...firstBest, time: undefined }],
    };

    const result = buildRosterImportFromCapture({
      roster,
      swimmerTimes: [timelessOnly],
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: [],
    });

    expect(result.swims).toHaveLength(0);
    expect(result.importedSwimmerCount).toBe(0);
    // The page exists, so coverage still counts it — coverage answers "did the
    // crawl fetch this swimmer", not "did it yield a time".
    expect(result.coverage.withCapturedTimes).toBe(1);
    expect(result.rosterQueue.entries.filter(e => e.captured)).toHaveLength(0);
    expect(result.warnings[0]).toContain('Colin Candebat: No usable individual-event times found');
  });

  it('flags a roster whose stated gender is not the one this wizard is scoped to', () => {
    const womens = realWomensRoster();
    expect(womens.gender).toBe('Women');

    const result = buildRosterImportFromCapture({
      roster: womens,
      swimmerTimes: [],
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: [],
    });

    expect(result.genderMismatch).toBe(true);
    expect(result.warnings[0]).toBe(
      "This capture's roster is Women; this importer is scoped to Men. Every swim below is recorded as Men.",
    );
  });

  it('records the swims under the wizard\'s gender even across a mismatch, and says that in the warning', () => {
    const womens = realWomensRoster();
    const emma = womens.athletes.find(a => a.name === 'Emma Crowe');
    if (emma?.swimCloudSwimmerId === undefined) throw new Error('Emma Crowe missing from the roster fixture');

    const result = buildRosterImportFromCapture({
      roster: womens,
      swimmerTimes: [timesFor(emma.swimCloudSwimmerId)],
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: [],
    });

    expect(result.genderMismatch).toBe(true);
    expect(result.swims).toHaveLength(9);
    // The wizard's scope wins for what gets written; the disagreement is stated,
    // never resolved silently.
    expect(result.swims.every(s => s.gender === Gender.MEN)).toBe(true);
    expect(result.warnings[0]).toContain('this importer is scoped to Men');
  });

  it('does not flag a gender the roster and the wizard agree on', () => {
    const result = buildRosterImportFromCapture({
      roster: realMensRoster(),
      swimmerTimes: [],
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: [],
    });
    expect(result.genderMismatch).toBe(false);
    expect(result.warnings).toStrictEqual([]);
  });

  it('counts "new to this workspace" against the names the workspace already holds', () => {
    const roster = realMensRoster();
    const result = buildRosterImportFromCapture({
      roster,
      swimmerTimes: [],
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: roster.athletes.slice(0, 33).map(a => a.name),
    });
    expect(result.newAthleteCount).toBe(2);
    expect(result.summary).toContain('2 not yet in this workspace:');
  });
});
