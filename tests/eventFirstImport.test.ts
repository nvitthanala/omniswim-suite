/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Event-first import: a per-event results page converted directly into rows.
 *
 * ## What this closes
 *
 * `swimCloudTeamMeetSwimsToSwimmerResults` made the per-team swims list the
 * source of rows and used event pages only to look up which round a swim was.
 * That inverted the reliable order, and once the crawler stopped fetching swims
 * pages — it no longer needs them to discover events — `applySwimCloudRows`
 * would have imported nothing at all from a complete capture.
 *
 * Three defects this file pins, all measured against the 51 stored event pages
 * and 8 stored roster pages of meet 356467:
 *
 * 1. **Every relay was dropped.** A relay event's table has no Team column at
 *    all — its header is one `<th colspan=2>Name</th>` — so `teamName` was
 *    absent and all 71 relay rows were skipped as `'no-team-name'`. Relays
 *    score double in every championship table this repo models.
 * 2. **Relay team names.** The entry label is "Henderson State (A)". Using it
 *    as the team would score the A and B relays as two different programs and
 *    join neither to that team's individual swims.
 * 3. **Class year was hardcoded `'unknown'`** on every row, though the capture
 *    holds the rosters that state it.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMeetEventResultsHtml, parseTeamRosterHtml } from '../packages/swimcloud/src/parser';
import type {
  SwimCloudMeetEventResultsParse,
  SwimCloudRosterParse,
} from '../packages/swimcloud/src/parser';
import {
  buildSwimCloudClassYearIndex,
  buildSwimCloudTeamNameIndex,
  swimCloudEventResultsToSwimmerResults,
} from '../packages/matrix/src/lib/swimCloudMeetImportBridge';

const PAGES = path.resolve(__dirname, '..', 'data', 'swimcloud-captures', 'pages');

function storedPages(match: RegExp): { name: string; html: string; url: string }[] {
  if (!fs.existsSync(PAGES)) return [];
  return fs
    .readdirSync(PAGES)
    .filter((n) => match.test(n))
    .map((name) => {
      const j = JSON.parse(fs.readFileSync(path.join(PAGES, name), 'utf-8')) as {
        html?: string;
        canonicalUrl?: string;
        url?: string;
      };
      return { name, html: j.html ?? '', url: j.canonicalUrl ?? j.url ?? '' };
    })
    .filter((p) => p.html.length > 0);
}

const ctx = (url: string) =>
  ({ sourceUrl: url, retrievedAt: '2026-09-22T00:00:00.000Z', track: 'browser-extension' }) as never;

const EVENT_PAGES = storedPages(/_2f_event_2f_\d+_2f_/);
const ROSTER_PAGES = storedPages(/_2f_roster_2f/);
const HAVE_CAPTURE = EVENT_PAGES.length > 0 && ROSTER_PAGES.length > 0;

function parsedRosters(): SwimCloudRosterParse[] {
  const out: SwimCloudRosterParse[] = [];
  for (const page of ROSTER_PAGES) {
    const parsed = parseTeamRosterHtml(page.html, ctx(page.url));
    if (parsed.ok) out.push(parsed.data);
  }
  return out;
}

function parsedEvents(): SwimCloudMeetEventResultsParse[] {
  const out: SwimCloudMeetEventResultsParse[] = [];
  for (const page of EVENT_PAGES) {
    const parsed = parseMeetEventResultsHtml(page.html, ctx(page.url), {} as never);
    if (parsed.ok) out.push(parsed.data);
  }
  return out;
}

