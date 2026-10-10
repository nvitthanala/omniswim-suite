/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay-leg credits (plan Phase B2), proved offline on real captures.
 *
 * - F-B: `/results/399227/swimmer/1355764/`, one swimmer at one meet, with a
 *   relay anchor leg and an "Extracted" 50 Fly.
 * - F-C: `/results/401354/event/22/`, a 200 Free Relay with the "Show names"
 *   lists.
 *
 * F-B and F-C are different meets, so each is tested alone. The join is tested
 * on a synthetic pair built from F-C's own ids.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  joinRelayCreditsToEventEntries,
  parseMeetSwimmerCreditsHtml,
  parseRelayEventEntriesHtml,
} from '../packages/swimcloud/src/relayLegCredits';
import type { SwimCloudRelayLegCredit } from '../packages/swimcloud/src/relayLegCredits';
import { parseMeetEventResultsHtml } from '../packages/swimcloud/src/parser';

const FIX = path.resolve(__dirname, 'fixtures');
const read = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf-8');
const ctx = (sourceUrl: string) =>
  ({ sourceUrl, retrievedAt: '2026-10-09T15:35:38.683Z', track: 'browser-extension' }) as never;

const SWIMMER_HTML = read('swimcloud-real-meet-swimmer-399227-1355764-relay-anchor.html');
const SWIMMER_URL = 'https://www.swimcloud.com/results/399227/swimmer/1355764/';
const EVENT_HTML = read('swimcloud-real-meet-event-401354-event22-relay-names.html');
const EVENT_URL = 'https://www.swimcloud.com/results/401354/event/22/';

function swimmerOk(html: string = SWIMMER_HTML) {
  const r = parseMeetSwimmerCreditsHtml(html, ctx(SWIMMER_URL));
  if (!r.ok) throw new Error(`expected ok: ${r.failure.code} ${r.failure.message}`);
  return r;
}
function eventOk(html: string = EVENT_HTML) {
  const r = parseRelayEventEntriesHtml(html, ctx(EVENT_URL));
  if (!r.ok) throw new Error(`expected ok: ${r.failure.code} ${r.failure.message}`);
  return r;
}

describe('F-B: a swimmer at one meet (real capture)', () => {
  const { data, warnings } = swimmerOk();

  it('reads the ids and header', () => {
    expect(data.meetId).toBe('399227');
    expect(data.swimmerId).toBe('1355764');
    expect(data.teamId).toBe('58');
    expect(data.rowCount).toBe(4);
    expect(warnings).toStrictEqual([]);
  });

  it('reads the two individual swims', () => {
    expect(
      data.individualSwims.map((s) => [s.eventLabel, s.eventRef, s.round, s.time, s.swimCloudSwimId, s.swimKey, s.place]),
    ).toStrictEqual([
      ['50 Free', '8', 'Timed Finals', '22.72', '186273471', '399227:swim:186273471', 10],
      ['100 Fly', '10', 'Timed Finals', '55.96', '186273695', '399227:swim:186273695', 18],
    ]);
  });

  it('keeps the Extracted 50 Fly out of swims and marks it not seed-eligible', () => {
    expect(data.extractedSplits).toHaveLength(1);
    const split = data.extractedSplits[0];
    expect(split.kind).toBe('extracted-split');
    expect(split.seedEligible).toBe(false);
    expect([split.eventLabel, split.eventRef, split.round, split.time, split.swimCloudSwimId]).toStrictEqual([
      '50 Fly',
      '10',
      'Extracted',
      '25.88',
      '186274165',
    ]);
    expect(split.place).toBeUndefined();
    // Not among the individual swims, not among the relay legs.
    expect(data.individualSwims.map((s) => s.time)).not.toContain('25.88');
    expect(data.relayLegs.map((s) => s.time)).not.toContain('25.88');
  });

  it('reads the relay anchor leg as a credit, not an individual swim', () => {
    expect(data.relayLegs).toHaveLength(1);
    const leg = data.relayLegs[0];
    expect(leg).toStrictEqual({
      kind: 'relay-leg',
      rowIndex: 3,
      meetId: '399227',
      swimmerId: '1355764',
      eventLabel: '200 MED-R (Anchor)',
      relayEvent: '200 MED-R',
      relayEventTitle: '200 Medley Relay Men',
      eventRef: '2',
      round: 'Timed Finals',
      time: '21.83',
      swimCloudSwimId: '186273837',
      swimKey: '399227:swim:186273837',
      place: 6,
      legLabel: 'Anchor',
      legIndex: 4,
      isLeadoff: false,
    });
    expect(data.individualSwims.map((s) => s.time)).not.toContain('21.83');
  });
});

