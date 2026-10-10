/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay-leg credits (spec: `docs/reference/RELAY_LEG_CREDITS_SPEC.md`).
 *
 * A relay leg SwimCloud credits to a swimmer lives in `Workspace.relayLegCredits`
 * and nowhere else. These tests pin the separation (I1, I2), the merge key (I3),
 * the position rule (I4) and the event-title rule (I5) against the real captures:
 *
 * - F-B `/results/399227/swimmer/1355764/`: `200 MED-R (Anchor)` 21.83.
 * - F-C `/results/401354/event/22/`: a relay event page with named legs (used
 *   only for the synthetic join pair, as in `swimcloudRelayLegCredits.test.ts`).
 *
 * The persistence round trip is `relayLegCreditsPersistence.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { Gender } from '@omniswim/core/types';
import type { HistoricalSwim, RelayLegCredit, Workspace } from '@omniswim/core/types';
import { isRankableSwim, isRelayShapedEventLabel } from '@omniswim/core/lib/bestTimeEligibility';
import { mergeRelayLegCredits, relayLegSlotOf } from '@omniswim/core/lib/relayLegCredits';
import { getAthleteProfile } from '@omniswim/core/lib/athleteHistory';
import {
  swimCloudRelayCreditsToRelayLegCredits,
  swimCloudSwimmerTimesToHistoricalSwims,
} from '@omniswim/manager/lib/swimCloudImportBridge';
import {
  joinRelayCreditsToEventEntries,
  parseMeetSwimmerCreditsHtml,
  parseRelayEventEntriesHtml,
} from '../packages/swimcloud/src/relayLegCredits';
import type { SwimCloudMeetSwimmerCredits, SwimCloudRelayLegCredit } from '../packages/swimcloud/src/relayLegCredits';
import { parseSwimmerTimesHtml } from '@omniswim/swimcloud';
import type { SwimCloudSwimmerTimesParse } from '@omniswim/swimcloud';

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const read = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf-8');
const ctx = (sourceUrl: string) =>
  ({ sourceUrl, retrievedAt: '2026-10-09T15:35:38.683Z', track: 'browser-extension' }) as never;

const SWIMMER_HTML = read('swimcloud-real-meet-swimmer-399227-1355764-relay-anchor.html');
const SWIMMER_URL = 'https://www.swimcloud.com/results/399227/swimmer/1355764/';
const EVENT_HTML = read('swimcloud-real-meet-event-401354-event22-relay-names.html');
const EVENT_URL = 'https://www.swimcloud.com/results/401354/event/22/';

function swimmerPage(html: string = SWIMMER_HTML): SwimCloudMeetSwimmerCredits {
  const r = parseMeetSwimmerCreditsHtml(html, ctx(SWIMMER_URL));
  if (!r.ok) throw new Error(`expected ok: ${r.failure.code} ${r.failure.message}`);
  return r.data;
}

const OPTIONS = { team: 'Henderson State', gender: Gender.MEN, sourceUrl: SWIMMER_URL, retrievedAt: '2026-10-09T15:35:38.683Z' } as const;

function convert(html: string = SWIMMER_HTML, extra: Partial<Parameters<typeof swimCloudRelayCreditsToRelayLegCredits>[1]> = {}): RelayLegCredit[] {
  const result = swimCloudRelayCreditsToRelayLegCredits(swimmerPage(html), { ...OPTIONS, ...extra });
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return [...result.credits];
}

/** A complete credit. Tests override only what they are about. */
function credit(over: Partial<RelayLegCredit> = {}): RelayLegCredit {
  return {
    swimCloudSwimId: '186273837',
    swimCloudSwimmerId: '1355764',
    meetId: '399227',
    eventRef: '2',
    name: 'A Swimmer',
    team: 'Henderson State',
    gender: Gender.MEN,
    relayEvent: '200 MED-R',
    isLeadoff: false,
    split: '21.83',
    sourceUrl: SWIMMER_URL,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* relayLegCredit_notAssignableToHistoricalSwim                                */
/* -------------------------------------------------------------------------- */

/**
 * Type-checks `body` against the real core types and returns the diagnostics
 * for that snippet only. `npm run lint` does not cover `tests/`, so the
 * `@ts-expect-error` below would otherwise never be enforced.
 */
function typeCheckSnippet(body: string): string[] {
  const typesPath = path.join(ROOT, 'packages', 'core', 'src', 'types.ts').replace(/\\/g, '/');
  const snippetPath = path.join(ROOT, 'tests', '__relay_credit_type_snippet__.ts');
  const source = `import type { HistoricalSwim, RelayLegCredit } from '${typesPath.replace(/\.ts$/, '')}';\n${body}\n`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
  };
  const host = ts.createCompilerHost(options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    path.resolve(fileName) === snippetPath
      ? ts.createSourceFile(fileName, source, languageVersion)
      : realGetSourceFile(fileName, languageVersion, ...rest);
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => path.resolve(fileName) === snippetPath || realFileExists(fileName);
  const program = ts.createProgram([snippetPath], options, host);
  const file = program.getSourceFile(snippetPath);
  if (file === undefined) throw new Error('snippet not loaded');
  return program
    .getSemanticDiagnostics(file)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

describe('relayLegCredit_notAssignableToHistoricalSwim', () => {
  it('refuses a credit where a HistoricalSwim is wanted, and holds no event or time field', () => {
    const diagnostics = typeCheckSnippet(`
