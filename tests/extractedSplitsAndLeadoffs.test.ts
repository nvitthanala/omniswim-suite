/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A leadoff is a swim. An extracted split is a placeholder.
 *
 * ## The ruling this encodes
 *
 * SwimCloud marks two kinds of row on a swimmer's times page that are not
 * ordinary races, and the app had both of them backwards.
 *
 * - **`title="Leadoff"`** — the first leg of a relay. It was *excluded* from a
 *   swimmer's history. It should not be: a leadoff starts from the blocks, not
 *   a flying takeover, and finishes to the hand, so it is the individual event
 *   swum inside a relay. Avery Henke's 22.53 leadoff is his 50 Back.
 * - **`title="Extracted"`** — a time taken out of a longer swim's splits. It
 *   was *imported as a genuine personal best*. It should not be: Avery's "50
 *   Breast SCY 25.16" and "100 Breast SCY 54.09" share one swim id, because the
 *   25.16 is the first half of the 100 and not a 50 he stood up and swam.
 *
 * Extracted times are kept rather than dropped, because a measured half of a
 * race is the best available estimate of what a swimmer splits on a relay leg,
 * and for many swimmers it is the only 50 they have. They are tagged so they
 * can fill a relay leg without ever being ranked, cut-tagged or entered.
 *
 * ## What this does NOT change
 *
 * Whether a leadoff *scores as an individual entry at the meet it was swum in*
 * is a different question with the opposite answer, and
 * `swimCloudMeetImportBridge` still excludes it there. That bridge is about one
 * meet's placings; this one is about what a swimmer has done.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Gender } from '../packages/core/src/types';
import type { HistoricalSwim, ScoringSettings } from '../packages/core/src/types';
import { categorizeBestEvents } from '../packages/core/src/lib/athleteHistory';
import { parseSwimmerTimesHtml } from '../packages/swimcloud/src/parser';
import { swimCloudSwimmerTimesToHistoricalSwims } from '../packages/manager/src/lib/swimCloudImportBridge';

const FIXTURE = path.resolve(
  __dirname,
  'fixtures',
  'swimcloud-real-swimmer-times-1472365.html',
);

const SETTINGS = {} as ScoringSettings;

function importedFromRealCapture() {
  const html = fs.readFileSync(FIXTURE, 'utf-8');
  const parsed = parseSwimmerTimesHtml(html, {
    sourceUrl: 'https://www.swimcloud.com/swimmer/1472365/times/',
    retrievedAt: '2026-09-22T14:00:00.000Z',
    track: 'browser-extension',
  } as never);
  if (!parsed.ok) throw new Error('fixture did not parse');
  const result = swimCloudSwimmerTimesToHistoricalSwims(parsed.data, {
    team: 'Henderson State',
    gender: Gender.MEN,
  } as never);
  if (!result.ok) throw new Error(`import refused: ${result.reason}`);
  return { parsed: parsed.data, ...result };
}

describe('importing a real swimmer times page', () => {
  const { parsed, swims, skipped } = importedFromRealCapture();

  it('keeps the leadoff instead of skipping it', () => {
    // The fixture carries exactly one `title="Leadoff"` row, a 50 Back of
    // 25.99. It used to be dropped with reason `relay-leadoff`, so this page
    // imported 8 swims; it now imports 9.
    const leadoffs = parsed.personalBests.filter((b) => b.relayLeadoff);
    expect(leadoffs).toHaveLength(1);

    expect(skipped).toStrictEqual([]);
    expect(swims).toHaveLength(parsed.personalBests.length);

    const back = swims.find((s) => s.event === '50 Back SCY');
    expect(back?.time).toBe('25.99');
    // And it is an ordinary swim — no placeholder flag.
    expect(back?.isExtractedSplit).toBeUndefined();
  });

  it('tags the extracted split, and only that row', () => {
    const extracted = swims.filter((s) => s.isExtractedSplit === true);
    expect(extracted.map((s) => s.event)).toStrictEqual(['1000 Free SCY']);

    // Cross-checked against the page's own chips rather than assumed: exactly
    // the rows SwimCloud marked `Extracted` are the rows flagged here.
    const markedOnPage = parsed.personalBests
      .filter((b) => b.tags.some((t) => t.title === 'Extracted'))
      .map((b) => b.eventLabel);
    expect(extracted.map((s) => s.event)).toStrictEqual(markedOnPage);
  });

  it('matches the tooltip, never the visible letter', () => {
    // `X` is the Hy-Tek exhibition marker elsewhere in this codebase and means
    // something entirely different. Matching the letter would mislabel swims.
    for (const best of parsed.personalBests) {
      const hasExtractedTitle = best.tags.some((t) => t.title === 'Extracted');
      const imported = swims.find((s) => s.event === best.eventLabel);
      if (imported === undefined) continue;
      expect(imported.isExtractedSplit === true).toBe(hasExtractedTitle);
    }
  });
});

