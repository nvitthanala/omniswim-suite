/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `swimCloudSwimmerTimesToHistoricalSwims`
 * (`packages/manager/src/lib/swimCloudImportBridge.ts`), added 2026-09-09 to
 * replace `swimCloudPersonalBestsToHistoricalSwims` at
 * `RosterImportWizard.tsx`'s per-swimmer import call site.
 *
 * Against the **real** capture, not a synthetic one — the same fixture
 * `tests/swimcloudSwimmerTimesParser.test.ts` already trusts for this page
 * shape. Every asserted value is a value on that page, so a SwimCloud layout
 * change or a converter regression breaks CI instead of quietly importing a
 * shorter, plausible bests list.
 *
 * **No `no-time` case is asserted from this fixture, on purpose.** All nine
 * real rows carry a well-formed time, so there is no honest way to exercise
 * that branch from the capture. A synthetic HTML page invented to produce one
 * would be a fabricated SwimCloud page, which is what this repo's provenance
 * rules forbid. The branch is instead exercised the only truthful way
 * available: by taking the real parse and removing a field from one row, which
 * is stated as an override rather than dressed up as a page SwimCloud served.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import {
  parseSwimmerTimesHtml,
  type SwimCloudParseContext,
  type SwimCloudPersonalBestSwim,
  type SwimCloudSwimmerTimesParse,
} from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const html = readFileSync(join(fixturesDir, 'swimcloud-real-swimmer-times-1472365.html'), 'utf8');

/** Verbatim from the fixture's own provenance header. */
const context: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/swimmer/1472365/times/',
  retrievedAt: '2026-09-09T03:32:55.480Z',
  track: 'browser-extension',
};