declare const leg: RelayLegCredit;
// @ts-expect-error a relay leg is not a swim: it has no event, no time, no source
const asSwim: HistoricalSwim = leg;
void asSwim;
// The key set itself: no field a best-time reader could read as a swim.
type Leak = Extract<keyof RelayLegCredit, 'event' | 'time' | 'source' | 'timeType' | 'swimcloudBadge' | 'isExtractedSplit'>;
const noLeak: [Leak] extends ['timeType'] ? true : false = true;
void noLeak;
`);
    expect(diagnostics).toStrictEqual([]);
  }, 120_000);

  it('control: the same snippet DOES flag a swim-shaped credit (the check can fail)', () => {
    const diagnostics = typeCheckSnippet(`
declare const leg: RelayLegCredit & { event: string; time: string; source: 'swimcloud' };
// @ts-expect-error the extra fields make it assignable, so this directive is unused
const asSwim: HistoricalSwim = leg;
void asSwim;
`);
    expect(diagnostics.some((d) => d.startsWith('TS2578'))).toBe(true);
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/* anchorFixture_neverReachesBests                                             */
/* -------------------------------------------------------------------------- */

describe('anchorFixture_neverReachesBests', () => {
  const name = swimmerPage().swimmerName ?? '';

  const history: HistoricalSwim[] = [
    { name, team: 'Henderson State', gender: Gender.MEN, event: '50 Free SCY', time: '22.72', timeType: 'SCY', source: 'swimcloud' },
    { name, team: 'Henderson State', gender: Gender.MEN, event: '100 Fly SCY', time: '55.96', timeType: 'SCY', source: 'swimcloud' },
  ];
  const baseWorkspace = (over: Partial<Workspace> = {}): Workspace =>
    ({
      id: 'ws',
      name: 'HSU',
      createdAt: 0,
      menResults: [],
      womenResults: [],
      recruits: [],
      deletedSwimmers: [],
      athleteHistory: history,
      ...over,
    }) as Workspace;
  const profileOf = (ws: Workspace) =>
    getAthleteProfile(ws, 'Henderson State', Gender.MEN, name, {} as never);

  it('converts the 399227 anchor leg into one credit and leaves history and bests as they were', () => {
    expect(name.length).toBeGreaterThan(0);
    const before = profileOf(baseWorkspace());
    // Non-vacuous: the real swims give the profile real bests to compare.
    expect(Object.keys(before.bestByEvent).length).toBeGreaterThan(0);
    const historyBefore = JSON.stringify(history);

    const credits = convert();
    expect(credits).toHaveLength(1);
    const merged = mergeRelayLegCredits([], credits);
    expect(merged.conflicts).toStrictEqual([]);
    const after = profileOf(baseWorkspace({ relayLegCredits: merged.credits }));

    expect(JSON.stringify(history)).toBe(historyBefore);
    expect(after.bestByEvent).toStrictEqual(before.bestByEvent);
    expect(after.extractedByEvent).toStrictEqual(before.extractedByEvent);
    // The 21.83 split is nowhere in the profile. Not a best, not an extracted stand-in.
    expect(JSON.stringify(after)).not.toContain('21.83');
    expect(Object.keys(after.bestByEvent).sort()).toStrictEqual(Object.keys(before.bestByEvent).sort());
  });

  it('a credit carries no event and no time, so it cannot be mistaken for a swim', () => {
    const [leg] = convert();
    expect('event' in leg).toBe(false);
    expect('time' in leg).toBe(false);
    expect(leg.split).toBe('21.83');
    expect(leg.relayEvent).toBe('200 MED-R');
  });

  it('fixture credit: ids, position, title, place, provenance', () => {
    const [leg] = convert();
    expect(leg).toStrictEqual({
      swimCloudSwimId: '186273837',
      swimCloudSwimmerId: '1355764',
      meetId: '399227',
      eventRef: '2',
      name,
      team: 'Henderson State',
      gender: Gender.MEN,
      relayEvent: '200 MED-R',
      relayEventTitle: '200 Medley Relay Men',
      legLabel: 'Anchor',
      legPosition: 4,
      legPositionSource: 'leg-word',
      isLeadoff: false,
      split: '21.83',
      relayPlace: 6,
      sourceUrl: SWIMMER_URL,
      retrievedAt: '2026-10-09T15:35:38.683Z',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* isRankableSwim_refusesRelayLabels                                           */
/* -------------------------------------------------------------------------- */

describe('isRankableSwim_refusesRelayLabels', () => {
  it.each([
    '200 MED-R',
    '200 MED-R SCY',
    '400 Medley Relay',
    'Event 31 Men 4x50 Yard Freestyle Relay',
    '200 Free Relay',
    '200 Y MED-R',
    '400 L MED-R',
    'Men 400 FR-R',
    '4x50 FR-R',
  ])(
    'refuses %s',
    (event) => {
      expect(isRankableSwim({ event })).toBe(false);
      expect(isRelayShapedEventLabel(event)).toBe(true);
    },
  );

  it.each([
    '50 Free SCY',
    '200 IM',
    '200 IM SCY',
    'Event 8 Men 50 Yard Freestyle',
    '100 Breast LCM',
    '1 M Diving',
    '3M Diving',
    'Platform Diving',
    '50 Y Back (Leadoff)',
  ])('keeps %s', (event) => {
    expect(isRankableSwim({ event })).toBe(true);
    expect(isRelayShapedEventLabel(event)).toBe(false);
  });

  it('a relay label is refused whatever the course and flags say', () => {
    expect(isRankableSwim({ event: '200 MED-R', timeType: 'SCY' })).toBe(false);
    expect(isRankableSwim({ event: '400 Medley Relay', timeType: 'SCY', swimcloudBadge: 'other' })).toBe(false);
  });

  it('a call with no event keeps the flag-only answer', () => {
    expect(isRankableSwim({})).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* timesConverter_skipsRelayCredit                                             */
/* -------------------------------------------------------------------------- */

describe('timesConverter_skipsRelayCredit', () => {
  const timesHtml = read('swimcloud-real-swimmer-times-1472365.html');
  const parsed = (): SwimCloudSwimmerTimesParse => {
    const r = parseSwimmerTimesHtml(timesHtml, {
      sourceUrl: 'https://www.swimcloud.com/swimmer/1472365/times/',
      retrievedAt: '2026-09-09T03:32:55.480Z',
      track: 'browser-extension',
    });
    if (!r.ok) throw new Error(r.failure.message);
    return r.data;
  };

  it('skips a relay-shaped label with reason relay-leg-credit and keeps the other rows', () => {
    // Stated override on a real parse: the real page lists no relay row, so one
    // row's label is replaced. No fabricated page.
    const real = parsed();
    const rows = real.personalBests.map((row, i) => (i === 0 ? { ...row, eventLabel: '200 MED-R (Anchor)' } : row));
    const conversion = swimCloudSwimmerTimesToHistoricalSwims({ ...real, personalBests: rows }, { team: 'Auburn', gender: Gender.MEN });
    if (!conversion.ok) throw new Error(conversion.reason);
    expect(conversion.skipped.map((s) => [s.personalBest.eventLabel, s.reason])).toStrictEqual([['200 MED-R (Anchor)', 'relay-leg-credit']]);
    expect(conversion.swims).toHaveLength(real.personalBests.length - 1);
    expect(conversion.swims.map((s) => s.event)).not.toContain('200 MED-R (Anchor)');
  });

  it('still imports every real row when none is relay-shaped (the leadoff stays an individual swim)', () => {
    const conversion = swimCloudSwimmerTimesToHistoricalSwims(parsed(), { team: 'Auburn', gender: Gender.MEN });
    if (!conversion.ok) throw new Error(conversion.reason);
    expect(conversion.swims).toHaveLength(9);
    expect(conversion.skipped).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* mergeRelayLegCredits_keysOnSwimId                                           */
/* -------------------------------------------------------------------------- */

describe('mergeRelayLegCredits_keysOnSwimId', () => {
  it('keeps two credits that share a split and a name but not an id', () => {
    const a = credit({ swimCloudSwimId: '1' });
    const b = credit({ swimCloudSwimId: '2' });
    const { credits, conflicts } = mergeRelayLegCredits([a], [b]);
    expect(credits).toStrictEqual([a, b]);
    expect(conflicts).toStrictEqual([]);
  });

  it('drops an identical copy without a conflict', () => {
    const a = credit();
    const { credits, conflicts } = mergeRelayLegCredits([a], [{ ...a }]);
    expect(credits).toStrictEqual([a]);
    expect(credits[0]).toBe(a);
    expect(conflicts).toStrictEqual([]);
  });

  it('same id, different split: the existing credit stays and one conflict is reported', () => {
    const existing = credit({ split: '21.83' });
    const incoming = credit({ split: '20.00' });
    const { credits, conflicts } = mergeRelayLegCredits([existing], [incoming]);
    expect(credits).toStrictEqual([existing]);
    expect(credits[0].split).toBe('21.83');
    expect(conflicts).toStrictEqual([{ existing, incoming, fields: ['split'] }]);
  });

  it('same id, different meet or swimmer: conflict, existing kept', () => {
    const existing = credit();
    const meet = credit({ meetId: '1' });
    const swimmer = credit({ swimCloudSwimmerId: '9' });
    const result = mergeRelayLegCredits([existing], [meet, swimmer]);
    expect(result.credits).toStrictEqual([existing]);
    expect(result.conflicts.map((c) => c.fields)).toStrictEqual([['meetId'], ['swimCloudSwimmerId']]);
  });

  it('a different name, team, gender, source or retrieval time never conflicts and never overwrites', () => {
    const existing = credit({ name: 'A', team: 'T1', sourceUrl: 'https://example.test/1', retrievedAt: '2026-01-01T00:00:00Z' });
    const incoming = credit({ name: 'B', team: 'T2', gender: Gender.WOMEN, sourceUrl: 'https://example.test/2', retrievedAt: '2026-02-02T00:00:00Z' });
    const { credits, conflicts } = mergeRelayLegCredits([existing], [incoming]);
    expect(conflicts).toStrictEqual([]);
    expect(credits).toStrictEqual([existing]);
  });

  describe('fill (ruling 3a)', () => {
    it('fills an absent legPosition from the incoming copy, with its source as a pair', () => {
      const existing = credit();
      const incoming = credit({ legPosition: 4, legPositionSource: 'event-page-join' });
      const { credits, conflicts } = mergeRelayLegCredits([existing], [incoming]);
      expect(conflicts).toStrictEqual([]);
      expect([credits[0].legPosition, credits[0].legPositionSource]).toStrictEqual([4, 'event-page-join']);
      expect(existing.legPosition).toBeUndefined();
    });

    it('never fills a position without its source (a pair, never one alone)', () => {
      const { credits } = mergeRelayLegCredits([credit()], [credit({ legPosition: 4 })]);
      expect('legPosition' in credits[0]).toBe(false);
      expect('legPositionSource' in credits[0]).toBe(false);
    });

    it('never fills a source without its position either', () => {
      const { credits } = mergeRelayLegCredits([credit()], [credit({ legPositionSource: 'leg-word' })]);
      expect('legPosition' in credits[0]).toBe(false);
      expect('legPositionSource' in credits[0]).toBe(false);
    });

    it('fills each fillable optional field the existing credit lacks', () => {
      const incoming = credit({
        relayEventTitle: '200 Medley Relay Men',
        legLabel: 'Anchor',
        timeType: 'SCY',
        relayPlace: 6,
        relayLetter: 'A',
        meetLabel: 'NSISC',
        date: 'Feb 11, 2026',
      });
      const { credits, conflicts } = mergeRelayLegCredits([credit()], [incoming]);
      expect(conflicts).toStrictEqual([]);
      expect(credits[0]).toStrictEqual(incoming);
    });

    it('never replaces a value the existing credit has, even when it only fills elsewhere', () => {
      const existing = credit({ legLabel: 'Anchor', relayPlace: 6 });
      const incoming = credit({ legLabel: 'Leadoff', relayPlace: 1, relayLetter: 'B' });
      const { credits, conflicts } = mergeRelayLegCredits([existing], [incoming]);
      expect(conflicts).toStrictEqual([]);
      expect([credits[0].legLabel, credits[0].relayPlace, credits[0].relayLetter]).toStrictEqual(['Anchor', 6, 'B']);
    });

    it('does not fill isLeadoff, name or sourceUrl', () => {
      const existing = credit({ isLeadoff: false, name: 'A' });
      const { credits } = mergeRelayLegCredits([existing], [credit({ isLeadoff: true, name: 'B', legLabel: 'Leadoff' })]);
      expect([credits[0].isLeadoff, credits[0].name, credits[0].legLabel]).toStrictEqual([false, 'A', 'Leadoff']);
    });

    it('returns the very same object when the incoming copy adds nothing', () => {
      const existing = credit({ legPosition: 4, legPositionSource: 'leg-word' });
      expect(mergeRelayLegCredits([existing], [credit()]).credits[0]).toBe(existing);
    });

    it('a repeated id inside incoming fills against the credit accepted first', () => {
      const { credits, conflicts } = mergeRelayLegCredits([], [credit(), credit({ timeType: 'SCY' })]);
      expect(conflicts).toStrictEqual([]);
      expect(credits).toHaveLength(1);
      expect(credits[0].timeType).toBe('SCY');
    });
  });

  describe('conflicts on stated facts (ruling 3a)', () => {
    it('legPosition 4 against 3: one conflict, existing unchanged, nothing filled', () => {
      const existing = credit({ legPosition: 4, legPositionSource: 'leg-word' });
      const incoming = credit({ legPosition: 3, legPositionSource: 'event-page-join', legLabel: 'Third', relayPlace: 6 });
      const { credits, conflicts } = mergeRelayLegCredits([existing], [incoming]);
      expect(credits).toStrictEqual([existing]);
      expect(credits[0]).toBe(existing);
      expect(conflicts).toStrictEqual([{ existing, incoming, fields: ['legPosition'] }]);
    });

    it('SCY against LCM: one conflict, and a fillable field on the same copy is not filled', () => {
      const existing = credit({ timeType: 'SCY' });
      const incoming = credit({ timeType: 'LCM', relayLetter: 'A' });
      const { credits, conflicts } = mergeRelayLegCredits([existing], [incoming]);
      expect(credits).toStrictEqual([existing]);
      expect('relayLetter' in credits[0]).toBe(false);
      expect(conflicts.map((c) => c.fields)).toStrictEqual([['timeType']]);
    });

    it('relayEventTitle, eventRef and relayEvent conflict when both state them and differ', () => {
      const existing = credit({ relayEventTitle: '200 Medley Relay Men' });
      const result = mergeRelayLegCredits(
        [existing],
        [credit({ relayEventTitle: '200 Medley Relay Women' }), credit({ eventRef: '9' }), credit({ relayEvent: '400 FR-R' })],
      );
      expect(result.credits).toStrictEqual([existing]);
      expect(result.conflicts.map((c) => c.fields)).toStrictEqual([['relayEventTitle'], ['eventRef'], ['relayEvent']]);
    });

    it('lists every disagreeing field in one conflict', () => {
      const existing = credit({ timeType: 'SCY', legPosition: 4, legPositionSource: 'leg-word' });
      const incoming = credit({ split: '20.00', timeType: 'LCM', legPosition: 3, legPositionSource: 'event-page-join' });
      expect(mergeRelayLegCredits([existing], [incoming]).conflicts.map((c) => c.fields)).toStrictEqual([['split', 'legPosition', 'timeType']]);
    });

    it('a field only one copy states is not a disagreement', () => {
      expect(mergeRelayLegCredits([credit({ timeType: 'SCY' })], [credit()]).conflicts).toStrictEqual([]);
      expect(mergeRelayLegCredits([credit()], [credit({ timeType: 'SCY' })]).conflicts).toStrictEqual([]);
    });
  });

  it('handles an id repeated inside incoming against the first one accepted', () => {
    const first = credit({ swimCloudSwimId: '5', split: '21.00' });
    const second = credit({ swimCloudSwimId: '5', split: '22.00' });
    const { credits, conflicts } = mergeRelayLegCredits([], [first, second]);
    expect(credits).toStrictEqual([first]);
    expect(conflicts).toHaveLength(1);
  });

  it('does not mutate its inputs', () => {
    const existing = [credit({ swimCloudSwimId: '1' })];
    const incoming = [credit({ swimCloudSwimId: '2' })];
    mergeRelayLegCredits(existing, incoming);
    expect(existing).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* relayEventTitle_fromFixtureNav                                              */
/* -------------------------------------------------------------------------- */

describe('relayEventTitle_fromFixtureNav', () => {
  it('reads "200 Medley Relay Men" from the event menu, and does not expand MED-R', () => {
    const leg = swimmerPage().relayLegs[0];
    expect(leg.relayEvent).toBe('200 MED-R');
    expect(leg.relayEventTitle).toBe('200 Medley Relay Men');
    expect(leg.eventRef).toBe('2');
  });

  it('reads the menu title verbatim even when it is worded unlike any expansion of the printed label', () => {
    const html = SWIMMER_HTML.replace(/title="200 Medley Relay Men"/g, 'title="Men\'s 200 Medley Relay (Finals)"');
    expect(html).not.toBe(SWIMMER_HTML);
    expect(swimmerPage(html).relayLegs[0].relayEventTitle).toBe("Men's 200 Medley Relay (Finals)");
  });

  it('reads the title of the credit\'s own event, not a neighbouring entry (event 1 is the women\'s relay)', () => {
    expect(swimmerPage().relayLegs[0].relayEventTitle).not.toBe('200 Medley Relay Women');
  });

  it('leaves the title absent when the menu has no entry for the event', () => {
    const html = SWIMMER_HTML.replace('href="/results/399227/event/2/" class="c-events__link', 'href="/results/399227/event/99/" class="c-events__link');
    const leg = swimmerPage(html).relayLegs[0];
    expect('relayEventTitle' in leg).toBe(false);
    expect(leg.relayEvent).toBe('200 MED-R');
  });

  it('leaves the title absent when two menu entries for one event disagree', () => {
    const html = SWIMMER_HTML.replace(
      '<ul id="meet-events-portal-list"',
      `<ul><li><a href="/results/399227/event/2/" class="c-events__link"><div class="c-events__link-body" title="Something Else"></div></a></li></ul><ul id="meet-events-portal-list"`,
    );
    expect(html).not.toBe(SWIMMER_HTML);
    expect('relayEventTitle' in swimmerPage(html).relayLegs[0]).toBe(false);
  });

  it('ignores a menu entry that belongs to another meet', () => {
    const html = SWIMMER_HTML.replace(/\/results\/399227\/event\/2\/" class="c-events__link/, '/results/111/event/2/" class="c-events__link');
    expect('relayEventTitle' in swimmerPage(html).relayLegs[0]).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* relayLegSlot_absentWithoutPositionOrTitle                                   */
/* -------------------------------------------------------------------------- */

describe('relayLegSlot_absentWithoutPositionOrTitle', () => {
  const anchor = (): RelayLegCredit => convert()[0];

  it('gives the medley anchor a 50 free takeover slot', () => {
    expect(relayLegSlotOf(anchor())).toStrictEqual({ distance: 50, stroke: 'free', position: 4, start: 'takeover' });
  });

  it('is null with no position', () => {
    const { legPosition: _p, legPositionSource: _s, ...rest } = anchor();
    void _p;
    void _s;
    expect(relayLegSlotOf(rest)).toBeNull();
  });

  it('is null with no title, and never expands the MED-R abbreviation', () => {
    const { relayEventTitle: _t, ...rest } = anchor();
    void _t;
    expect(rest.relayEvent).toBe('200 MED-R');
    expect(relayLegSlotOf(rest)).toBeNull();
  });

  it('is null when the title names no relay distance', () => {
    expect(relayLegSlotOf({ ...anchor(), relayEventTitle: '200 Free Men' })).toBeNull();
    expect(relayLegSlotOf({ ...anchor(), relayEventTitle: '   ' })).toBeNull();
  });

  it('reads the stroke from the medley order and the distance from the title', () => {
    const at = (position: 1 | 2 | 3 | 4) => relayLegSlotOf({ ...anchor(), legPosition: position, isLeadoff: position === 1 });
    expect([1, 2, 3, 4].map((p) => at(p as 1 | 2 | 3 | 4)?.stroke)).toStrictEqual(['back', 'breast', 'fly', 'free']);
    expect(relayLegSlotOf({ ...anchor(), relayEventTitle: '400 Medley Relay Women', legPosition: 2 })).toStrictEqual({
      distance: 100,
      stroke: 'breast',
      position: 2,
      start: 'takeover',
    });
  });

  it('a free relay swims free on every leg', () => {
    const free = (p: 1 | 2 | 3 | 4) => relayLegSlotOf({ ...anchor(), relayEvent: '200 FR-R', relayEventTitle: '200 Free Relay Men', legPosition: p, isLeadoff: false });
    expect([1, 2, 3, 4].map((p) => free(p as 1 | 2 | 3 | 4)?.stroke)).toStrictEqual(['free', 'free', 'free', 'free']);
  });

  it('start follows the position, not isLeadoff: a leg 1 proved by the event page is a flat start', () => {
    const joined = { ...anchor(), legPosition: 1 as const, legPositionSource: 'event-page-join' as const, isLeadoff: false };
    expect(relayLegSlotOf(joined)?.start).toBe('flat');
    expect(relayLegSlotOf({ ...anchor(), legPosition: 3, isLeadoff: false })?.start).toBe('takeover');
  });

  it('is null for a credit that contradicts itself (isLeadoff but position 4)', () => {
    expect(relayLegSlotOf({ ...anchor(), isLeadoff: true, legPosition: 4 })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Converter: positions, course, failures (I4)                                 */
/* -------------------------------------------------------------------------- */

describe('swimCloudRelayCreditsToRelayLegCredits', () => {
  it('Leadoff gives position 1 from the leg word', () => {
    const html = SWIMMER_HTML.replace('200 MED-R\n                      (Anchor)', '200 MED-R\n                      (Leadoff)');
    const [leg] = convert(html);
    expect([leg.legPosition, leg.legPositionSource, leg.isLeadoff]).toStrictEqual([1, 'leg-word', true]);
    expect(relayLegSlotOf(leg)).toStrictEqual({ distance: 50, stroke: 'back', position: 1, start: 'flat' });
  });

  it('an unmapped leg word or no word gives no position', () => {
    for (const word of ['2nd Leg', null]) {
      const html = SWIMMER_HTML.replace('200 MED-R\n                      (Anchor)', word === null ? '200 MED-R' : `200 MED-R\n                      (${word})`);
      const [leg] = convert(html);
      expect('legPosition' in leg).toBe(false);
      expect('legPositionSource' in leg).toBe(false);
      expect(relayLegSlotOf(leg)).toBeNull();
    }
  });

  describe('with the event page (synthetic pair built from F-C ids, as in the parser tests)', () => {
    const page = (() => {
      const r = parseRelayEventEntriesHtml(EVENT_HTML, ctx(EVENT_URL));
      if (!r.ok) throw new Error(r.failure.message);
      return r.data;
    })();
    const real = swimmerPage().relayLegs[0];
    // River Paulk's leg 4 of HSU (A), as a swimmer-page credit with no leg word.
    const bare = (): SwimCloudRelayLegCredit => {
      const { legLabel: _l, legIndex: _i, ...rest } = { ...real, meetId: '401354', eventRef: '22', swimmerId: '1472365', swimCloudSwimId: '188544376', swimKey: '401354:swim:188544376', time: '20.03' };
      void _l;
      void _i;
      return rest as SwimCloudRelayLegCredit;
    };
    const parse = (leg: SwimCloudRelayLegCredit): SwimCloudMeetSwimmerCredits => ({ ...swimmerPage(), meetId: '401354', swimmerId: '1472365', relayLegs: [leg] });

    it('a matched join supplies the position and the relay letter', () => {
      const leg = bare();
      const join = joinRelayCreditsToEventEntries([leg], page);
      const result = swimCloudRelayCreditsToRelayLegCredits(parse(leg), { ...OPTIONS, eventPageJoin: join });
      if (!result.ok) throw new Error(result.reason);
      const [out] = result.credits;
      expect([out.legPosition, out.legPositionSource, out.relayLetter]).toStrictEqual([4, 'event-page-join', 'A']);
    });

    it('without the join the same credit has no position', () => {
      const result = swimCloudRelayCreditsToRelayLegCredits(parse(bare()), OPTIONS);
      if (!result.ok) throw new Error(result.reason);
      expect('legPosition' in result.credits[0]).toBe(false);
    });

    it('a join conflict leaves the position absent and is reported', () => {
      const leg: SwimCloudRelayLegCredit = { ...bare(), legLabel: 'Leadoff', legIndex: 1, isLeadoff: true };
      const join = joinRelayCreditsToEventEntries([leg], page);
      expect(join.conflicts.map((c) => c.reason)).toStrictEqual(['leg-position-differs']);
      const result = swimCloudRelayCreditsToRelayLegCredits(parse(leg), { ...OPTIONS, eventPageJoin: join });
      if (!result.ok) throw new Error(result.reason);
      expect('legPosition' in result.credits[0]).toBe(false);
      expect(result.joinConflicts).toStrictEqual([{ swimCloudSwimId: '188544376', reason: 'leg-position-differs' }]);
    });
  });

  it('timeType comes only from the caller\'s meetCourse, never a default', () => {
    expect('timeType' in convert()[0]).toBe(false);
    expect(convert(SWIMMER_HTML, { meetCourse: 'SCY' })[0].timeType).toBe('SCY');
  });

  it('optional context is stamped only when given', () => {
    const [leg] = convert(SWIMMER_HTML, { meetLabel: 'NSISC Champs', date: 'Feb 11, 2026' });
    expect([leg.meetLabel, leg.date]).toStrictEqual(['NSISC Champs', 'Feb 11, 2026']);
    const [bare] = convert();
    expect('meetLabel' in bare || 'date' in bare).toBe(false);
  });

  it('refuses a page with no swimmer name rather than store credits under a placeholder', () => {
    const result = swimCloudRelayCreditsToRelayLegCredits({ ...swimmerPage(), swimmerName: undefined }, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-swimmer-name');
  });

  it('converts only relay legs: the individual swims and the extracted split on the page are not credits', () => {
    expect(convert()).toHaveLength(1);
    expect(swimmerPage().individualSwims.length + swimmerPage().extractedSplits.length).toBe(3);
  });
});
