/**
 * A9: relay designators and the "relay row with no legs" warning, against the
 * real captured event pages in tests/fixtures.
 *
 * - `readRelayDesignator` used to accept only a quoted letter ('A'), which no
 *   real page prints. Real pages print `Henderson State (A)`. The printed names
 *   below are read out of the fixture, not typed here.
 * - `parseMeetEventResultsHtml` used to say nothing when a relay row read no
 *   legs. It now raises `relay-row-without-legs`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMeetEventResultsHtml, readRelayDesignator } from '@omniswim/swimcloud/parser';
import { classifyWarningSeverity } from '@omniswim/matrix/lib/swimCloudImportDiagnostics';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const RELAY_HTML = fs.readFileSync(path.join(FIXTURES, 'swimcloud-real-meet-event-401354-event22-relay-names.html'), 'utf8');
const INDIVIDUAL_HTML = fs.readFileSync(path.join(FIXTURES, 'swimcloud-real-meet-event-356467-event26.html'), 'utf8');

const CTX = (meet: string, event: string) =>
  ({ sourceUrl: `https://www.swimcloud.com/results/${meet}/event/${event}/`, retrievedAt: '2026-10-09T00:00:00.000Z', track: 'browser-extension' }) as never;

function parse(html: string, meet: string, event: string) {
  const r = parseMeetEventResultsHtml(html, CTX(meet, event), {} as never);
  if (!r.ok) throw new Error(`fixture failed to parse: ${JSON.stringify(r)}`);
  return r;
}

/** The relay names a real page prints, taken from the markup: `<span ...>Henderson State (A)</span>`. */
function printedRelayNames(html: string): string[] {
  return [...html.matchAll(/<span class="u-inline-block@sm">([^<]*\([A-Z]\))<\/span>/g)].map(m => m[1]);
}

describe('readRelayDesignator on what real pages print', () => {
  const printed = printedRelayNames(RELAY_HTML);

  it('the fixture really prints parenthesised designators (guards the test itself)', () => {
    expect(printed.length).toBeGreaterThan(0);
    expect(printed).toContain('Henderson State (A)');
  });

  it('reads the letter and strips it from the team name', () => {
    for (const name of printed) {
      const letter = /\(([A-Z])\)$/.exec(name)![1];
      expect(readRelayDesignator(name), name).toStrictEqual({
        teamName: name.replace(/\s*\([A-Z]\)$/, ''),
        designator: letter,
      });
    }
  });

  it('still reads the quoted shape the synthetic fixture uses', () => {
    expect(readRelayDesignator("Henderson State 'B'")).toStrictEqual({ teamName: 'Henderson State', designator: 'B' });
  });

  it('does not invent a designator', () => {
    expect(readRelayDesignator('Henderson State')).toBeUndefined();
    expect(readRelayDesignator('Texas (AM)')).toBeUndefined(); // two letters: part of the name
    expect(readRelayDesignator('(A)')).toBeUndefined(); // no team name left
  });
});

describe('relay-row-without-legs', () => {
  const intact = parse(RELAY_HTML, '401354', '22');
  const swims = intact.data.rounds.flatMap(round => round.swims);

  it('is silent when every relay row has its legs (the real page, unmodified)', () => {
    expect(swims.length).toBeGreaterThan(0);
    for (const swim of swims) expect(swim.relayLegs?.length ?? 0, swim.entry.athleteName).toBeGreaterThan(0);
    expect(intact.warnings.filter(w => w.code === 'relay-row-without-legs')).toStrictEqual([]);
  });

  it('warns once per relay row when the hidden leg lists are gone', () => {
    // Same page with the page's own leg-list marker class renamed: the rows
    // stay, the legs cannot be found.
    const stripped = parse(RELAY_HTML.split('js-hidden-list').join('js-gone-list'), '401354', '22');
    const strippedSwims = stripped.data.rounds.flatMap(round => round.swims);
    expect(strippedSwims.length).toBe(swims.length);
    for (const swim of strippedSwims) expect(swim.relayLegs).toBeUndefined();

    const hits = stripped.warnings.filter(w => w.code === 'relay-row-without-legs');
    expect(hits).toHaveLength(swims.length);
    expect(hits.map(w => w.raw).sort()).toStrictEqual(swims.map(s => s.entry.athleteName).sort());
    for (const w of hits) {
      expect(w.eventId).toBe(stripped.data.event.eventId);
      expect(typeof w.rowIndex).toBe('number');
    }
  });

  it('never fires on an individual event, with or without a hidden list', () => {
    const plain = parse(INDIVIDUAL_HTML, '356467', '26');
    expect(plain.data.event.kind).toBe('individual');
    expect(plain.warnings.filter(w => w.code === 'relay-row-without-legs')).toStrictEqual([]);
    const renamed = parse(INDIVIDUAL_HTML.split('js-hidden-list').join('js-gone-list'), '356467', '26');
    expect(renamed.warnings.filter(w => w.code === 'relay-row-without-legs')).toStrictEqual([]);
  });

  it('is a review-severity warning, not a folded-away structural note', () => {
    expect(classifyWarningSeverity('relay-row-without-legs')).toBe('review');
  });
});
