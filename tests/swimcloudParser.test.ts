/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Parser tests, in two halves — and the halves mean different things.
 *
 * **`swimcloud-synthetic-*.html`** (everything up to the "REAL SwimCloud
 * markup" banner) is hand-authored and is NOT real SwimCloud markup. A green
 * run over those proves the parser does what its own extraction rules say,
 * nothing more. It is not evidence any selector survives contact with the
 * site. `parseSwimmerProfileHtml` still has only this kind of evidence behind
 * it. `parseTeamRosterHtml` no longer does — its real evidence lives in
 * `tests/swimcloudTeamRosterParser.test.ts`, and the synthetic cases below are
 * kept for the no-table, no-heading and caller-supplied-fallback branches the
 * real captures do not reach.
 *
 * **`swimcloud-real-*.html`** is the 2026-09-08 human capture of meet 356467,
 * and assertions against it are evidence about SwimCloud. Those tests also
 * record what that capture disproved: `parseMeetResultsHtml`'s event-heading
 * page shape does not exist on the site, which is why `parseTeamMeetSwimsHtml`
 * was written.
 *
 * A real swimmer-profile page is still uncaptured (F7 in
 * `docs/reference/SWIMCLOUD_CAPTURE_STATE.json`), so nothing here is evidence
 * about what a swimmer's own event history looks like.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMeetEventResultsHtml,
  parseMeetResultsHtml,
  parseTeamMeetSwimsHtml,
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

  it('reports real-capture-verified confidence even on this synthetic page', () => {
    // `confidence` describes the extraction rules, not the input. Those rules
    // were rewritten against two real roster captures on 2026-09-09, so they
    // are real-capture-verified wherever they are pointed — including here.
    // See tests/swimcloudTeamRosterParser.test.ts for the real evidence.
    const result = parseTeamRosterHtml(html, context, { gender: 'Women' });
    expect(result.confidence).toBe('real-capture-verified');
  });

  it('records that gender and season came from the caller, not this page', () => {
    const result = parseTeamRosterHtml(html, context, { gender: 'Women', season: '2026-2027' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    // This fixture carries no "Season … Men/Women" card heading, so the caller's
    // options are the only source — and the parse says so rather than leaving a
    // reader to guess whether the page stated it.
    expect(result.data.genderSource).toBe('caller-supplied');
    expect(result.data.seasonSource).toBe('caller-supplied');
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
    expect(relayEvent.results[0]).toMatchObject({ place: 1, finalTime: '1:34.12', points: 40 });
    // The relay's SwimCloudEntry (not just its SwimCloudRelay) also carries the team name.
    expect(relayEvent.entries[0].teamName).toBe(first.teamName);

    // Second row: no <ol> of legs at all.
    expect(second.designator).toBe('A');
    expect(second.teamName).toBe('Ouachita Baptist');
    expect(second.legs).toHaveLength(0);
    expect(relayEvent.results[1]).toMatchObject({ place: 2, finalTime: '1:35.60', points: 34 });

    // Third row: the DQ'd 'B' relay — no place, no finalTime, disqualified flag,
    // the raw "DQ" token is preserved rather than discarded, and no points
    // (the fixture's Points cell is empty for this row — an empty cell is
    // not a warning-worthy case, plenty of DQ'd rows legitimately score
    // nothing on the printed page too).
    expect(third.designator).toBe('B');
    expect(third.legs).toHaveLength(0);
    expect(relayEvent.results[2].place).toBeUndefined();
    expect(relayEvent.results[2].finalTime).toBeUndefined();
    expect(relayEvent.results[2].points).toBeUndefined();
    expect(relayEvent.results[2].flags).toEqual({ disqualified: true });
    expect(relayEvent.results[2].rawTimeToken).toBe('DQ');

    const codes = warningCodes(result.warnings);
    expect(codes.filter((c) => c === 'relay-legs-absent')).toHaveLength(2);
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
    expect(event.results[0]).toMatchObject({ place: 1, finalTime: '49.87', points: 20 });
    expect(event.entries[0].swimCloudSwimmerId).toBe('3646504');
    expect(event.entries[0].athleteName).toBe('Landon Dehn');
    expect(event.entries[0].teamName).toBe('Henderson State');
    expect(event.results[1]).toMatchObject({ place: 2, finalTime: '50.11', points: 17 });
    expect(event.entries[1].teamName).toBe('Ouachita Baptist');

    // Exhibition: place "X" -> no place; time "X50.44" -> finalTime "50.44" + exhibition flag.
    expect(event.results[2].place).toBeUndefined();
    expect(event.results[2].finalTime).toBe('50.44');
    expect(event.results[2].flags).toEqual({ exhibition: true });

    // No-show, and a plain-text name with no profile link — the name is
    // still captured even though there's no id to link it to.
    expect(event.entries[3].swimCloudSwimmerId).toBeUndefined();
    expect(event.entries[3].athleteName).toBe('Casey Nolan');
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

    const _codes = warningCodes(result.warnings);
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

describe('parseMeetResultsHtml — points are captured, not discarded', () => {
  // Points used to be deliberately dropped by this file (see the Phase 1
  // commit) on the working assumption that a scraped points column
  // couldn't be trusted. Overridden 2026-09-07 on the user's direct
  // confirmation that SwimCloud's printed points are trustworthy — see
  // SwimCloudResult's doc comment in entities.ts for the full history.
  // This parser only *captures* the value; whether a caller trusts it for
  // scoring is that caller's decision, same as packages/core's
  // usePdfPlacePoints is a caller decision for a PDF import.
  const html = `
    <div class="c-page">
      <h1>Regression Fixture</h1>
      <section class="c-event">
        <h2>Event 1 Women 100 Yard Freestyle</h2>
        <table>
          <thead><tr><th>Place</th><th>Name</th><th>Team</th><th>Time</th><th>Points</th></tr></thead>
          <tbody>
            <tr><td>1</td><td><a href="/swimmer/1/">Swimmer One</a></td><td>Team A</td><td>52.10</td><td>20</td></tr>
            <tr><td>2</td><td><a href="/swimmer/2/">Swimmer Two</a></td><td>Team A</td><td>53.00</td><td></td></tr>
            <tr><td>3</td><td><a href="/swimmer/3/">Swimmer Three</a></td><td>Team A</td><td>54.00</td><td>garbage</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  `;
  const context = contextFor('https://www.swimcloud.com/results/1/');

  it('captures a well-formed points cell verbatim as a number', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.data.events[0].results[0].points).toBe(20);
  });

  it('leaves points absent for an empty cell, without any warning — a real zero-points row is not an error', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.events[0].results[1].points).toBeUndefined();
    expect(result.data.events[0].results[1].rawPointsToken).toBeUndefined();
    // Scoped to this row specifically — row 2 (the "garbage" cell, tested
    // separately below) does legitimately produce this warning code, so an
    // unscoped `.some()` over the whole warnings array would pass for the
    // wrong reason.
    expect(result.warnings.some((w) => w.code === 'unrecognized-points-token' && w.rowIndex === 1)).toBe(false);
  });

  it('preserves an unparseable points cell verbatim and warns, rather than guessing or silently dropping it', () => {
    const result = parseMeetResultsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.events[0].results[2].points).toBeUndefined();
    expect(result.data.events[0].results[2].rawPointsToken).toBe('garbage');
    const warning = result.warnings.find((w) => w.code === 'unrecognized-points-token' && w.raw === 'garbage');
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

/* ========================================================================== */
/* REAL SwimCloud markup                                                       */
/* ========================================================================== */

/**
 * Unlike everything above, these run against markup SwimCloud actually served:
 * the 2026-09-08 capture of meet 356467 (New South Championships), archived as
 * `tests/fixtures/swimcloud-real-*.html`.
 *
 * Every count asserted here was hand-counted from the fixture before the parser
 * ran against it. They are ground truth, not a snapshot of current behaviour —
 * if the parser changes and one of these moves, the parser is wrong, not the
 * test.
 */
const realContext = (sourceUrl: string): SwimCloudParseContext => ({
  sourceUrl,
  retrievedAt: '2026-09-08T00:00:00Z',
  track: 'browser-extension',
});

describe('parseTeamMeetSwimsHtml — real capture, full swims list (page 1 of 8)', () => {
  const html = fixture('swimcloud-real-meet-team-swims-356467-team58-page1.html');
  const context = realContext('https://www.swimcloud.com/results/356467/team/58/swims/');

  function parsed() {
    const result = parseTeamMeetSwimsHtml(html, context);
    if (!result.ok) {
      throw new Error(`expected success, got ${result.failure.code}: ${result.failure.message}`);
    }
    return result;
  }

  it('reads all 30 rows with no warnings at all', () => {
    const result = parsed();
    expect(result.data.rowCount).toBe(30);
    expect(result.data.swims).toHaveLength(30);
    // Not "few warnings" — none. Every column, cell and link on a real page is
    // accounted for, so any warning here is a genuine regression.
    expect(warningCodes(result.warnings)).toStrictEqual([]);
  });

  it('reports real-capture confidence, unlike every other parser in the file', () => {
    expect(parsed().confidence).toBe('real-capture-verified');
    const synthetic = parseMeetResultsHtml(
      fixture('swimcloud-synthetic-meet-results.html'),
      contextFor('https://www.swimcloud.com/results/193735/'),
    );
    expect(synthetic.confidence).toBe('synthetic-fixture-only');
  });

  it('flags exactly the three relay leadoff splits, by title and not by event name', () => {
    const leadoffs = parsed().data.swims.filter((swim) => swim.relayLeadoff);
    expect(leadoffs).toHaveLength(3);
    expect(
      leadoffs.map((swim) => [swim.rowOrdinal, swim.entry.swimCloudSwimmerId, swim.event.label]),
    ).toStrictEqual([
      [7, '1865160', '100 Y Free'],
      [18, '1330318', '50 Y Back'],
      [21, '2360022', '200 Y Free'],
    ]);
    // The flag also reaches the result, which is what the scoring bridge reads.
    for (const swim of leadoffs) {
      expect(swim.result.flags?.relayLeadoff).toBe(true);
    }
  });

  it('distinguishes a leadoff split from a real individual swim of the same event', () => {
    const swims = parsed().data.swims;

    // Row 7 is a leadoff "100 Y Free". Rows 9 and 25 are genuine individual
    // 100 Y Free swims by another athlete. Identical event text, opposite
    // meaning: nothing but the title="Leadoff" badge separates them.
    const hundredFree = swims.filter((swim) => swim.event.label === '100 Y Free');
    expect(hundredFree.map((swim) => swim.rowOrdinal)).toStrictEqual([7, 9, 25]);
    expect(hundredFree.map((swim) => swim.relayLeadoff)).toStrictEqual([true, false, false]);

    // Row 21 is a leadoff "200 Y Free" and is the only 200 Y Free on the page,
    // so a filter trusting the event name alone would drop a whole real event.
    expect(swims.filter((swim) => swim.event.label === '200 Y Free')).toHaveLength(1);
  });

  it('does not confuse "unplaced" with "leadoff"', () => {
    const swims = parsed().data.swims;
    const unplaced = swims.filter((swim) => swim.result.place === undefined);
    // Four rows are unplaced; only three are leadoff splits. Row 20 is an
    // ordinary swim that did not place, so inferring the leadoff flag from a
    // missing place would flag it wrongly.
    expect(unplaced.map((swim) => swim.rowOrdinal)).toStrictEqual([7, 18, 20, 21]);
    expect(unplaced.filter((swim) => swim.relayLeadoff)).toHaveLength(3);
    const rowTwenty = swims[19];
    expect(rowTwenty.rowOrdinal).toBe(20);
    expect(rowTwenty.result.place).toBeUndefined();
    expect(rowTwenty.relayLeadoff).toBe(false);
  });

  it('reads ordinal places, and leaves an en-dash place absent rather than zero', () => {
    const swims = parsed().data.swims;
    expect(swims[0].result.place).toBe(1); // "1st"
    expect(swims[2].result.place).toBe(3); // "3rd"
    expect(swims[15].result.place).toBe(17); // "17th" — the two-digit case
    expect(swims[6].result.place).toBeUndefined(); // en dash, U+2013
    expect(swims[6].result).not.toHaveProperty('place');
  });

  it('reports pagination: page 1 of 8, with the next-page link as printed', () => {
    expect(parsed().data.pagination).toStrictEqual({
      currentPage: 1,
      totalPages: 8,
      nextPageHref: '?page=2',
    });
  });

  it('gives every swim a distinct, stable key from its own SwimCloud swim id', () => {
    const swims = parsed().data.swims;
    expect(new Set(swims.map((swim) => swim.swimKey)).size).toBe(30);
    expect(swims[0].swimCloudSwimId).toBe('171560736');
    expect(swims[0].swimKey).toBe('356467:swim:171560736');
    // Every row carried one, so no row fell back to a composite key.
    expect(swims.filter((swim) => swim.swimCloudSwimId === undefined)).toHaveLength(0);
  });

  it('takes each row event from its time link, not from the printed label', () => {
    const result = parsed();
    const swims = result.data.swims;
    // Rows 1 and 4 both print "100 Y Breast" and belong to different events
    // (26 and 100). The label cannot tell them apart; the link can.
    expect(swims[0].event.label).toBe('100 Y Breast');
    expect(swims[3].event.label).toBe('100 Y Breast');
    expect(swims[0].event.eventRef).toBe('26');
    expect(swims[3].event.eventRef).toBe('100');
    expect(swims[0].event.eventId).not.toBe(swims[3].event.eventId);
    expect(result.data.events).toHaveLength(14);
  });

  it('reads distance, course and stroke out of the "{n} Y {stroke}" label shape', () => {
    const swims = parsed().data.swims;
    expect(swims[0].event).toMatchObject({ distance: 100, course: 'SCY', stroke: 'Breaststroke' });
    expect(swims[2].event).toMatchObject({ distance: 1000, course: 'SCY', stroke: 'Freestyle' });
    expect(swims[4].event).toMatchObject({
      distance: 200,
      course: 'SCY',
      stroke: 'Individual Medley',
    });
    expect(swims[7].event).toMatchObject({ distance: 200, course: 'SCY', stroke: 'Butterfly' });
    expect(swims[17].event).toMatchObject({ distance: 50, course: 'SCY', stroke: 'Backstroke' });
    expect(swims[25].event).toMatchObject({ distance: 1650, course: 'SCY', stroke: 'Freestyle' });
  });

  it('reads the athlete id from the meet-scoped /results/{id}/swimmer/ link', () => {
    const swims = parsed().data.swims;
    // Every row links its athlete, and the id is what identifies them — the
    // printed name is the ambiguous part. Row 12 is the long-form
    // "Alan Alejan Gonzalez Mujica" this repo already has an aliasing story about.
    expect(swims.filter((swim) => swim.entry.swimCloudSwimmerId === undefined)).toHaveLength(0);
    expect(swims[0].entry.swimCloudSwimmerId).toBe('1330318');
    expect(swims[11].entry.athleteName).toBe('Alan Alejan Gonzalez Mujica');
    expect(new Set(swims.map((swim) => swim.entry.swimCloudSwimmerId)).size).toBe(12);
  });

  it('decodes accented names rather than mangling or emptying them', () => {
    expect(parsed().data.swims[8].entry.athleteName).toBe('Olivér Pózvai');
  });

  it('reads meet and team identity from the page, not from assumptions', () => {
    const data = parsed().data;
    expect(data.meetName).toBe('New South Championships');
    expect(data.meet).toStrictEqual({
      swimCloudMeetId: '356467',
      name: 'New South Championships',
      format: 'unknown', // never defaulted to 'dual'
      ruleset: 'unknown', // never defaulted to 'NCAA'
      course: 'SCY', // the page printed it
      startDate: '2026-02-17',
      endDate: '2026-02-21',
    });
    expect(data.team).toStrictEqual({
      swimCloudTeamId: '58',
      gender: 'Men',
      name: 'Henderson State University',
    });
    // Read from the printed word on the dropdown's active item, not from ?gender=.
    expect(data.gender).toBe('Men');
    expect(data.entryCount).toBe(134);
  });

  it('captures the one cut-standard badge variety without resolving it to a time', () => {
    const swims = parsed().data.swims;
    const badges = new Set(
      swims.flatMap((swim) => swim.cutStandards.map((cut) => `${cut.label}|${cut.title ?? ''}`)),
    );
    expect([...badges]).toStrictEqual(['D2 B|NCAA Division II Championship']);
    expect(swims.filter((swim) => swim.cutStandards.length > 0)).toHaveLength(11);
    // Row 7 carries a cut badge and the leadoff badge in one cell.
    expect(swims[6].cutStandards).toHaveLength(1);
    expect(swims[6].relayLeadoff).toBe(true);
    // Row 18's flags cell holds the leadoff badge and nothing else.
    expect(swims[17].cutStandards).toHaveLength(0);
    expect(swims[17].relayLeadoff).toBe(true);
  });

  it('captures the Pts column but reports no meet score, because the page has none', () => {
    const swims = parsed().data.swims;
    // "Pts" is SwimCloud's power index. It is captured verbatim...
    expect(swims[0].result.points).toBe(767);
    expect(swims[29].result.points).toBe(692);
    // ...and it is not a meet score. This page has no Score column at all, so
    // meetScore is absent everywhere — absent, not zero. Henderson State's real
    // meet score is 1056, while these 30 rows alone sum past 21,000.
    expect(swims.filter((swim) => swim.meetScore !== undefined)).toHaveLength(0);
    const pointsSum = swims.reduce((total, swim) => total + (swim.result.points ?? 0), 0);
    expect(pointsSum).toBeGreaterThan(21000);
  });

  it('reads every time, including the minutes-and-seconds ones', () => {
    const swims = parsed().data.swims;
    expect(swims.filter((swim) => swim.result.finalTime === undefined)).toHaveLength(0);
    expect(swims[0].result.finalTime).toBe('54.09');
    expect(swims[2].result.finalTime).toBe('9:26.63');
    expect(swims[25].result.finalTime).toBe('16:00.67');
  });

  it('lets the page body outrank the URL on gender', () => {
    const result = parseTeamMeetSwimsHtml(
      html,
      realContext('https://www.swimcloud.com/results/356467/team/58/swims/?gender=F&page=2'),
    );
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    // The URL claims F. The page body says Men and wins, because the ?gender=
    // encoding is not something this package has decided to trust.
    expect(result.data.gender).toBe('Men');
  });
});

describe('parseTeamMeetSwimsHtml — real capture, the two summary pages', () => {
  const landing = () => {
    const result = parseTeamMeetSwimsHtml(
      fixture('swimcloud-real-meet-landing-356467.html'),
      realContext('https://www.swimcloud.com/results/356467/'),
    );
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    return result;
  };

  it('parses the meet-root summary card without claiming a page count it lacks', () => {
    const result = landing();
    const data = result.data;

    // The fixture keeps one of the card's five rows; the rest were trimmed as
    // "same shape". One row parses, and nothing pretends there are more.
    expect(data.rowCount).toBe(1);
    expect(warningCodes(result.warnings)).toStrictEqual([]);
    // No pagination widget on this page: absent means one page, never "unknown".
    expect(data.pagination).toBeUndefined();
    expect(data).not.toHaveProperty('pagination');

    // A meet-root capture is scoped to no team, so there is no team record —
    // even though the row itself names one.
    expect(data.swimCloudTeamId).toBeUndefined();
    expect(data.team).toBeUndefined();

    const swim = data.swims[0];
    expect(swim.entry.athleteName).toBe('Mateus Franco');
    expect(swim.entry.teamName).toBe('Delta State');
    expect(swim.entry.swimCloudTeamId).toBe('48');
    expect(swim.event).toMatchObject({ eventRef: '4', distance: 1000, course: 'SCY' });
  });

  it('reads Score and Pts as the different quantities they are', () => {
    const swim = landing().data.swims[0];
    // One row, two columns, two numbers: 20 meet points for a first-place
    // 1000 Free, and 846 on SwimCloud's power index. This single row is the
    // proof that the Pts column is not a meet score.
    expect(swim.meetScore).toBe(20);
    expect(swim.result.points).toBe(846);
  });

  it('ignores the Teams and High point cards and finds the results card', () => {
    // The page carries three tables. The standings card would yield "Henderson
    // State" as a swimmer and the high-point card a swimmer with no swim;
    // neither has both an Event and a Time column, so neither is chosen.
    expect(landing().data.swims.map((swim) => swim.entry.athleteName)).toStrictEqual([
      'Mateus Franco',
    ]);
  });

  it('parses the team-landing summary card and reads its Entries splash-stat', () => {
    const result = parseTeamMeetSwimsHtml(
      fixture('swimcloud-real-meet-team-landing-356467-team58.html'),
      realContext('https://www.swimcloud.com/results/356467/team/58/'),
    );
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    const data = result.data;

    expect(data.rowCount).toBe(1);
    expect(warningCodes(result.warnings)).toStrictEqual([]);
    expect(data.pagination).toBeUndefined();
    // 134 entries against a card showing one row. The stat is the page telling
    // you the capture is partial; rowCount is not comparable to it.
    expect(data.entryCount).toBe(134);
    expect(data.team).toStrictEqual({
      swimCloudTeamId: '58',
      gender: 'Men',
      name: 'Henderson State University',
    });
    // The name comes from the bare /team/58 link, not from the gender
    // dropdown's /results/356467/team/58/?gender=M link, whose text is "Men".
    expect(data.teamName).toBe('Henderson State University');
  });

  it('gives a row the same swim key on the summary page and the full list', () => {
    const summary = parseTeamMeetSwimsHtml(
      fixture('swimcloud-real-meet-team-landing-356467-team58.html'),
      realContext('https://www.swimcloud.com/results/356467/team/58/'),
    );
    const full = parseTeamMeetSwimsHtml(
      fixture('swimcloud-real-meet-team-swims-356467-team58-page1.html'),
      realContext('https://www.swimcloud.com/results/356467/team/58/swims/'),
    );
    if (!summary.ok || !full.ok) throw new Error('expected both to parse');
    // Avery Henke's 54.09 appears on both pages and is one swim. A caller
    // merging captures must see one row, not two.
    expect(summary.data.swims[0].swimKey).toBe(full.data.swims[0].swimKey);
    expect(summary.data.swims[0].swimKey).toBe('356467:swim:171560736');
  });
});

describe('parseMeetResultsHtml — regression: its page shape is not real', () => {
  /**
   * This is the finding that made `parseTeamMeetSwimsHtml` necessary, pinned so
   * it cannot be quietly rediscovered.
   *
   * `parseMeetResultsHtml` reads a meet page as event headings each governing a
   * table. A real meet-root page has exactly one heading — the meet's title —
   * and no per-event heading anywhere; its event list is a list of links. So the
   * function fails on the real page, and the message below is verbatim what a
   * user saw when they pressed "From SwimCloud" in Matrix.
   */
  it('fails with expected-header-missing on the real meet-root capture', () => {
    const result = parseMeetResultsHtml(
      fixture('swimcloud-real-meet-landing-356467.html'),
      realContext('https://www.swimcloud.com/results/356467/'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('expected-header-missing');
    expect(result.failure.message).toBe(
      'No heading matched the expected "Event {n} {Gender} {Distance} {Unit} {Stroke}" shape.',
    );
  });

  it('now refuses a team-scoped capture URL before it even reads the HTML', () => {
    // Second-order effect of modelling the team-scoped kinds: these URLs used
    // to classify as `unknown-path`, so `parseMeetResultsHtml` accepted them and
    // failed later on the markup. It now recognizes them as a resource it does
    // not handle and says so up front, which is the better error.
    for (const [name, url] of [
      [
        'swimcloud-real-meet-team-landing-356467-team58.html',
        'https://www.swimcloud.com/results/356467/team/58/',
      ],
      [
        'swimcloud-real-meet-team-swims-356467-team58-page1.html',
        'https://www.swimcloud.com/results/356467/team/58/swims/',
      ],
    ] as const) {
      const result = parseMeetResultsHtml(fixture(name), realContext(url), { meetId: '356467' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('source-url-mismatch');
    }
  });

  it('also fails on the team-scoped markup itself, not merely on its URL', () => {
    // Same HTML, handed in under a meet-root URL so the URL check passes. It
    // still finds no event heading, which is the point: the failure is the page
    // shape, not the address it came from.
    for (const name of [
      'swimcloud-real-meet-team-landing-356467-team58.html',
      'swimcloud-real-meet-team-swims-356467-team58-page1.html',
    ]) {
      const result = parseMeetResultsHtml(
        fixture(name),
        realContext('https://www.swimcloud.com/results/356467/'),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('expected-header-missing');
    }
  });

  it('still works on the synthetic fixture it was written against', () => {
    // Kept deliberately: the failures above are about SwimCloud's real page
    // shape, not about this function being broken in itself.
    const result = parseMeetResultsHtml(
      fixture('swimcloud-synthetic-meet-results.html'),
      contextFor('https://www.swimcloud.com/results/193735/'),
    );
    expect(result.ok).toBe(true);
  });
});

/* ========================================================================== */
/* REAL SwimCloud markup — the per-event results page (fixture F9)             */
/* ========================================================================== */

/**
 * `/results/356467/event/26/` — "100 Breast Men Finals", captured 2026-09-10 by
 * the user specifically to resolve the prelims/finals ambiguity documented in
 * `plans/2026-09-10/01-SWIMCLOUD-SCORING-CORRECTNESS.md`.
 *
 * Every count and value asserted below was read out of the fixture by hand
 * before the parser ran against it. They are ground truth: if the parser
 * changes and one of these moves, the parser is wrong, not the test.
 *
 * **What this fixture does not cover**, and so what no test here can claim: a
 * diving event, a DQ or scratch row on this page type, a relay event's page,
 * and a single-round timed-final event (expected to print one table with no
 * round caption, but never captured). Those are gaps in the evidence, not gaps
 * in the assertions — see `parseMeetEventResultsHtml`'s own doc comment.
 */
describe('parseMeetEventResultsHtml — real capture, per-event results (F9)', () => {
  const html = fixture('swimcloud-real-meet-event-356467-event26.html');
  const context = realContext('https://www.swimcloud.com/results/356467/event/26/');

  function parsed() {
    const result = parseMeetEventResultsHtml(html, context);
    if (!result.ok) {
      throw new Error(`expected success, got ${result.failure.code}: ${result.failure.message}`);
    }
    return result;
  }

  it('reads all four rounds and all 40 rows, warning only that the fixture is trimmed', () => {
    const result = parsed();
    expect(result.data.rowCount).toBe(40);
    // Every column, cell and link on a real page is accounted for, so any
    // warning beyond the one below is a genuine regression.
    //
    // `event-index-absent` is that one, and it is correct: this fixture was
    // trimmed of the Events sidebar, which is where a real page prints its
    // event index. Asserted as an exact single-element list rather than
    // relaxed to "non-empty", so the guard keeps its full strength — a second
    // warning appearing still fails here. The index itself is proven against
    // the 51 untrimmed stored pages in tests/meetEventIndex.test.ts.
    expect(warningCodes(result.warnings)).toStrictEqual(['event-index-absent']);
    expect(result.confidence).toBe('real-capture-verified');
  });

  it('splits the page into its four captioned rounds, in printed (program) order', () => {
    // Printed order, not chronological: Preliminaries happened first and prints
    // last. The parser preserves the page's order and does not re-sort it.
    expect(parsed().data.rounds.map(round => [round.round, round.rowCount])).toStrictEqual([
      ['A Final', 8],
      ['B Final', 7],
      ['C Final', 5],
      ['Preliminaries', 20],
    ]);
  });

  it('keeps the caption verbatim so classifyRoundTier can read it unchanged', () => {
    // The whole point of not mapping to a tier here: these four strings are
    // already `packages/core`'s vocabulary — 'A', 'B', 'C', 'PRE'.
    expect(parsed().data.rounds.map(round => round.round)).toStrictEqual([
      'A Final',
      'B Final',
      'C Final',
      'Preliminaries',
    ]);
  });

  it('reads the real meet Score from A/B Final and the power index from C Final/Prelims', () => {
    const [aFinal, bFinal, cFinal, prelims] = parsed().data.rounds;
    expect([aFinal.pointsColumn, bFinal.pointsColumn, cFinal.pointsColumn, prelims.pointsColumn]).toStrictEqual([
      'score',
      'score',
      'pts',
      'pts',
    ]);

    // A real NCAA point table's values, out of a `u-is-hidden` cell — hidden
    // from the rendered page, present in the markup.
    expect(aFinal.swims.map(swim => swim.meetScore)).toStrictEqual([20, 17, 16, 15, 14, 13, 12, 11]);
    expect(bFinal.swims.map(swim => swim.meetScore)).toStrictEqual([9, 7, 6, 5, 4, 3, 2]);

    // The rounds that do not score carry no meetScore at all — absent, never
    // zero — and their Pts is the power index, kept in `result.points`.
    expect(cFinal.swims.every(swim => swim.meetScore === undefined)).toBe(true);
    expect(prelims.swims.every(swim => swim.meetScore === undefined)).toBe(true);
    expect(cFinal.swims.map(swim => swim.result.points)).toStrictEqual([709, 638, 547, 502, 424]);
  });

  it('resolves the Avery Henke duplicate this whole investigation started from', () => {
    // Her two "100 Y Breast" rows on the team-swims list — 54.09 (swim
    // 171560736) and 54.27 (swim 171560737) — are the two swims below, and the
    // *slower* one is the A Final. That is why the swims list's "Place" could
    // never be trusted: both rows read 1st, in two different pools.
    const rounds = parsed().data.rounds;
    const aFinal = rounds[0].swims.find(swim => swim.entry.athleteName === 'Avery Henke');
    const prelim = rounds[3].swims.find(swim => swim.entry.athleteName === 'Avery Henke');
    expect(aFinal).toMatchObject({
      swimKey: '356467:swim:171560737',
      swimCloudSwimId: '171560737',
      roundLabel: 'A Final',
      meetScore: 20,
    });
    expect(aFinal?.result.finalTime).toBe('54.27');
    expect(aFinal?.result.place).toBe(1);
    expect(prelim).toMatchObject({
      swimKey: '356467:swim:171560736',
      swimCloudSwimId: '171560736',
      roundLabel: 'Preliminaries',
    });
    expect(prelim?.result.finalTime).toBe('54.09');
    expect(prelim?.meetScore).toBeUndefined();
  });

  it('builds the same swimKey shape the swims list does, so the two pages join', () => {
    // This is the join the import depends on. The swims-list fixture's Henke
    // rows carry these exact ids; a different key shape here would make the
    // whole round-resolution path silently match nothing.
    const keys = parsed().data.rounds.flatMap(round => round.swims.map(swim => swim.swimKey));
    expect(keys).toHaveLength(40);
    expect(new Set(keys).size).toBe(40);
    expect(keys.every(key => key.startsWith('356467:swim:'))).toBe(true);
  });

  it('marks exhibition from the rank cell, not from a leading X on the time', () => {
    const rounds = parsed().data.rounds;
    // All five C Final swimmers are exhibition, and the same five appear again
    // in Preliminaries also marked exhibition — SwimCloud tags a swimmer
    // consistently across every round they appear in on the page.
    expect(rounds[2].swims.map(swim => swim.exhibition)).toStrictEqual([true, true, true, true, true]);
    expect(rounds[3].swims.filter(swim => swim.exhibition).map(swim => swim.entry.athleteName)).toStrictEqual([
      'Camden Mask',
      'Benjamin Skinner',
      'Theo Scarpino',
      'Donovan Stangl',
      'Aiden Killackey',
    ]);
    // The flag reaches the result too, which is what the scoring bridge reads.
    expect(rounds[2].swims.every(swim => swim.result.flags?.exhibition === true)).toBe(true);
    // An exhibition row has NO place: the marker replaced the ordinal, so the
    // page printed none. Absent, not zero, and not a parse failure.
    expect(rounds[2].swims.every(swim => swim.result.place === undefined)).toBe(true);
    // And the time cells carry a bare time — no leading `X` anywhere on this
    // page — so `readTime`'s Hy-Tek guess never fires here.
    expect(rounds[2].swims.every(swim => swim.result.rawTimeToken === undefined)).toBe(true);
  });

  it('reads the athlete name from the swimmer link, not the whole name cell', () => {
    // The cell repeats the team in a mobile-only <div>. Taking the cell's text
    // would produce "Avery Henke Henderson State" — a plausible-looking name
    // that matches no roster and no swims-list row.
    expect(parsed().data.rounds[0].swims.map(swim => swim.entry.athleteName)).toStrictEqual([
      'Avery Henke',
      'Jacob Hamblen',
      'Justin Oulette',
      'Neill Mauss',
      'Ethan Baylin',
      'Oskar Cebula',
      'Mark Eberhard',
      'Gavin Kock',
    ]);
  });

  it('reads gender from the dropdown label, never from the event id', () => {
    // The gender toggle on THIS page points at /event/100/ (Men) and
    // /event/400/ (Women) — neither near event 26, and neither carrying a
    // `?gender=` parameter. Arithmetic on the id would answer wrongly; the
    // printed word answers correctly.
    expect(parsed().data.gender).toBe('Men');
    expect(html).toContain('/results/356467/event/400/');
  });

  it('reads the event from the page rather than the URL, with the page-level course', () => {
    const { data } = parsed();
    expect(data.eventRef).toBe('26');
    expect(data.eventLabel).toBe('100 Breast');
    expect(data.event).toMatchObject({
      // The same eventId the swims list builds for a row linking /event/26/,
      // which is what lets the two page types talk about one event.
      eventId: '356467:event:26',
      eventRef: '26',
      label: '100 Breast',
      kind: 'individual',
      // No course letter on this page's label — SCY comes from
      // <li id="meet-course">, page-level.
      course: 'SCY',
      distance: 100,
      stroke: 'Breaststroke',
      gender: 'Men',
    });
    expect(data.meetName).toBe('New South Championships');
  });

  it('reads team links and cut-standard badges out of unlabeled columns', () => {
    const aFinal = parsed().data.rounds[0].swims;
    expect(aFinal[0].entry).toMatchObject({ teamName: 'Henderson State', swimCloudTeamId: '58' });
    // Justin Oulette's row carries a D2 B badge in a column whose <th> is
    // empty — this page labels no "Flags" column, unlike the swims list.
    expect(aFinal[2].cutStandards).toStrictEqual([
      { label: 'D2 B', title: 'NCAA Division II Championship' },
    ]);
    // A PB/SB chip is not a cut standard and must not become one.
    expect(aFinal[1].cutStandards).toStrictEqual([]);
  });

  it('keeps a tie as a tie rather than renumbering it', () => {
    // Preliminaries prints 7, 7, 9 — two swimmers at 56.24. Nothing here
    // re-ranks them.
    expect(parsed().data.rounds[3].swims.slice(0, 9).map(swim => swim.result.place)).toStrictEqual([
      1, 2, 3, 4, 5, 6, 7, 7, 9,
    ]);
  });

  it('refuses a capture URL that is not a per-event results page', () => {
    const result = parseMeetEventResultsHtml(
      html,
      realContext('https://www.swimcloud.com/results/356467/team/58/swims/'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('source-url-mismatch');
  });

  it('never returns a silent success on a page of the wrong shape', () => {
    // The team-landing page carries a results card with Name/Time but no round
    // captions at all. Whatever the outcome, it must be loud: either a parse
    // failure, or rounds whose `round` is absent with the warning that says so.
    // What it must never be is a plausible-looking parse a caller would score.
    const result = parseMeetEventResultsHtml(
      fixture('swimcloud-real-meet-team-landing-356467-team58.html'),
      realContext('https://www.swimcloud.com/results/356467/event/26/'),
    );
    if (result.ok) {
      expect(result.data.rounds.every(round => round.round === undefined)).toBe(true);
      expect(warningCodes(result.warnings)).toContain('missing-round-caption');
    } else {
      expect(['expected-header-missing', 'expected-table-missing']).toContain(result.failure.code);
    }
  });
});
