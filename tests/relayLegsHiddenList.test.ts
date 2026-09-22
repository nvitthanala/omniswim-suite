/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud does publish relay legs. This proves it against a real page.
 *
 * ## The false premise this closes
 *
 * `parser.ts` raised `relay-legs-absent` on every relay row and its message
 * said that if SwimCloud does not publish leg splits at all, that is "the
 * permanent, expected state". Seventy such notes were being collapsed behind a
 * "expected structural notes" toggle on every import.
 *
 * It is not the expected state. A per-event results page serves every leg, in
 * the row it belongs to:
 *
 *     <div class="u-is-hidden js-hidden-list">
 *       <table>
 *         <tr><td><a href="/results/356467/swimmer/1330318/">Avery Henke</a></td>
 *             <td><a href="/times/171561951/">22.53</a></td></tr>
 *
 * The "Show names" button is a CSS toggle (`js-toggle-hidden-list`), not a
 * request, so a plain fetch already has name, swimmer id, split and swim id for
 * every leg.
 *
 * ## Why it was invisible
 *
 * Two layers hid it. `extractTableRows` deliberately strips nested tables so an
 * inner row is never mistaken for an outer one, and `extractRowCells` is not
 * nesting-aware, so the leg table's own `<td>`s truncated the name cell to a
 * few hundred characters. By the time any caller saw `dataRows`, the legs were
 * gone. They are now read from the raw table markup and paired with data rows
 * by occurrence.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMeetEventResultsHtml } from '../packages/swimcloud/src/parser';

const PAGES = path.resolve(__dirname, '..', 'data', 'swimcloud-captures', 'pages');

function storedEventPage(eventRef: string): string | undefined {
  if (!fs.existsSync(PAGES)) return undefined;
  const file = fs.readdirSync(PAGES).find(n => n.includes(`_2f_event_2f_${eventRef}_2f`));
  if (!file) return undefined;
  return (JSON.parse(fs.readFileSync(path.join(PAGES, file), 'utf-8')) as { html?: string }).html;
}

const RELAY_PAGE = storedEventPage('11');
const CONTEXT = {
  sourceUrl: 'https://www.swimcloud.com/results/356467/event/11/',
  retrievedAt: '2026-09-22T00:00:00.000Z',
  track: 'browser-extension',
} as const;

describe.skipIf(RELAY_PAGE === undefined)('relay legs from a real per-event page', () => {
  const parsed = parseMeetEventResultsHtml(RELAY_PAGE as string, CONTEXT as never, {} as never);
  const swims = parsed.ok
    ? (parsed.data.rounds ?? []).flatMap((round: { swims?: unknown[] }) => round.swims ?? [])
    : [];

  it('parses the page at all', () => {
    expect(parsed.ok).toBe(true);
    expect(swims.length).toBeGreaterThan(0);
  });

  it('gives every relay entry its four legs, in order, with splits', () => {
    for (const swim of swims as Array<Record<string, any>>) {
      const legs = swim.relayLegs ?? [];
      expect(legs.length, `${swim.entry?.athleteName} should carry its legs`).toBe(4);
      expect(legs.map((l: any) => l.order)).toStrictEqual([1, 2, 3, 4]);
      for (const leg of legs) {
        expect(typeof leg.athleteName).toBe('string');
        expect(leg.athleteName.length).toBeGreaterThan(0);
        expect(leg.swimCloudSwimmerId).toMatch(/^\d+$/);
        // A split is a real time, never reconstructed by subtracting cumulative
        // times -- that arithmetic would invent a value the page never printed.
        expect(leg.splitTime).toMatch(/^(?:\d{1,2}:)?\d{1,2}\.\d{2}$/);
      }
    }
  });

  it('names the actual swimmers on the winning relay', () => {
    // Verbatim from the stored page. A positional pairing bug would attach the
    // wrong squad to the wrong team, which is exactly the plausible-but-wrong
    // failure this repo cares about, so the names are pinned rather than
    // counted.
    const winner = (swims as Array<Record<string, any>>).find(s => s.result?.place === 1);
    expect(winner?.entry?.athleteName).toBe('Henderson State (A)');
    expect((winner?.relayLegs ?? []).map((l: any) => l.athleteName)).toStrictEqual([
      'Avery Henke',
      'Oskar Cebula',
      'Colin Candebat',
      'Olivér Pózvai',
    ]);
    expect((winner?.relayLegs ?? []).map((l: any) => l.splitTime)).toStrictEqual([
      '22.53',
      '24.29',
      '21.49',
      '19.77',
    ]);
  });

  it('no longer claims the relay rows are missing their athletes', () => {
    // A relay row names a team, not a person, so it never had a swimmer link.
    // Every one of them used to raise missing-athlete-link.
    const warnings = parsed.ok ? parsed.warnings : [];
    expect(warnings.filter(w => w.code === 'missing-athlete-link')).toStrictEqual([]);
    expect(warnings.filter(w => w.code === 'relay-legs-absent')).toStrictEqual([]);
  });

  it('reads the round caption without the page\'s own button text', () => {
    // The "Show names" button lives inside the <caption>, so the raw text read
    // "Timed Finals Show names" and would have matched no round vocabulary.
    for (const swim of swims as Array<Record<string, any>>) {
      expect(swim.roundLabel).toBe('Timed Finals');
    }
  });
});