function parsedFixture(): SwimCloudSwimmerTimesParse {
  const result = parseSwimmerTimesHtml(html, context);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.failure.message}`);
  return result.data;
}

const OPTIONS = { team: 'Auburn', gender: Gender.MEN } as const;

function convertFixture() {
  const conversion = swimCloudSwimmerTimesToHistoricalSwims(parsedFixture(), OPTIONS);
  if (!conversion.ok) throw new Error(`expected ok, got ${conversion.reason}: ${conversion.message}`);
  return conversion;
}

describe('swimCloudSwimmerTimesToHistoricalSwims — real capture (swimmer 1472365, River Paulk)', () => {
  it('converts all 9 real rows, the relay leadoff included', () => {
    // **Changed 2026-09-22 on the coach's ruling.** This used to convert 8 and
    // skip the leadoff. See the test below for why that was backwards.
    const conversion = convertFixture();
    expect(conversion.swims).toHaveLength(9);
    expect(conversion.skipped).toStrictEqual([]);
  });

  it('keeps the 50 Back SCY row even though the page flags it "Leadoff"', () => {
    // The real row carries an `R` chip whose tooltip reads `Leadoff`, read
    // from `relayLeadoff` — a boolean the parser set from that chip, never by
    // string-matching a stroke name.
    //
    // It is imported as an ordinary individual swim. A leadoff starts from the
    // blocks, not a flying takeover, and finishes to the hand: it is the
    // individual event, swum inside a relay. Dropping it threw away a real
    // 50 Back.
    //
    // This is not the same question as whether a leadoff SCORES as an
    // individual entry at the meet it was swum in. It does not, and
    // swimCloudMeetImportBridge still excludes it there.
    const real = parsedFixture();
    const leadoff = real.personalBests.find((b) => b.relayLeadoff);
    expect(leadoff?.eventLabel).toBe('50 Back SCY');

    const conversion = convertFixture();
    expect(conversion.swims.map((s) => s.event)).toContain('50 Back SCY');
    expect(conversion.swims.find((s) => s.event === '50 Back SCY')?.time).toBe('25.99');
    // And it is a real swim, not a relay-split placeholder.
    expect(conversion.swims.find((s) => s.event === '50 Back SCY')?.isExtractedSplit).toBeUndefined();
  });

  it('converts the 50 Free SCY row exactly as the page prints it', () => {
    const conversion = convertFixture();
    const row = conversion.swims.find((s) => s.event === '50 Free SCY');
    expect(row).toStrictEqual({
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

  it('keeps every row in page order, each with its own meet and course', () => {
    const conversion = convertFixture();
    expect(conversion.swims.map((s) => `${s.event} ${s.time} ${s.timeType}`)).toStrictEqual([
      '50 Free SCY 19.42 SCY',
      '50 Free LCM 22.33 LCM',
      '100 Free SCY 42.99 SCY',
      '100 Free LCM 50.24 LCM',
      '200 Free SCY 1:37.77 SCY',
      '1000 Free SCY 10:37.48 SCY',
      // The relay leadoff, in its own page position. Imported since
      // 2026-09-22: it is the individual event swum inside a relay.
      '50 Back SCY 25.99 SCY',
      '200 IM LCM 2:15.09 LCM',
      '400 IM SCY 4:29.35 SCY',
    ]);
  });

  it('takes meetLabel per row, because a bests table spans many meets', () => {
    const conversion = convertFixture();
    expect(new Set(conversion.swims.map((s) => s.meetLabel)).size).toBeGreaterThan(1);
    expect(conversion.swims.find((s) => s.event === '50 Free LCM')?.meetLabel).toBe(
      'USA Swimming Futures Championship - Ocala',
    );
  });

  it('carries every date through verbatim, never reformatted into an ISO date', () => {
    const conversion = convertFixture();
    expect(conversion.swims.map((s) => s.date)).toStrictEqual([
      'Mar 1, 2025',
      'Jul 26, 2025',
      'Feb 28, 2025',
      'Jul 24, 2025',
      'Dec 8, 2023',
      'Jan 17, 2020',
      'Mar 4, 2022',
      'Jun 17, 2022',
      'Feb 21, 2020',
    ]);
    for (const swim of conversion.swims) {
      expect(swim.date).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('uses the page\'s own name order verbatim, family name first', () => {
    // `#swimmer-info` prints `Paulk, River J`. Neither the parser nor this
    // converter reshapes it into `River Paulk` — see the converter's own
    // "name is used verbatim" note, and the parser's "One name, one source".
    const conversion = convertFixture();
    expect(new Set(conversion.swims.map((s) => s.name))).toStrictEqual(new Set(['Paulk, River J']));
    expect(conversion.swims.every((s) => s.name !== 'River Paulk')).toBe(true);
  });

  it('tags every converted row source: swimcloud, under the caller\'s team and gender', () => {
    const conversion = swimCloudSwimmerTimesToHistoricalSwims(parsedFixture(), {
      team: 'Henderson State',
      gender: Gender.WOMEN,
    });
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims.every((s) => s.source === 'swimcloud')).toBe(true);
    expect(conversion.swims.every((s) => s.team === 'Henderson State')).toBe(true);
    expect(conversion.swims.every((s) => s.gender === Gender.WOMEN)).toBe(true);
  });
});