describe.skipIf(!HAVE_CAPTURE)('event-first import against the real capture', () => {
  const rosters = parsedRosters();
  const events = parsedEvents();
  const teamNames = buildSwimCloudTeamNameIndex(events);
  const converted = events.map((parse) =>
    swimCloudEventResultsToSwimmerResults(parse, { rosters, teamNames }),
  );
  const rows = converted.flatMap((c) => [...c.men, ...c.women]);
  const skips = converted.flatMap((c) => c.skipped);

  it('converts every row on every stored event page, skipping none', () => {
    // Zero skips is the claim. Any non-zero count here is a row that a coach's
    // scoreboard is missing, and the reason names which kind.
    expect(skips).toStrictEqual([]);
    expect(events).toHaveLength(EVENT_PAGES.length);
    expect(rows.length).toBeGreaterThan(1000);
  });

  it('keeps all 71 relay entries, with their legs', () => {
    // Was zero. Every one was skipped for having no team name, because a relay
    // table has no Team column.
    const relays = rows.filter((r) => r.isRelay === true);
    expect(relays).toHaveLength(71);
    for (const relay of relays) {
      expect(relay.relayNames, `${relay.name} ${relay.event} should carry its legs`).toBeDefined();
      expect((relay.relayNames ?? []).length).toBeGreaterThan(0);
    }
  });

  it('names a relay entry\'s team the way an individual row names it', () => {
    // The guard against "Henderson State (A)" becoming a team. If a designator
    // leaked in, the A and B relays would score as separate programs and
    // neither would join that team's individual swims.
    const relayTeams = new Set(rows.filter((r) => r.isRelay === true).map((r) => r.team));
    const individualTeams = new Set(rows.filter((r) => r.isRelay !== true).map((r) => r.team));
    expect([...relayTeams].sort()).toStrictEqual([
      'Delta State',
      'Henderson State',
      'Ouachita Baptist',
      'West Florida',
    ]);
    for (const team of relayTeams) {
      expect(individualTeams.has(team), `${team} should also appear on individual rows`).toBe(true);
    }
    for (const team of relayTeams) expect(team).not.toMatch(/\([A-Z]\)\s*$/);
  });

  it('reads the winning relay verbatim: team, place, doubled score, four legs', () => {
    // Pinned rather than counted. A positional bug in the leg pairing would
    // attach the wrong squad to the wrong team, and 40 is the championship
    // relay value for first place -- exactly 2x the individual 20, which is
    // what Rule 7 prescribes and what this repo's tables encode.
    const relay = rows.find(
      (r) => r.isRelay === true && r.event === '200 Medley Relay' && r.rank === 1 && r.team === 'Henderson State',
    );
    expect(relay).toBeDefined();
    expect(relay?.pdfPoints).toBe(40);
    expect(relay?.roundSwam).toBe('Timed Finals');
    expect((relay?.relayNames ?? []).map((l) => l.name)).toStrictEqual([
      'Avery Henke',
      'Oskar Cebula',
      'Colin Candebat',
      'Olivér Pózvai',
    ]);
  });

  it('skips a relay rather than scoring it under its "(A)" entry label', () => {
    // The mutation that proved this test was needed: adding "?? name" as a
    // fallback for a relay's team passed every other test in this file,
    // because the team-name index always resolves for this capture and the
    // fallback never ran. Converting WITHOUT the index is the only way to
    // reach that branch, so it is exercised here deliberately.
    //
    // Skipping is the right behaviour. "Henderson State (A)" as a team would
    // score the A and B relays as two separate programs and join neither to
    // that team's individual swims -- a wrong team total, which is worse than
    // a visibly absent row.
    const relayEvents = events.filter((parse) => parse.event.kind === 'relay');
    expect(relayEvents.length).toBeGreaterThan(0);

    const withoutIndex = relayEvents.map((parse) =>
      swimCloudEventResultsToSwimmerResults(parse, { rosters }),
    );
    const rowsWithoutIndex = withoutIndex.flatMap((c) => [...c.men, ...c.women]);
    const skipsWithoutIndex = withoutIndex.flatMap((c) => c.skipped);

    expect(rowsWithoutIndex).toStrictEqual([]);
    expect(skipsWithoutIndex).toHaveLength(71);
    expect(new Set(skipsWithoutIndex.map((s) => s.reason))).toStrictEqual(new Set(['no-team-name']));
    // The label is still reported as the skip's subject, so a coach can see
    // which entry was dropped -- it is just never promoted to a team.
    expect(skipsWithoutIndex.some((s) => /\([A-Z]\)$/.test(s.subject ?? ''))).toBe(true);
  });

  it('joins a class year onto all but eight individual rows', () => {
    // 1081 of 1089 individual rows. The eight are rows whose roster entry
    // prints no year; they are reported as such, never defaulted.
    const individual = rows.filter((r) => r.isRelay !== true);
    const known = individual.filter((r) => r.classYear !== 'unknown');
    expect(individual).toHaveLength(1089);
    expect(known).toHaveLength(1081);
    for (const row of known) expect(row.classYear).toMatch(/^(?:FR|SO|JR|SR|GR)$/);
  });

  it('gives a relay row no class year at all, and says why', () => {
    // A relay row names a team, not a person, so there is no swimmer id to
    // join on. "Unknown because there is nobody to look up" is a different
    // fact from "unknown because no roster was captured", and the gap names
    // which.
    const gaps = converted.reduce<Record<string, number>>((acc, c) => {
      for (const [reason, count] of Object.entries(c.classYearGaps)) {
        acc[reason] = (acc[reason] ?? 0) + count;
      }
      return acc;
    }, {});
    expect(gaps).toStrictEqual({ 'no-swimmer-id-to-join-on': 71, 'roster-prints-no-class-year': 8 });
    for (const relay of rows.filter((r) => r.isRelay === true)) {
      expect(relay.classYear).toBe('unknown');
    }
  });

  it('builds the class-year index by swimmer id, not by name', () => {
    const coverage = buildSwimCloudClassYearIndex(rosters);
    expect(coverage.index.size).toBe(184);
    // Every key is a SwimCloud swimmer id. A name key would mean the join had
    // silently become a name match, which INVARIANTS item 6 forbids.
    for (const key of coverage.index.keys()) expect(key).toMatch(/^\d+$/);
    expect(coverage.teamsWithRosters.sort()).toStrictEqual(['10002824', '412', '48', '58']);
  });

  it('carries the round on every row, so nothing imports as an unknown tier', () => {
    // An unknown tier scores as a full final in packages/core, so a round-less
    // row is a wrong score rather than a missing one.
    for (const row of rows) {
      expect(row.roundSwam, `${row.name} ${row.event}`).toBeDefined();
      expect((row.roundSwam ?? '').length).toBeGreaterThan(0);
    }
  });
});