describe('F-B: leg words and absent fields (mutated copies of the capture)', () => {
  const withLabel = (word: string | null) =>
    swimmerOk(SWIMMER_HTML.replace('200 MED-R\n                      (Anchor)', word === null ? '200 MED-R' : `200 MED-R\n                      (${word})`))
      .data.relayLegs[0];

  it('maps Leadoff to leg 1 and flags it', () => {
    const leg = withLabel('Leadoff');
    expect(leg.legIndex).toBe(1);
    expect(leg.isLeadoff).toBe(true);
  });

  it('keeps an unmapped word verbatim and leaves legIndex absent', () => {
    const leg = withLabel('2nd Leg');
    expect(leg.legLabel).toBe('2nd Leg');
    expect('legIndex' in leg).toBe(false);
    expect(leg.isLeadoff).toBe(false);
  });

  it('gives a relay row with no leg word neither a label nor an index', () => {
    const leg = withLabel(null);
    expect(leg.kind).toBe('relay-leg');
    expect(leg.relayEvent).toBe('200 MED-R');
    expect('legLabel' in leg).toBe(false);
    expect('legIndex' in leg).toBe(false);
  });

  it('reads a Leadoff chip in the Flags cell', () => {
    const html = SWIMMER_HTML.replace(
      /(href="\/times\/186273837\/">[\s\S]*?<td colspan="2" class="u-pl0">)/,
      '$1<span title="Leadoff">R</span>',
    );
    expect(swimmerOk(html).data.relayLegs[0].isLeadoff).toBe(true);
  });

  it('leaves place absent when the cell is empty, and warns on a non-ordinal place', () => {
    const html = SWIMMER_HTML.replace(/6<span class="u-text-small u-color-mute u-text-semi">th<\/span>/, 'DQ');
    const r = swimmerOk(html);
    expect(r.data.relayLegs[0].place).toBeUndefined();
    expect(r.warnings.map((w) => w.code)).toStrictEqual(['unrecognized-place-token']);
  });
});