describe('an extracted split is a placeholder, not a best', () => {
  const swim = (over: Partial<HistoricalSwim>): HistoricalSwim => ({
    name: 'Test Swimmer',
    team: 'Henderson State',
    gender: Gender.MEN,
    event: '50 Freestyle',
    time: '20.00',
    source: 'swimcloud',
    ...over,
  });

  const profileFor = (history: HistoricalSwim[]) =>
    categorizeBestEvents(history, 'Henderson State', Gender.MEN, 'Test Swimmer', SETTINGS);

  it('keeps an extracted time out of bestByEvent', () => {
    // The load-bearing assertion. In bestByEvent it would be ranked, given a
    // cut tag, and offered as an entry the swimmer could be seeded into on a
    // time they never swam at that distance.
    const profile = profileFor([swim({ isExtractedSplit: true })]);
    expect(profile.bestByEvent['50 Freestyle']).toBeUndefined();
    expect(profile.extractedByEvent['50 Freestyle']?.time).toBe('20.00');
  });

  it('keeps an ordinary time in bestByEvent and out of the placeholders', () => {
    const profile = profileFor([swim({})]);
    expect(profile.bestByEvent['50 Freestyle']?.time).toBe('20.00');
    expect(profile.extractedByEvent['50 Freestyle']).toBeUndefined();
  });

  it('never lets an extracted time beat a real one', () => {
    // A faster extracted split must not displace a slower real swim, because
    // they are not comparable results. The two live in separate maps, so the
    // real 21.00 stays the best however quick the split was.
    const profile = profileFor([
      swim({ time: '21.00' }),
      swim({ time: '19.00', isExtractedSplit: true }),
    ]);
    expect(profile.bestByEvent['50 Freestyle']?.time).toBe('21.00');
    expect(profile.extractedByEvent['50 Freestyle']?.time).toBe('19.00');
  });

  it('keeps the fastest of several extracted splits', () => {
    const profile = profileFor([
      swim({ time: '21.00', isExtractedSplit: true }),
      swim({ time: '19.50', isExtractedSplit: true }),
    ]);
    expect(profile.extractedByEvent['50 Freestyle']?.time).toBe('19.50');
    expect(profile.bestByEvent['50 Freestyle']).toBeUndefined();
  });
});

describe('the chip tooltip decides, not the letter', () => {
  /**
   * A mutation matching `tag.code === 'X'` instead of `tag.title ===
   * 'Extracted'` passed every test above. It had to: the real capture's only
   * `X` chip *is* the Extracted one, so no amount of that page can tell the two
   * readings apart. This case is synthetic for exactly that reason.
   *
   * The distinction is real and this repo already documents it. `X` is the
   * Hy-Tek **exhibition** marker elsewhere in the codebase, and an exhibition
   * swim is a genuine race at its distance — it simply does not score. Reading
   * the letter would file it as a relay-split placeholder and quietly remove a
   * real personal best from a swimmer's rankings and cut tags.
   */
  const timesParse = (tags: { code: string; title?: string }[]) =>
    ({
      swimCloudSwimmerId: '1',
      name: 'Test Swimmer',
      personalBests: [
        {
          swimKey: '1:pb:1',
          eventId: 'e1',
          eventLabel: '50 Free SCY',
          time: '20.00',
          course: 'SCY',
          tags,
          relayLeadoff: false,
        },
      ],
    }) as never;

  const importOnce = (tags: { code: string; title?: string }[]) => {
    const result = swimCloudSwimmerTimesToHistoricalSwims(timesParse(tags), {
      team: 'Henderson State',
      gender: Gender.MEN,
    } as never);
    if (!result.ok) throw new Error('import refused');
    return result.swims[0];
  };

  it('tags a row whose tooltip reads Extracted', () => {
    expect(importOnce([{ code: 'X', title: 'Extracted' }])?.isExtractedSplit).toBe(true);
  });

  it('does NOT tag an X that means exhibition', () => {
    // The mutation this exists to kill. An exhibition swim is a real race at
    // its distance; demoting it to a placeholder would drop a genuine best out
    // of the swimmer's rankings and cut tags.
    expect(importOnce([{ code: 'X', title: 'Exhibition' }])?.isExtractedSplit).toBeUndefined();
  });

  it('does not tag a row with no chips at all', () => {
    expect(importOnce([])?.isExtractedSplit).toBeUndefined();
  });

  it('tags on the tooltip even when the letter differs', () => {
    // The other direction: the letter is not load-bearing in either reading.
    expect(importOnce([{ code: 'E', title: 'Extracted' }])?.isExtractedSplit).toBe(true);
  });
});