describe('class-year gaps, one per reason', () => {
  const roster = (athletes: unknown[], over: Record<string, unknown> = {}): SwimCloudRosterParse =>
    ({
      swimCloudTeamId: '58',
      teamName: 'Henderson State',
      gender: 'Men',
      season: '2026-2027',
      athletes,
      rowCount: athletes.length,
      ...over,
    }) as SwimCloudRosterParse;

  it('separates "no roster captured" from "not on the roster"', () => {
    // The distinction a coach acts on: one means go and crawl a roster, the
    // other means the roster exists and this swimmer is not on it.
    const coverage = buildSwimCloudClassYearIndex([roster([{ swimCloudSwimmerId: '1', name: 'A', classYear: 'SR' }])]);
    expect(coverage.teamsWithRosters).toStrictEqual(['58']);
    expect(coverage.index.get('1')?.classYear).toBe('SR');
    expect(coverage.index.has('2')).toBe(false);
  });

  it('records a roster that parsed and listed nobody', () => {
    // UWF's men: a program that does not exist. The capture DID answer the
    // question, and the answer was no -- which is not the same as never having
    // asked, so the team is still recorded as covered.
    const coverage = buildSwimCloudClassYearIndex([roster([])]);
    expect(coverage.index.size).toBe(0);
    expect(coverage.teamsWithRosters).toStrictEqual(['58']);
    expect(coverage.rostersRead).toStrictEqual(['58:Men']);
  });

  it('skips a roster row with no swimmer id rather than keying it by name', () => {
    const coverage = buildSwimCloudClassYearIndex([roster([{ name: 'No Link', classYear: 'JR' }])]);
    expect(coverage.index.size).toBe(0);
  });

  it('lets the first roster win when a swimmer appears on two', () => {
    const coverage = buildSwimCloudClassYearIndex([
      roster([{ swimCloudSwimmerId: '9', name: 'Transfer', classYear: 'SO' }]),
      roster([{ swimCloudSwimmerId: '9', name: 'Transfer', classYear: 'SR' }], { swimCloudTeamId: '48' }),
    ]);
    expect(coverage.index.get('9')?.classYear).toBe('SO');
    expect(coverage.teamsWithRosters).toStrictEqual(['58', '48']);
  });
});