describe('F-B: failures are loud', () => {
  it('fails on empty input', () => {
    const r = parseMeetSwimmerCreditsHtml('  ', ctx(SWIMMER_URL));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('empty-input');
  });

  it('fails when the capture URL is not a swimmer-in-meet URL', () => {
    const r = parseMeetSwimmerCreditsHtml(SWIMMER_HTML, ctx(EVENT_URL));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('source-url-mismatch');
  });

  it('fails when the heading names another swimmer than the URL', () => {
    const r = parseMeetSwimmerCreditsHtml(
      SWIMMER_HTML,
      ctx('https://www.swimcloud.com/results/399227/swimmer/999/'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('source-url-mismatch');
  });

  it('fails, rather than returning no swims, when the table is gone', () => {
    const r = parseMeetSwimmerCreditsHtml(
      SWIMMER_HTML.replace(/<table[\s\S]*<\/table>/, '<p>Just a moment...</p>'),
      ctx(SWIMMER_URL),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('expected-table-missing');
  });

  it('fails when a required column title is missing', () => {
    const r = parseMeetSwimmerCreditsHtml(SWIMMER_HTML.replace('title="Place/Lane"', 'title="Other"'), ctx(SWIMMER_URL));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('expected-table-missing');
  });

  it('skips a row with an unreadable time, with a warning, and the row count shows the gap', () => {
    const r = swimmerOk(SWIMMER_HTML.replace('21.83', 'DQ'));
    expect(r.data.rowCount).toBe(4);
    expect(r.data.relayLegs).toHaveLength(0);
    expect(r.warnings.map((w) => w.code)).toStrictEqual(['unrecognized-time-token']);
  });

  it('skips a row with no /times/ link, with a warning', () => {
    const r = swimmerOk(SWIMMER_HTML.replace('href="/times/186273837/"', 'href="/nothing/"'));
    expect(r.data.relayLegs).toHaveLength(0);
    expect(r.warnings.map((w) => w.code)).toStrictEqual(['missing-swim-link']);
  });

  it('skips a non-relay row that has a parenthetical, with a warning', () => {
    const r = swimmerOk(SWIMMER_HTML.replace('50 Free\n', '50 Free (Mystery)\n'));
    expect(r.data.individualSwims.map((s) => s.eventLabel)).toStrictEqual(['100 Fly']);
    expect(r.warnings.map((w) => w.code)).toStrictEqual(['unrecognized-event-label']);
  });

  it('warns on a table with a header and no rows', () => {
    const html = SWIMMER_HTML.replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody></tbody>');
    const r = swimmerOk(html);
    expect(r.data.rowCount).toBe(0);
    expect(r.warnings.map((w) => w.code)).toStrictEqual(['zero-data-rows']);
  });
});

describe('F-C: relay event page (real capture)', () => {
  const { data } = eventOk();

  it('reads seven relay entries in printed order', () => {
    expect(data.meetId).toBe('401354');
    expect(data.eventRef).toBe('22');
    expect(
      data.entries.map((e) => [e.printedName, e.teamName, e.relayLetter, e.teamId, e.place, e.finalTime, e.score, e.round]),
    ).toStrictEqual([
      ['Henderson State (A)', 'Henderson State', 'A', '58', 1, '1:22.38', 11, 'Timed Finals'],
      ['Henderson State (B)', 'Henderson State', 'B', '58', 2, '1:24.93', 4, 'Timed Finals'],
      ['Oklahoma Christian (A)', 'Oklahoma Christian', 'A', '10009480', 3, '1:25.35', 2, 'Timed Finals'],
      ['Oklahoma Christian (B)', 'Oklahoma Christian', 'B', '10009480', 4, '1:26.39', undefined, 'Timed Finals'],
      ['Oklahoma Christian (C)', 'Oklahoma Christian', 'C', '10009480', 5, '1:26.78', undefined, 'Timed Finals'],
      ['Oklahoma Christian (D)', 'Oklahoma Christian', 'D', '10009480', 6, '1:30.36', undefined, 'Timed Finals'],
      ['Oklahoma Christian (E)', 'Oklahoma Christian', 'E', '10009480', 7, '1:32.00', undefined, 'Timed Finals'],
    ]);
  });

  it('leaves score absent where the page prints an en dash', () => {
    for (const e of data.entries.slice(3)) expect('score' in e).toBe(false);
  });

  it('reads HSU (A) legs exactly: swimmer id, name, split, times id, order', () => {
    expect(data.entries[0].swimCloudSwimId).toBe('188544298');
    expect(data.entries[0].legs).toStrictEqual([
      { order: 1, swimCloudSwimmerId: '2253944', athleteName: 'Olivér Pózvai', splitTime: '21.03', swimCloudSwimId: '188544373' },
      { order: 2, swimCloudSwimmerId: '1389320', athleteName: 'Máté Hosszú', splitTime: '20.62', swimCloudSwimId: '188544374' },
      { order: 3, swimCloudSwimmerId: '1818382', athleteName: 'Tristin Ferguson', splitTime: '20.70', swimCloudSwimId: '188544375' },
      { order: 4, swimCloudSwimmerId: '1472365', athleteName: 'River Paulk', splitTime: '20.03', swimCloudSwimId: '188544376' },
    ]);
  });

  it('reads HSU (B) legs', () => {
    expect(data.entries[1].legs.map((l) => [l.order, l.swimCloudSwimmerId, l.athleteName, l.splitTime, l.swimCloudSwimId])).toStrictEqual([
      [1, '1641985', 'Luka Herceg', '21.99', '188544377'],
      [2, '3498502', 'Fabio Capocci', '20.96', '188544378'],
      [3, '2852737', 'Reid Remmert', '21.24', '188544379'],
      [4, '3504614', 'Bona Benedek', '20.74', '188544380'],
    ]);
  });

  it('gives every relay four legs, each with a distinct times id from 188544373 to 188544400', () => {
    const ids = data.entries.flatMap((e) => e.legs.map((l) => l.swimCloudSwimId));
    expect(data.entries.every((e) => e.legs.length === 4)).toBe(true);
    expect(ids).toStrictEqual(Array.from({ length: 28 }, (_, i) => String(188544373 + i)));
  });

  it('has legs whose splits add up to the printed relay time (HSU A)', () => {
    // 21.03 + 20.62 + 20.70 + 20.03 = 82.38 = 1:22.38. A sanity check on the
    // capture, not a computation the parser does.
    expect(Math.round((21.03 + 20.62 + 20.7 + 20.03) * 100)).toBe(8238);
  });

  it('keeps the existing event parser output and only adds the leg swim id', () => {
    const base = parseMeetEventResultsHtml(EVENT_HTML, ctx(EVENT_URL), {} as never);
    if (!base.ok) throw new Error('base parse failed');
    const leg = base.data.rounds[0].swims[0].relayLegs?.[0];
    expect(leg).toStrictEqual({
      order: 1,
      swimCloudSwimmerId: '2253944',
      athleteName: 'Olivér Pózvai',
      splitTime: '21.03',
      swimCloudSwimId: '188544373',
    });
  });
});

describe('F-C: hidden list missing, malformed or short is never an empty success', () => {
  it('warns relay-legs-absent for every relay when the hidden lists are gone', () => {
    const html = EVENT_HTML.replace(/<div class="js-hidden-list">[\s\S]*?<\/table>\s*<\/div>/g, '');
    const r = eventOk(html);
    expect(r.data.entries).toHaveLength(7);
    expect(r.data.entries.every((e) => e.legs.length === 0)).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'relay-legs-absent')).toHaveLength(7);
  });

  it('warns on a relay with three legs and keeps the three, inventing no fourth', () => {
    const html = EVENT_HTML.replace(/<tr>\s*<td class="u-whitespace-normal u-text-default">\s*<a href="\/results\/401354\/swimmer\/1472365\/">River Paulk[\s\S]*?<\/tr>/, '');
    const r = eventOk(html);
    expect(r.data.entries[0].legs).toHaveLength(3);
    expect(r.warnings.filter((w) => w.code === 'relay-leg-count-unexpected')).toHaveLength(1);
  });

  it('does not lend a neighbour leg its time when one split link is missing', () => {
    // Remove the times link around Hosszú's 20.62. Legs after it must keep their own times.
    const html = EVENT_HTML.replace('<a href="/times/188544374/">20.62</a>', '');
    const legs = eventOk(html).data.entries[0].legs;
    expect(legs.map((l) => [l.athleteName, l.splitTime, l.swimCloudSwimId])).toStrictEqual([
      ['Olivér Pózvai', '21.03', '188544373'],
      ['Máté Hosszú', undefined, undefined],
      ['Tristin Ferguson', '20.70', '188544375'],
      ['River Paulk', '20.03', '188544376'],
    ]);
  });

  it('leaves the relay letter absent when the team cell prints none (never defaults to A)', () => {
    const r = eventOk(EVENT_HTML.replace('<span class="u-inline-block@sm">Henderson State (A)</span>', '<span class="u-inline-block@sm">Henderson State</span>'));
    const e = r.data.entries[0];
    expect(e.printedName).toBe('Henderson State');
    expect('relayLetter' in e).toBe(false);
    expect('teamName' in e).toBe(false);
  });

  it('fails an individual event page with not-a-relay-event', () => {
    const r = parseRelayEventEntriesHtml(
      read('swimcloud-real-meet-event-356467-event26.html'),
      ctx('https://www.swimcloud.com/results/356467/event/26/'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('not-a-relay-event');
  });

  it('passes a parse failure through', () => {
    const r = parseRelayEventEntriesHtml('', ctx(EVENT_URL));
    expect(r.ok).toBe(false);
  });
});

describe('join: credits to relay-event legs on SwimCloud ids only (synthetic pair)', () => {
  const page = eventOk().data;
  const [real] = swimmerOk().data.relayLegs;
  // A credit for River Paulk's anchor leg of HSU (A), built from F-C's own ids.
  const credit: SwimCloudRelayLegCredit = {
    ...real,
    meetId: '401354',
    eventRef: '22',
    swimmerId: '1472365',
    swimCloudSwimId: '188544376',
    swimKey: '401354:swim:188544376',
    time: '20.03',
    legLabel: 'Anchor',
    legIndex: 4,
  };

  it('matches on the times id, with swimmer, meet, event and position agreeing', () => {
    const j = joinRelayCreditsToEventEntries([credit], page);
    expect(j.conflicts).toStrictEqual([]);
    expect(j.unmatchedCredits).toStrictEqual([]);
    expect(j.matched).toHaveLength(1);
    expect(j.matched[0].entry.printedName).toBe('Henderson State (A)');
    expect(j.matched[0].leg.order).toBe(4);
  });

  it('does not match on name plus time: right time, wrong id stays unmatched', () => {
    const j = joinRelayCreditsToEventEntries([{ ...credit, swimCloudSwimId: '999', swimKey: '401354:swim:999' }], page);
    expect(j.matched).toStrictEqual([]);
    expect(j.unmatchedCredits).toHaveLength(1);
  });

  it('picks the right leg when two legs share a printed time', () => {
    // Make HSU (B) leg 4 print the same time as the credit; the id still decides.
    const html = EVENT_HTML.replace('<a href="/times/188544380/">20.74</a>', '<a href="/times/188544380/">20.03</a>');
    const dup = eventOk(html).data;
    const j = joinRelayCreditsToEventEntries([credit], dup);
    expect(j.matched[0].leg.swimCloudSwimId).toBe('188544376');
  });

  it('reports a swimmer-id disagreement as a conflict, not a match', () => {
    const j = joinRelayCreditsToEventEntries([{ ...credit, swimmerId: '1' }], page);
    expect(j.matched).toStrictEqual([]);
    expect(j.conflicts.map((c) => c.reason)).toStrictEqual(['swimmer-id-differs']);
  });

  it('reports a leg-position disagreement as a conflict', () => {
    const j = joinRelayCreditsToEventEntries([{ ...credit, legLabel: 'Leadoff', legIndex: 1 }], page);
    expect(j.matched).toStrictEqual([]);
    expect(j.conflicts.map((c) => c.reason)).toStrictEqual(['leg-position-differs']);
  });

  it('reports a meet or event disagreement as a conflict', () => {
    const j = joinRelayCreditsToEventEntries([{ ...credit, meetId: '399227' }], page);
    expect(j.conflicts.map((c) => c.reason)).toStrictEqual(['meet-or-event-differs']);
  });

  it('matches a credit with no leg word when the ids agree', () => {
    const { legLabel: _label, legIndex: _index, ...bare } = credit;
    void _label;
    void _index;
    expect(joinRelayCreditsToEventEntries([bare as SwimCloudRelayLegCredit], page).matched).toHaveLength(1);
  });

  describe('a Leadoff flag with no leg word still states position 1', () => {
    // Flags-chip leadoff: isLeadoff true, no legLabel, no legIndex.
    const flagged = (swimId: string, swimmerId: string): SwimCloudRelayLegCredit => {
      const { legLabel: _label, legIndex: _index, ...rest } = credit;
      void _label;
      void _index;
      return { ...rest, swimCloudSwimId: swimId, swimmerId, swimKey: `401354:swim:${swimId}`, isLeadoff: true } as SwimCloudRelayLegCredit;
    };

    it('is a conflict, not a match, when the leg sits at order 3', () => {
      // 188544375 is Tristin Ferguson, HSU (A) leg 3.
      const j = joinRelayCreditsToEventEntries([flagged('188544375', '1818382')], page);
      expect(j.matched).toStrictEqual([]);
      expect(j.conflicts.map((c) => [c.reason, c.leg.order])).toStrictEqual([['leg-position-differs', 3]]);
    });

    it('matches when the leg really is order 1', () => {
      // 188544373 is Olivér Pózvai, HSU (A) leg 1.
      const j = joinRelayCreditsToEventEntries([flagged('188544373', '2253944')], page);
      expect(j.conflicts).toStrictEqual([]);
      expect(j.matched.map((m) => m.leg.order)).toStrictEqual([1]);
    });

    it('isLeadoff false states nothing: the same credit at order 3 matches', () => {
      const j = joinRelayCreditsToEventEntries([{ ...flagged('188544375', '1818382'), isLeadoff: false }], page);
      expect(j.conflicts).toStrictEqual([]);
      expect(j.matched).toHaveLength(1);
    });
  });
});