describe('swimCloudSwimmerTimesToHistoricalSwims — never fabricates a required field', () => {
  /** The real parse with one field overridden. Never a hand-written SwimCloud page. */
  function withRows(rows: readonly SwimCloudPersonalBestSwim[]): SwimCloudSwimmerTimesParse {
    return { ...parsedFixture(), personalBests: rows };
  }

  it('skips a row with no time rather than inventing one, and says why', () => {
    const real = parsedFixture();
    const timeless: SwimCloudPersonalBestSwim = { ...real.personalBests[0], rawTimeToken: 'NT' };
    delete (timeless as { time?: string }).time;

    const conversion = swimCloudSwimmerTimesToHistoricalSwims(withRows([timeless]), OPTIONS);
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims).toStrictEqual([]);
    expect(conversion.skipped).toHaveLength(1);
    expect(conversion.skipped[0].reason).toBe('no-time');
    expect(conversion.skipped[0].personalBest.rawTimeToken).toBe('NT');
  });

  it('omits timeType for an unknown course instead of guessing yards', () => {
    const real = parsedFixture();
    const conversion = swimCloudSwimmerTimesToHistoricalSwims(
      withRows([{ ...real.personalBests[0], course: 'unknown' }]),
      OPTIONS,
    );
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims[0]).not.toHaveProperty('timeType');
    expect(conversion.swims[0].time).toBe('19.42');
  });

  it('refuses the whole capture when the page named no swimmer, rather than inventing a placeholder', () => {
    // Reuses the real parse with `name` stripped — the state
    // `parseSwimmerTimesHtml` really produces when `#swimmer-info` is missing
    // or unreadable (both covered in that parser's own tests).
    const nameless = { ...parsedFixture() } as { name?: string };
    delete nameless.name;

    const conversion = swimCloudSwimmerTimesToHistoricalSwims(
      nameless as SwimCloudSwimmerTimesParse,
      OPTIONS,
    );
    expect(conversion.ok).toBe(false);
    if (conversion.ok) throw new Error('unreachable');
    expect(conversion.reason).toBe('missing-swimmer-name');
    expect(conversion.message).toContain('Refusing to import under a placeholder name');
  });

  it('treats a whitespace-only name the same as a missing one', () => {
    const conversion = swimCloudSwimmerTimesToHistoricalSwims({ ...parsedFixture(), name: '   ' }, OPTIONS);
    expect(conversion.ok).toBe(false);
    if (conversion.ok) throw new Error('unreachable');
    expect(conversion.reason).toBe('missing-swimmer-name');
  });
});

describe('swimCloudSwimmerTimesToHistoricalSwims — meet label fallback', () => {
  it('prefers the row\'s own meetName over the fallback', () => {
    const conversion = swimCloudSwimmerTimesToHistoricalSwims(parsedFixture(), {
      ...OPTIONS,
      meetLabelFallback: 'Fallback Meet',
    });
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims[0].meetLabel).toBe('James E Martin Invitational');
  });

  it('falls back only when the row printed no meet name', () => {
    const real = parsedFixture();
    const unnamed = { ...real.personalBests[0] };
    delete (unnamed as { meetName?: string }).meetName;

    const conversion = swimCloudSwimmerTimesToHistoricalSwims(
      { ...real, personalBests: [unnamed] },
      { ...OPTIONS, meetLabelFallback: 'Fallback Meet' },
    );
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims[0].meetLabel).toBe('Fallback Meet');
  });

  it('omits meetLabel entirely when neither the row nor the caller supplies one', () => {
    const real = parsedFixture();
    const unnamed = { ...real.personalBests[0] };
    delete (unnamed as { meetName?: string }).meetName;

    const conversion = swimCloudSwimmerTimesToHistoricalSwims({ ...real, personalBests: [unnamed] }, OPTIONS);
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims[0]).not.toHaveProperty('meetLabel');
  });
});

describe('swimCloudSwimmerTimesToHistoricalSwims — an all-skipped capture is still ok:true', () => {
  it('reports zero swims with every row accounted for, not a failure', () => {
    // A row with no time. This used to use the leadoff row, which is no
    // longer skipped -- a leadoff is a real individual swim as of 2026-09-22.
    // "No time at all" is now the only per-row skip this converter has.
    const real = parsedFixture();
    const first = real.personalBests[0];
    if (first === undefined) throw new Error('fixture carries no rows');
    const timeless = { ...first, time: undefined };

    const conversion = swimCloudSwimmerTimesToHistoricalSwims({ ...real, personalBests: [timeless] }, OPTIONS);
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims).toStrictEqual([]);
    expect(conversion.skipped).toHaveLength(1);
  });

  it('reports an empty bests table as zero swims, not as a missing name or a throw', () => {
    // A swimmer with no recorded times is a real answer the parser returns with
    // a `zero-data-rows` warning; the converter must not turn it into an error.
    const conversion = swimCloudSwimmerTimesToHistoricalSwims(
      { ...parsedFixture(), personalBests: [], rowCount: 0 },
      OPTIONS,
    );
    if (!conversion.ok) throw new Error('expected ok');
    expect(conversion.swims).toStrictEqual([]);
    expect(conversion.skipped).toStrictEqual([]);
  });
});
