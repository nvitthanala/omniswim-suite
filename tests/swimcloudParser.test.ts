/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `parseTeamRosterHtml` / `parseMeetResultsHtml` against the
 * hand-authored, explicitly synthetic fixtures in `tests/fixtures/`.
 *
 * These fixtures are NOT real SwimCloud markup — see the comment block at the
 * top of each fixture file and `packages/swimcloud/src/index.ts`'s module
 * doc. A green run here proves the parser does what its own extraction rules
 * say, nothing more; it is not evidence the parser will survive contact with
 * a real SwimCloud page. That happens once a human captures one real page
 * (plans/2026-09-06/04-phasing.md, open questions 2 and 4) and this suite
 * gets a second fixture pass against the diff.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMeetResultsHtml,
  parseTeamRosterHtml,
  type SwimCloudParseContext,
} from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function contextFor(sourceUrl: string): SwimCloudParseContext {
  return { sourceUrl, retrievedAt: '2026-09-06T00:00:00Z', track: 'synthetic-fixture' };
}

function warningCodes(warnings: readonly { code: string }[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe('parseTeamRosterHtml — swimcloud-synthetic-team-roster.html', () => {
  const html = fixture('swimcloud-synthetic-team-roster.html');
  const context = contextFor('https://www.swimcloud.com/team/633/roster/');

  it('reads the roster table, not the sidebar table', () => {
    const result = parseTeamRosterHtml(html, context, { gender: 'Women', season: '2026-2027' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.rowCount).toBe(3);
    expect(result.data.athletes).toHaveLength(3);
    // The sidebar's "Season / Meets" row must never surface as an athlete.
    expect(result.data.athletes.map((a) => a.name)).not.toContain('2026-2027');
  });

  it('extracts the normal case: profile link, class year, hometown', () => {
    const result = parseTeamRosterHtml(html, context, { gender: 'Women', season: '2026-2027' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.athletes[0]).toEqual({
      swimCloudSwimmerId: '3646504',
      name: 'Landon Dehn',
      swimCloudTeamId: '633',
      classYear: 'SO',
      gender: 'Women',
      season: '2026-2027',
      hometown: 'Little Rock, AR',
    });
  });

  it('decodes HTML entities in a long-form name and accepts an absolute profile URL', () => {
    const result = parseTeamRosterHtml(html, context, { gender: 'Women' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    const gonzalez = result.data.athletes[1];
    expect(gonzalez.name).toBe('Alan Alejan González Mujica');
    expect(gonzalez.swimCloudSwimmerId).toBe('3646511');
    expect(gonzalez.classYear).toBe('JR'); // "Junior" is in the known vocabulary
    expect(gonzalez.hometown).toBe('Caracas, VE');
  });

  it('flags a missing profile link and an unmapped class year on the same row, without inventing either', () => {
    const result = parseTeamRosterHtml(html, context, { gender: 'Women' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    const jordan = result.data.athletes[2];
    expect(jordan.name).toBe('Jordan Pike');
    expect(jordan.swimCloudSwimmerId).toBeUndefined();
    expect(jordan.classYear).toBe('unknown');
    expect(jordan.hometown).toBeUndefined(); // empty cell, never coerced to ''

    const codes = warningCodes(result.warnings);
    expect(codes).toContain('missing-athlete-link');
    expect(codes).toContain('unmapped-class-year');
    const classWarning = result.warnings.find((w) => w.code === 'unmapped-class-year');
    expect(classWarning?.raw).toBe('FY');
  });

  it('builds the team record only when id, name and gender are all known', () => {
    const withGender = parseTeamRosterHtml(html, context, { gender: 'Women' });
    if (!withGender.ok) throw new Error('expected success');
    expect(withGender.data.team).toEqual({
      swimCloudTeamId: '633',
      gender: 'Women',
      name: 'Henderson State University',
    });

    const withoutGender = parseTeamRosterHtml(html, context);
    if (!withoutGender.ok) throw new Error('expected success');
    expect(withoutGender.data.team).toBeUndefined(); // half-known team is not a team
  });

  it('marks every result with the synthetic-fixture-only confidence', () => {
    const result = parseTeamRosterHtml(html, context, { gender: 'Women' });
    expect(result.confidence).toBe('synthetic-fixture-only');
  });
});

describe('parseTeamRosterHtml — the missing-table case', () => {
  it('fails loudly instead of returning an empty roster', () => {
    const html = fixture('swimcloud-synthetic-team-roster-no-table.html');
    const context = contextFor('https://www.swimcloud.com/team/633/roster/');
    const result = parseTeamRosterHtml(html, context, { gender: 'Women' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.failure.code).toBe('expected-table-missing');
  });
});

describe('parseMeetResultsHtml — swimcloud-synthetic-meet-results.html', () => {
  const html = fixture('swimcloud-synthetic-meet-results.html');
  const context = contextFor('https://www.swimcloud.com/results/193735/');

  it('reads all four events and reports the meet-level shell', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.swimCloudMeetId).toBe('193735');
    expect(result.data.meetName).toBe('2026 NSISC Championships');
    expect(result.data.meet).toEqual({
      swimCloudMeetId: '193735',
      name: '2026 NSISC Championships',
      format: 'unknown', // never defaulted to 'dual' — SwimCloud doesn't publish this
      ruleset: 'unknown', // never defaulted to 'NCAA'
      course: 'unknown',
    });
    expect(result.data.eventHeadingCount).toBe(4);
    expect(result.data.events).toHaveLength(4);
  });

  it('parses the relay event: legs with splits, a leg-less row, and a DQ row', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    const relayEvent = result.data.events.find((e) => e.event.eventId === '193735:event:3');
    if (relayEvent === undefined) throw new Error('event 3 missing from output');

    expect(relayEvent.event.kind).toBe('relay');
    expect(relayEvent.event.course).toBe('SCY');
    expect(relayEvent.event.gender).toBe('Women');
    expect(relayEvent.event.distance).toBe(200);
    expect(relayEvent.event.stroke).toBe('Freestyle Relay');
    expect(relayEvent.relays).toHaveLength(3);

    const [first, second, third] = relayEvent.relays;
    expect(first.swimCloudTeamId).toBe('633');
    expect(first.designator).toBe('A');
    expect(first.legs).toHaveLength(4);
    expect(first.legs[0]).toEqual({
      order: 1,
      swimCloudSwimmerId: '3646504',
      athleteName: 'Landon Dehn',
      splitTime: '23.41',
    });
    expect(first.legs[1].athleteName).toBe('Alan Alejan González Mujica');
    expect(first.legs[1].splitTime).toBe('23.90');
    expect(relayEvent.results[0]).toMatchObject({ place: 1, finalTime: '1:34.12' });

    // Second row: no <ol> of legs at all.
    expect(second.designator).toBe('A');
    expect(second.teamName).toBe('Ouachita Baptist');
    expect(second.legs).toHaveLength(0);
    expect(relayEvent.results[1]).toMatchObject({ place: 2, finalTime: '1:35.60' });

    // Third row: the DQ'd 'B' relay — no place, no finalTime, disqualified flag,
    // and the raw "DQ" token is preserved rather than discarded.
    expect(third.designator).toBe('B');
    expect(third.legs).toHaveLength(0);
    expect(relayEvent.results[2].place).toBeUndefined();
    expect(relayEvent.results[2].finalTime).toBeUndefined();
    expect(relayEvent.results[2].flags).toEqual({ disqualified: true });
    expect(relayEvent.results[2].rawTimeToken).toBe('DQ');

    const codes = warningCodes(result.warnings);
    expect(codes.filter((c) => c === 'relay-legs-absent')).toHaveLength(2);
    expect(codes).toContain('points-column-ignored');
  });

  it('parses the individual event: exhibition, no-show, and an unrecognized time token', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    const event = result.data.events.find((e) => e.event.eventId === '193735:event:4');
    if (event === undefined) throw new Error('event 4 missing from output');

    expect(event.event.kind).toBe('individual');
    expect(event.event.gender).toBe('Men');
    expect(event.event.stroke).toBe('Butterfly');
    expect(event.results).toHaveLength(5);

    // Clean top two.
    expect(event.results[0]).toMatchObject({ place: 1, finalTime: '49.87' });
    expect(event.entries[0].swimCloudSwimmerId).toBe('3646504');
    expect(event.results[1]).toMatchObject({ place: 2, finalTime: '50.11' });

    // Exhibition: place "X" -> no place; time "X50.44" -> finalTime "50.44" + exhibition flag.
    expect(event.results[2].place).toBeUndefined();
    expect(event.results[2].finalTime).toBe('50.44');
    expect(event.results[2].flags).toEqual({ exhibition: true });

    // No-show, and a plain-text name with no profile link.
    expect(event.entries[3].swimCloudSwimmerId).toBeUndefined();
    expect(event.results[3].flags).toEqual({ noShow: true });
    expect(event.results[3].rawTimeToken).toBe('NS');
    expect(event.results[3].finalTime).toBeUndefined();

    // "22.9" is a tenths-precision time, not the hundredths this parser
    // requires: preserved verbatim, not padded, not silently accepted.
    expect(event.results[4].finalTime).toBeUndefined();
    expect(event.results[4].rawTimeToken).toBe('22.9');

    const codes = warningCodes(result.warnings);
    expect(codes).toContain('missing-athlete-link');
    expect(codes).toContain('unrecognized-time-token');
    const timeWarning = result.warnings.find((w) => w.code === 'unrecognized-time-token');
    expect(timeWarning?.raw).toBe('22.9');
  });

  it('leaves a metric event course unknown without a meet-level course override', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    const event = result.data.events.find((e) => e.event.eventId === '193735:event:12');
    if (event === undefined) throw new Error('event 12 missing from output');

    expect(event.event.course).toBe('unknown');
    expect(event.event.stroke).toBe('Breaststroke');
    expect(event.event.distance).toBe(200);

    const codes = warningCodes(result.warnings);
    expect(
      result.warnings.some((w) => w.code === 'ambiguous-metric-course' && w.eventId === '193735:event:12'),
    ).toBe(true);
  });

  it('resolves a metric event to a caller-supplied meet course', () => {
    const result = parseMeetResultsHtml(html, context, { meetCourse: 'LCM' });
    if (!result.ok) throw new Error('expected success');
    const event = result.data.events.find((e) => e.event.eventId === '193735:event:12');
    expect(event?.event.course).toBe('LCM');
    expect(result.warnings.some((w) => w.code === 'ambiguous-metric-course')).toBe(false);
  });

  it('records a diving score as a raw token, never as a time', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    const event = result.data.events.find((e) => e.event.eventId === '193735:event:20');
    if (event === undefined) throw new Error('event 20 missing from output');

    expect(event.event.stroke).toBe('Diving');
    expect(event.results[0].finalTime).toBeUndefined();
    expect(event.results[0].rawTimeToken).toBe('385.60');
    expect(
      result.warnings.some((w) => w.code === 'diving-score-not-a-time' && w.eventId === '193735:event:20'),
    ).toBe(true);
  });

  it('marks the whole parse synthetic-fixture-only', () => {
    const result = parseMeetResultsHtml(html, context);
    expect(result.confidence).toBe('synthetic-fixture-only');
  });
});

describe('parseMeetResultsHtml — swimcloud-synthetic-meet-results-empty-event.html', () => {
  const html = fixture('swimcloud-synthetic-meet-results-empty-event.html');
  const context = contextFor('https://www.swimcloud.com/results/193735/');

  it('tells "nothing posted yet" apart from "could not read this event"', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    // Two event headings on the page; only one produced a readable event.
    expect(result.data.eventHeadingCount).toBe(2);
    expect(result.data.events).toHaveLength(1);

    const [onlyEvent] = result.data.events;
    expect(onlyEvent.event.eventId).toBe('193735:event:1');
    expect(onlyEvent.results).toHaveLength(0);

    const codes = warningCodes(result.warnings);
    expect(codes).toContain('zero-data-rows'); // event 1: real table, zero rows
    expect(codes).toContain('unparsed-event'); // event 2: no header row, unreadable
  });
});

describe('parseMeetResultsHtml — a printed "0" place', () => {
  // Regression test for a real bug found by code review (2026-09-07):
  // readPlace's numeric branch converted "0" straight to `undefined` (places
  // start at 1) without ever reaching the unrecognized-place-token warning
  // every other malformed place cell gets — a silent empty with zero audit
  // trail, in a file whose whole stated discipline is "silent empties are
  // the top failure mode this repo guards against".
  const html = `
    <div class="c-page">
      <h1>Regression Fixture</h1>
      <section class="c-event">
        <h2>Event 1 Women 100 Yard Freestyle</h2>
        <table>
          <thead><tr><th>Place</th><th>Name</th><th>Team</th><th>Time</th></tr></thead>
          <tbody>
            <tr><td>1</td><td><a href="/swimmer/1/">Swimmer One</a></td><td>Team A</td><td>52.10</td></tr>
            <tr><td>0</td><td><a href="/swimmer/2/">Swimmer Two</a></td><td>Team A</td><td>53.00</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  `;
  const context = contextFor('https://www.swimcloud.com/results/1/');

  it('records no place for a "0" cell, and warns about it exactly like any other malformed place', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    const event = result.data.events[0];
    expect(event.results[0]).toMatchObject({ place: 1 });
    expect(event.results[1].place).toBeUndefined();

    const warning = result.warnings.find((w) => w.code === 'unrecognized-place-token' && w.raw === '0');
    expect(warning).toBeDefined();
  });
});

describe('parseTeamRosterHtml / parseMeetResultsHtml — shared failure modes', () => {
  it('rejects empty input for both parsers rather than returning an empty success', () => {
    const context = contextFor('https://www.swimcloud.com/team/633/roster/');
    const rosterResult = parseTeamRosterHtml('   ', context, { gender: 'Women' });
    expect(rosterResult.ok).toBe(false);
    if (!rosterResult.ok) expect(rosterResult.failure.code).toBe('empty-input');

    const meetContext = contextFor('https://www.swimcloud.com/results/193735/');
    const meetResult = parseMeetResultsHtml('   ', meetContext);
    expect(meetResult.ok).toBe(false);
    if (!meetResult.ok) expect(meetResult.failure.code).toBe('empty-input');
  });

  it('refuses to parse a roster page against a meet URL', () => {
    const wrongContext = contextFor('https://www.swimcloud.com/results/193735/');
    const result = parseTeamRosterHtml(
      fixture('swimcloud-synthetic-team-roster.html'),
      wrongContext,
      { gender: 'Women' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('source-url-mismatch');
  });

  it('requires a resolvable meet id: neither the URL nor the options name one', () => {
    const context = contextFor('not-a-url-at-all');
    const result = parseMeetResultsHtml(
      fixture('swimcloud-synthetic-meet-results.html'),
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('source-url-mismatch');
  });
});
