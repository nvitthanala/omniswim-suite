/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Identity agreement (plan R3). The codebase has about twenty functions that
 * turn a swimmer name, a team name or an event label into a comparison key.
 * Two of them that read one input differently move points or merge two
 * swimmers without an error. This test pins, per family:
 *
 *  - the output of every function on a corpus of real labels (the explicit
 *    tables below), so a change to any one of them is visible in review;
 *  - the pairs that must stay equal (structural agreement), checked on the
 *    corpus AND on every label in the tracked fixtures;
 *  - the pairs that differ today, by concrete input. A difference listed under
 *    "intentional" is documented in the source. A difference listed under
 *    "accidental" is a known defect that this test records and does not fix:
 *    when one is fixed, its assertion fails and the entry moves.
 *
 * Corpus sources: HyTek labels from `data/demo-seed.json` and
 * `tests/fixtures/*.json`; SwimCloud labels from the four tracked
 * `profile_fastest_times-*.json` fixtures (as `swimCloudSwimmerTimesToHistoricalSwims`
 * writes them); `eventCatalog.ts` plan labels; names that appear in test and
 * source comments (`Malone, Curtis, Jr.`, `Olivér Pózvai`, `Akin, Bartu`).
 * `data/meets.json` is not tracked, so nothing here reads it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SwimmerResult } from '../packages/core/src/types';
import { canonicalMeetEventLabel, isChampionshipProgramEvent, normalizeEventLabel } from '../packages/core/src/lib/athleteHistory';
import {
  isDivingEvent as isDivingEventCutline,
  normalizeEventForCutline,
  stripRelaySplitSuffix,
} from '../packages/core/src/lib/cutlineEventNames';
import { canonicalProgramEvent } from '../packages/core/src/lib/eventIdentity';
import { aliasIdentityKey, aliasIndividualEventKey, aliasNameKey } from '../packages/core/src/lib/athleteAliases';
import { swimEventIdentity } from '../packages/core/src/lib/bestTimeEligibility';
import { relayLegEventKey, relayLegNameKeys } from '../packages/core/src/lib/relayLegMatching';
import { athleteNameKey, stripCourseSuffix } from '../packages/core/src/lib/rosterCatalog';
import { stripEventGenderMarker } from '../packages/core/src/lib/eventLabels';
import { resolveConversionFactorKey } from '../packages/core/src/lib/scyConversion';
import { canonicalSwimmerName, foldDiacritics, normalizeSwimmerName } from '../packages/core/src/lib/swimmerNames';
import { scorerRosterKey } from '../packages/core/src/lib/scorerRoster';
import { normalizeTeamKey, teamLabelKey } from '../packages/core/src/data/teamAliases';
import { normalizeTeamNameForColorLookup } from '../packages/core/src/lib/teamColorLookup';
import { isDivingEvent as isDivingEventScoring } from '../packages/core/src/lib/scoringRules';

/** Written precomposed; the A7 case builds its decomposed twin with `normalize`. */
const ACCENTED = 'Oliv\u00e9r P\u00f3zvai';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* The functions, one table per family                                         */
/* -------------------------------------------------------------------------- */

type Out = string | null | boolean | string[];

/** Order matches the columns of EVENT_ROWS. */
const EVENT_FNS: Record<string, (e: string) => Out> = {
  normalizeEventLabel,
  normalizeEventForCutline,
  canonicalMeetEventLabel,
  canonicalProgramEvent,
  aliasIndividualEventKey,
  swimEventIdentity,
  relayLegEventKey,
  stripCourseSuffix,
  stripEventGenderMarker,
  resolveConversionFactorKey,
  isDivingEventScoring: e => isDivingEventScoring(e),
  isDivingEventCutline: e => isDivingEventCutline(e),
};

/** The leg-name key, read through its public wrapper. */
function legNameKeysOf(name: string): string[] {
  const row = { relayNames: [{ name, year: '' }] } as unknown as SwimmerResult;
  return [...relayLegNameKeys(row)];
}

/** Order matches the columns of NAME_ROWS. */
const NAME_FNS: Record<string, (n: string) => Out> = {
  normalizeSwimmerName,
  canonicalSwimmerName,
  aliasNameKey,
  aliasIdentityKey,
  athleteNameKey,
  relayLegNameKeys: legNameKeysOf,
  scorerRosterKeyName: n => scorerRosterKey('T', 'M', n).split('|||')[2] as string,
};

/** Order matches the columns of TEAM_ROWS. */
const TEAM_FNS: Record<string, (t: string) => Out> = {
  normalizeTeamKey,
  normalizeTeamNameForColorLookup,
  teamLabelKey,
  normalizeSwimmerName,
};

/* -------------------------------------------------------------------------- */
/* Pinned outputs                                                              */
/* -------------------------------------------------------------------------- */

type Row = [string, ...Out[]];

// [input, normalizeEventLabel, normalizeEventForCutline, canonicalMeetEventLabel,
//  canonicalProgramEvent, aliasIndividualEventKey, swimEventIdentity, relayLegEventKey,
//  stripCourseSuffix, stripEventGenderMarker, resolveConversionFactorKey,
//  isDivingEventScoring, isDivingEventCutline]
const EVENT_ROWS: Row[] = [
  ["Event 24 Men 100 Yard Backstroke", "Event 24 Men 100 Yard Backstroke", "100 Backstroke", "100 Backstroke", "100 Backstroke", "100 backstroke", "100 backstroke", "100 backstroke", "Event 24 Men 100 Yard Backstroke", "Event 24 100 Yard Backstroke", "100 Backstroke", false, false],
  ["Event 8 Men 50 Yard Freestyle", "Event 8 Men 50 Yard Freestyle", "50 Freestyle", "50 Freestyle", "50 Freestyle", "50 freestyle", "50 freestyle", "50 freestyle", "Event 8 Men 50 Yard Freestyle", "Event 8 50 Yard Freestyle", "50 Freestyle", false, false],
  ["Event 15 Men 400 Yard IM", "Event 15 Men 400 Yard Individual Medley", "400 Individual Medley", "400 Individual Medley", "400 Individual Medley", "400 individual medley", "400 individual medley", "400 individual medley", "Event 15 Men 400 Yard IM", "Event 15 400 Yard IM", "400 Individual Medley", false, false],
  ["Event 5 Women 200 Yard IM", "Event 5 Women 200 Yard Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 individual medley", "200 individual medley", "200 individual medley", "Event 5 Women 200 Yard IM", "Event 5 200 Yard IM", "200 Individual Medley", false, false],
  ["Event 32 Women 1650 Yard Freestyle", "Event 32 Women 1650 Yard Freestyle", "1650 Freestyle", "1650 Freestyle", "1650 Freestyle", "1650 freestyle", "1650 freestyle", "1650 freestyle", "Event 32 Women 1650 Yard Freestyle", "Event 32 1650 Yard Freestyle", "1650 Freestyle", false, false],
  ["Event 100 Men 100 Yard Breaststroke Time Trial", "Event 100 Men 100 Yard Breaststroke Time Trial", "100 Breaststroke", "100 Breaststroke Time Trial", null, null, "100 breaststroke time trial", "100 breaststroke", "Event 100 Men 100 Yard Breaststroke Time Trial", "Event 100 100 Yard Breaststroke Time Trial", "100 Breaststroke", false, false],
  ["Event 403 Mixed 50 Yard Freestyle Time Trial", "Event 403 Mixed 50 Yard Freestyle Time Trial", "50 Freestyle", "Mixed 50 Freestyle Time Trial", null, null, "50 freestyle time trial", "50 freestyle", "Event 403 Mixed 50 Yard Freestyle Time Trial", "Event 403 Mixed 50 Yard Freestyle Time Trial", "50 Freestyle", false, false],
  ["Event 939 Boys 100 Yard Breaststroke", "Event 939 Boys 100 Yard Breaststroke", "100 Breaststroke", "100 Breaststroke", "100 Breaststroke", "100 breaststroke", "100 breaststroke", "100 breaststroke", "Event 939 Boys 100 Yard Breaststroke", "Event 939 100 Yard Breaststroke", "100 Breaststroke", false, false],
  ["Event 31 Men 4x50 Yard Freestyle Relay", "Event 31 Men 4x50 Yard Freestyle Relay", "200 Freestyle Relay", null, null, null, "200 freestyle relay", "200 freestyle relay", "Event 31 Men 4x50 Yard Freestyle Relay", "Event 31 4x50 Yard Freestyle Relay", null, false, false],
  ["Event 11 Men 4x50 Yard Medley Relay", "Event 11 Men 4x50 Yard Medley Relay", "200 Medley Relay", null, null, null, "200 medley relay", "200 medley relay", "Event 11 Men 4x50 Yard Medley Relay", "Event 11 4x50 Yard Medley Relay", null, false, false],
  ["Event 2 Men 4x200 Yard Freestyle Relay", "Event 2 Men 4x200 Yard Freestyle Relay", "800 Freestyle Relay", null, null, null, "800 freestyle relay", "800 freestyle relay", "Event 2 Men 4x200 Yard Freestyle Relay", "Event 2 4x200 Yard Freestyle Relay", null, false, false],
  ["Event 29 Men 3 mtr Diving", "Event 29 Men 3 mtr Diving", "3-Meter Diving", null, null, null, "3-meter diving", "3-meter diving", "Event 29 Men 3 mtr Diving", "Event 29 3 mtr Diving", null, true, true],
  ["Event 9 Men 1 mtr Diving", "Event 9 Men 1 mtr Diving", "1-Meter Diving", null, null, null, "1-meter diving", "1-meter diving", "Event 9 Men 1 mtr Diving", "Event 9 1 mtr Diving", null, true, true],
  ["100 Backstroke", "100 Backstroke", "100 Backstroke", "100 Backstroke", "100 Backstroke", "100 backstroke", "100 backstroke", "100 backstroke", "100 Backstroke", "100 Backstroke", "100 Backstroke", false, false],
  ["200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 individual medley", "200 individual medley", "200 individual medley", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", false, false],
  ["1000 Freestyle", "1000 Freestyle", "1000 Freestyle", "1000 Freestyle", "1000 Freestyle", "1000 freestyle", "1000 freestyle", "1000 freestyle", "1000 Freestyle", "1000 Freestyle", "1000 Freestyle", false, false],
  ["1650 Freestyle", "1650 Freestyle", "1650 Freestyle", "1650 Freestyle", "1650 Freestyle", "1650 freestyle", "1650 freestyle", "1650 freestyle", "1650 Freestyle", "1650 Freestyle", "1650 Freestyle", false, false],
  ["100 Individual Medley", "100 Individual Medley", "100 Individual Medley", "100 Individual Medley", null, "100 individual medley", "100 individual medley", "100 individual medley", "100 Individual Medley", "100 Individual Medley", null, false, false],
  ["50 Backstroke", "50 Backstroke", "50 Backstroke", "50 Backstroke", null, "50 backstroke", "50 backstroke", "50 backstroke", "50 Backstroke", "50 Backstroke", "100 Backstroke", false, false],
  ["50 Free SCY", "50 Freestyle", "50 Freestyle", "50 Freestyle", "50 Freestyle", "50 freestyle", "50 freestyle", "50 freestyle", "50 Free", "50 Free SCY", "50 Freestyle", false, false],
  ["100 Back LCM", "100 Backstroke", "100 Backstroke", "100 Backstroke", "100 Backstroke", "100 backstroke", "100 backstroke", "100 backstroke", "100 Back", "100 Back LCM", "100 Backstroke", false, false],
  ["100 Breast SCM", "100 Breaststroke", "100 Breaststroke", "100 Breaststroke", "100 Breaststroke", "100 breaststroke", "100 breaststroke", "100 breaststroke", "100 Breast", "100 Breast SCM", "100 Breaststroke", false, false],
  ["200 IM SCY", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 individual medley", "200 individual medley", "200 individual medley", "200 IM", "200 IM SCY", "200 Individual Medley", false, false],
  ["200 IM LCM", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 individual medley", "200 individual medley", "200 individual medley", "200 IM", "200 IM LCM", "200 Individual Medley", false, false],
  ["1 mtr Diving", "1 mtr Diving", "1-Meter Diving", null, null, null, "1-meter diving", "1-meter diving", "1 mtr Diving", "1 mtr Diving", null, true, true],
  ["3 mtr Diving", "3 mtr Diving", "3-Meter Diving", null, null, null, "3-meter diving", "3-meter diving", "3 mtr Diving", "3 mtr Diving", null, true, true],
  ["25 Fly SCY", "25 Butterfly", "25 Butterfly", "25 Butterfly", null, "25 butterfly", "25 butterfly", "25 butterfly", "25 Fly", "25 Fly SCY", null, false, false],
  ["1000 Free SCY", "1000 Freestyle", "1000 Freestyle", "1000 Freestyle", "1000 Freestyle", "1000 freestyle", "1000 freestyle", "1000 freestyle", "1000 Free", "1000 Free SCY", "1000 Freestyle", false, false],
  ["1500 Free LCM", "1500 Freestyle", "1500 Freestyle", "1500 Freestyle", null, "1500 freestyle", "1500 freestyle", "1500 freestyle", "1500 Free", "1500 Free LCM", "1500 Freestyle", false, false],
  ["200 IM", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 Individual Medley", "200 individual medley", "200 individual medley", "200 individual medley", "200 IM", "200 IM", "200 IM", false, false],
  ["1M Diving", "1M Diving", "1-Meter Diving", null, null, null, "1-meter diving", "1-meter diving", "1M Diving", "1M Diving", null, true, true],
  ["3M Diving", "3M Diving", "3-Meter Diving", null, null, null, "3-meter diving", "3-meter diving", "3M Diving", "3M Diving", null, true, true],
  ["Platform Diving", "Platform Diving", "Platform Diving", null, null, null, "platform diving", "platform diving", "Platform Diving", "Platform Diving", null, true, true],
  ["50 Freestyle (Relay split)", "50 Freestyle (Relay split)", "50 Freestyle (Relay split)", null, null, null, "50 freestyle (relay split)", "50 freestyle", "50 Freestyle (Relay split)", "50 Freestyle (Relay split)", "50 Freestyle", false, false],
  ["1,650 Freestyle", "1,650 Freestyle", "1650 Freestyle", "1,650 Freestyle", null, null, "1650 freestyle", "1650 freestyle", "1,650 Freestyle", "1,650 Freestyle", "1650 Freestyle", false, false],
  ["4x50 Free", "4x50 Freestyle", "200 Freestyle Relay", "4x50 Freestyle", null, null, "200 freestyle relay", "200 freestyle relay", "4x50 Free", "4x50 Free", null, false, false],
  ["4 x 100 Medley Relay", "4 x 100 Medley Relay", "400 Medley Relay", null, null, null, "400 medley relay", "400 medley relay", "4 x 100 Medley Relay", "4 x 100 Medley Relay", null, false, false],
  ["50 Meter Freestyle", "50 Meter Freestyle", "50 Freestyle", "50 Freestyle", "50 Freestyle", "50 freestyle", "50 freestyle", "50 freestyle", "50 Meter Freestyle", "50 Meter Freestyle", "50 Freestyle", false, false],
  ["50 Metres Freestyle", "50 Metres Freestyle", "50 Freestyle", "50 Metres Freestyle", null, "50 freestyle", "50 freestyle", "50 freestyle", "50 Metres Freestyle", "50 Metres Freestyle", "50 Freestyle", false, false],
  ["Event 10 Women 50 Meter Freestyle", "Event 10 Women 50 Meter Freestyle", "50 Freestyle", "50 Freestyle", "50 Freestyle", "50 freestyle", "50 freestyle", "50 freestyle", "Event 10 Women 50 Meter Freestyle", "Event 10 50 Meter Freestyle", "50 Freestyle", false, false],
  ["100 Freestyle (relay split)", "100 Freestyle (relay split)", "100 Freestyle (relay split)", null, null, null, "100 freestyle (relay split)", "100 freestyle", "100 Freestyle (relay split)", "100 Freestyle (relay split)", "100 Freestyle", false, false],
  ["  50   Free  scy ", "50 Freestyle", "50 Freestyle", "50 Freestyle", "50 Freestyle", "50 freestyle", "50 freestyle", "50 freestyle", "50 Free", "50 Free scy", "50 Freestyle", false, false],
  ["200 FR", "200 FR", "200 Freestyle Relay", "200 FR", null, null, "200 freestyle relay", "200 freestyle relay", "200 FR", "200 FR", null, false, false],
  ["200 MR", "200 MR", "200 Medley Relay", "200 MR", null, null, "200 medley relay", "200 medley relay", "200 MR", "200 MR", null, false, false],
  ["100 Back", "100 Backstroke", "100 Backstroke", "100 Backstroke", "100 Backstroke", "100 backstroke", "100 backstroke", "100 backstroke", "100 Back", "100 Back", "100 Backstroke", false, false],
  ["100 Freestyle (Avg Split)", "100 Freestyle (Avg Split)", "100 Freestyle (Avg Split)", "100 Freestyle (Avg Split)", null, null, "100 freestyle (avg split)", "100 freestyle (avg split)", "100 Freestyle (Avg Split)", "100 Freestyle (Avg Split)", null, false, false],
  ["1M Dives", "1M Dives", "1-Meter Diving", "1M Dives", null, null, "1-meter diving", "1-meter diving", "1M Dives", "1M Dives", null, false, true],
  ["", "", "", null, null, null, "", "", "", "", null, false, false],
];

// [input, normalizeSwimmerName, canonicalSwimmerName, aliasNameKey, aliasIdentityKey,
//  athleteNameKey, relayLegNameKeys, scorerRosterKey name part]
const NAME_ROWS: Row[] = [
  ["Bartu Akin", "bartu akin", "bartu akin", "bartu akin", "bartu akin", "bartu akin", ["bartu akin"], "bartu akin"],
  ["Akin, Bartu", "akin, bartu", "bartu akin", "bartu akin", "bartu akin", "akin, bartu", ["akin, bartu"], "bartu akin"],
  [" bartu  akin ", "bartu akin", "bartu akin", "bartu akin", "bartu akin", "bartu akin", ["bartu akin"], "bartu akin"],
  ["BARTU AKIN", "bartu akin", "bartu akin", "bartu akin", "bartu akin", "bartu akin", ["bartu akin"], "bartu akin"],
  ["Malone, Curtis, Jr.", "malone, curtis, jr.", "malone, curtis, jr.", "malone, curtis, jr.", "malone, curtis, jr.", "malone, curtis, jr.", ["malone, curtis, jr."], "malone, curtis, jr."],
  ["Curtis Malone Jr.", "curtis malone jr.", "curtis malone jr.", "curtis malone jr.", "curtis malone jr.", "curtis malone jr.", ["curtis malone jr."], "curtis malone jr."],
  ["Oliv\u00e9r P\u00f3zvai", "oliv\u00e9r p\u00f3zvai", "oliv\u00e9r p\u00f3zvai", "oliver pozvai", "oliv\u00e9r p\u00f3zvai", "oliv\u00e9r p\u00f3zvai", ["oliv\u00e9r p\u00f3zvai"], "oliv\u00e9r p\u00f3zvai"],
  ["Oliver Pozvai", "oliver pozvai", "oliver pozvai", "oliver pozvai", "oliver pozvai", "oliver pozvai", ["oliver pozvai"], "oliver pozvai"],
  ["P\u00f3zvai, Oliv\u00e9r", "p\u00f3zvai, oliv\u00e9r", "oliv\u00e9r p\u00f3zvai", "oliver pozvai", "oliv\u00e9r p\u00f3zvai", "p\u00f3zvai, oliv\u00e9r", ["p\u00f3zvai, oliv\u00e9r"], "oliv\u00e9r p\u00f3zvai"],
  ["Olive\u0301r Po\u0301zvai", "olive\u0301r po\u0301zvai", "olive\u0301r po\u0301zvai", "oliver pozvai", "olive\u0301r po\u0301zvai", "olive\u0301r po\u0301zvai", ["olive\u0301r po\u0301zvai"], "olive\u0301r po\u0301zvai"],
  ["Alan Alejan Gonz\u00e1lez Mujica", "alan alejan gonz\u00e1lez mujica", "alan alejan gonz\u00e1lez mujica", "alan alejan gonzalez mujica", "alan alejan gonz\u00e1lez mujica", "alan alejan gonz\u00e1lez mujica", ["alan alejan gonz\u00e1lez mujica"], "alan alejan gonz\u00e1lez mujica"],
  ["M\u00e1t\u00e9 Hossz\u00fa", "m\u00e1t\u00e9 hossz\u00fa", "m\u00e1t\u00e9 hossz\u00fa", "mate hosszu", "m\u00e1t\u00e9 hossz\u00fa", "m\u00e1t\u00e9 hossz\u00fa", ["m\u00e1t\u00e9 hossz\u00fa"], "m\u00e1t\u00e9 hossz\u00fa"],
  ["Mc Namara, Iris", "mc namara, iris", "iris mc namara", "iris mc namara", "iris mc namara", "mc namara, iris", ["mc namara, iris"], "iris mc namara"],
  ["McNamara, Iris", "mcnamara, iris", "iris mcnamara", "iris mcnamara", "iris mcnamara", "mcnamara, iris", ["mcnamara, iris"], "iris mcnamara"],
  ["Iris McNamara", "iris mcnamara", "iris mcnamara", "iris mcnamara", "iris mcnamara", "iris mcnamara", ["iris mcnamara"], "iris mcnamara"],
  ["O'Brien, Pat", "o'brien, pat", "pat o'brien", "pat o'brien", "pat o'brien", "o'brien, pat", ["o'brien, pat"], "pat o'brien"],
  ["Smith,John", "smith,john", "john smith", "john smith", "john smith", "smith,john", ["smith,john"], "john smith"],
  [", Smith", ", smith", ", smith", ", smith", ", smith", ", smith", [", smith"], ", smith"],
  ["Smith,", "smith,", "smith,", "smith,", "smith,", "smith,", ["smith,"], "smith,"],
  ["Allie Grace Rhodes", "allie grace rhodes", "allie grace rhodes", "allie grace rhodes", "allie grace rhodes", "allie grace rhodes", ["allie grace rhodes"], "allie grace rhodes"],
  ["Athlete 00", "athlete 00", "athlete 00", "athlete 00", "athlete 00", "athlete 00", ["athlete 00"], "athlete 00"],
  ["", "", "", "", "", "", [], ""],
  ["\u2014", "\u2014", "\u2014", "\u2014", "\u2014", "\u2014", ["\u2014"], "\u2014"],
];

// [input, normalizeTeamKey, normalizeTeamNameForColorLookup, teamLabelKey, normalizeSwimmerName]
const TEAM_ROWS: Row[] = [
  ["Henderson State University", "hendersonstateuniversity", "henderson state university", "henderson state university", "henderson state university"],
  ["Henderson State", "hendersonstate", "henderson state", "henderson state", "henderson state"],
  ["HSU", "hsu", "hsu", "hsu", "hsu"],
  ["Henderson St.", "hendersonst", "henderson st", "henderson st.", "henderson st."],
  ["  henderson   state university ", "hendersonstateuniversity", "henderson state university", "henderson   state university", "henderson state university"],
  ["Ouachita Baptist University", "ouachitabaptistuniversity", "ouachita baptist university", "ouachita baptist university", "ouachita baptist university"],
  ["Texas A&M", "texasam", "texas a and m", "texas a&m", "texas a&m"],
  ["Texas A&M University", "texasamuniversity", "texas a and m university", "texas a&m university", "texas a&m university"],
  ["Saint Mary's", "saintmarys", "saint marys", "saint mary's", "saint mary's"],
  ["St. Mary\u2019s (TX)", "stmarystx", "st mary\u2019s (tx)", "st. mary\u2019s (tx)", "st. mary\u2019s (tx)"],
  ["UNC Wilmington", "uncwilmington", "unc wilmington", "unc wilmington", "unc wilmington"],
  ["Miami (OH)", "miamioh", "miami (oh)", "miami (oh)", "miami (oh)"],
  ["Alpha University", "alphauniversity", "alpha university", "alpha university", "alpha university"],
  ["", "", "", "", ""],
];

function checkTable(rows: Row[], fns: Record<string, (s: string) => Out>): void {
  const names = Object.keys(fns);
  for (const [input, ...expected] of rows) {
    expect(expected.length, `row ${JSON.stringify(input)} column count`).toBe(names.length);
    names.forEach((fnName, i) => {
      const fn = fns[fnName] as (s: string) => Out;
      expect(fn(input), `${fnName}(${JSON.stringify(input)})`).toEqual(expected[i]);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Fixture-derived corpus (structural agreement only; outputs are not pinned)  */
/* -------------------------------------------------------------------------- */

function fixtureCorpus(): { events: string[]; names: string[]; teams: string[] } {
  const files = [
    'data/demo-seed.json',
    'tests/fixtures/bestRosterGolden.json',
    'tests/fixtures/chart-workspace.json',
    'tests/fixtures/hsu-2026-27-event-strength.json',
    'tests/fixtures/hsu-2026-27-replace-snapshot.json',
    'tests/fixtures/nsisc-2026-dq-relay-leg.json',
    'tests/fixtures/nsisc-2026-relay-followups-r1.json',
    'tests/fixtures/nsisc-2026-relay-leg-event-matching.json',
    'tests/fixtures/optimize-undo-workspace.json',
  ];
  const events = new Set<string>();
  const names = new Set<string>();
  const teams = new Set<string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (o === null || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string') {
        if (k === 'event' || k === 'eventLabel' || k === 'eventName') events.add(v);
        else if (k === 'athleteName' || k === 'swimmerName' || k === 'aliasName' || k === 'canonicalName') names.add(v);
        else if (k === 'team' || k === 'teamName') teams.add(v);
      } else walk(v);
    }
  };
  for (const f of files) walk(JSON.parse(readFileSync(join(repoRoot, f), 'utf8')));
  // A bare `name` is a swimmer on result rows and a meet or workspace name elsewhere;
  // take it only from rows that carry an `event`.
  const rows = (o: unknown): void => {
    if (Array.isArray(o)) {
      o.forEach(rows);
      return;
    }
    if (o === null || typeof o !== 'object') return;
    const rec = o as Record<string, unknown>;
    if (typeof rec.name === 'string' && typeof rec.event === 'string') names.add(rec.name);
    Object.values(rec).forEach(rows);
  };
  for (const f of files) rows(JSON.parse(readFileSync(join(repoRoot, f), 'utf8')));
  return { events: [...events].sort(), names: [...names].sort(), teams: [...teams].sort() };
}

/** Plan-sheet labels (`eventCatalog.ts`) and the SwimCloud short forms: pinned in EVENT_ROWS above. */
const SCY_PROGRAM = new Set([
  '50 Freestyle', '100 Freestyle', '200 Freestyle', '500 Freestyle', '1000 Freestyle', '1650 Freestyle',
  '100 Backstroke', '200 Backstroke', '100 Breaststroke', '200 Breaststroke', '100 Butterfly', '200 Butterfly',
  '200 Individual Medley', '400 Individual Medley',
]);

describe('identity agreement: pinned outputs', () => {
  it('events: every function, every corpus label', () => {
    checkTable(EVENT_ROWS, EVENT_FNS);
  });
  it('swimmer names: every function, every corpus name', () => {
    checkTable(NAME_ROWS, NAME_FNS);
  });
  it('team names: every function, every corpus team', () => {
    checkTable(TEAM_ROWS, TEAM_FNS);
  });
});

describe('identity agreement: pairs that must stay equal', () => {
  const fx = fixtureCorpus();
  const events = [...EVENT_ROWS.map(r => r[0]), ...fx.events];
  const names = [...NAME_ROWS.map(r => r[0]), ...fx.names];
  const teams = [...TEAM_ROWS.map(r => r[0]), ...fx.teams];

  it('the fixture corpus is not empty (a filter that matched nothing would pass silently)', () => {
    expect(fx.events.length).toBeGreaterThan(20);
    expect(fx.names.length).toBeGreaterThan(50);
    expect(fx.teams.length).toBeGreaterThanOrEqual(5);
    // The primary workspace is in the corpus.
    expect(fx.teams.some(t => /henderson state/i.test(t))).toBe(true);
  });

  it('names: aliasIdentityKey, athleteNameKey and the roster key are the named canonical forms', () => {
    for (const n of names) {
      expect(aliasIdentityKey(n), n).toBe(canonicalSwimmerName(n));
      expect(athleteNameKey(n), n).toBe(normalizeSwimmerName(n));
      expect(aliasNameKey(n), n).toBe(foldDiacritics(canonicalSwimmerName(n)));
      expect(scorerRosterKey('T', 'M', n).split('|||')[2], n).toBe(canonicalSwimmerName(n));
      // The relay-leg key is the low-level key. It never folds "Last, First".
      const legs = legNameKeysOf(n);
      expect(legs, n).toEqual(n === '' ? [] : [normalizeSwimmerName(n)]);
    }
  });

  it('names: canonicalSwimmerName only differs from normalizeSwimmerName on a single-comma name', () => {
    for (const n of names) {
      const commas = (n.match(/,/g) ?? []).length;
      if (commas !== 1) expect(canonicalSwimmerName(n), n).toBe(normalizeSwimmerName(n));
    }
  });

  it('events: canonicalProgramEvent is canonicalMeetEventLabel filtered to the SCY program', () => {
    for (const e of events) {
      const c = canonicalMeetEventLabel(e);
      const expected = c !== null && isChampionshipProgramEvent(c) && !/\brelay\b/i.test(c) ? c : null;
      expect(canonicalProgramEvent(e), e).toBe(expected);
      if (expected !== null) expect(SCY_PROGRAM.has(expected), e).toBe(true);
    }
  });

  it('events: relayLegEventKey is the cutline name of the label without its relay-split suffix, lower-cased', () => {
    for (const e of events) {
      const base = stripRelaySplitSuffix(e);
      expect(relayLegEventKey(e), e).toBe(base ? normalizeEventForCutline(base).toLowerCase() : '');
    }
  });

  it('events: swimEventIdentity is the cutline name, lower-cased, plus a time-trial marker', () => {
    for (const e of events) {
      const raw = e.replace(/\s+/g, ' ').trim();
      const tt = /\btime\s+trials?\b/i.test(raw);
      // normalizeEventForCutline already drops a trailing "Time Trial"; the identity puts it back.
      const expected = `${normalizeEventForCutline(raw) || raw}${tt ? ' time trial' : ''}`.toLowerCase();
      expect(swimEventIdentity(e), e).toBe(expected);
    }
  });

  it('events: a relay never has an individual program or alias key', () => {
    for (const e of events) {
      if (!/\brelay\b/i.test(e)) continue;
      expect(canonicalProgramEvent(e), e).toBeNull();
      expect(canonicalMeetEventLabel(e), e).toBeNull();
      expect(aliasIndividualEventKey(e), e).toBeNull();
    }
  });

  it('events: where all four individual readers answer, they name the same event', () => {
    for (const e of events) {
      const prog = canonicalProgramEvent(e);
      const alias = aliasIndividualEventKey(e);
      if (prog === null || alias === null) continue;
      expect(alias, e).toBe(prog.toLowerCase());
      expect(swimEventIdentity(e), e).toBe(prog.toLowerCase());
      expect(normalizeEventForCutline(e), e).toBe(prog);
    }
  });

  it('teams: teamLabelKey is trim + lower-case and nothing else', () => {
    for (const t of teams) expect(teamLabelKey(t), t).toBe(t.trim().toLowerCase());
    expect(teamLabelKey(undefined)).toBe('');
    expect(teamLabelKey(null)).toBe('');
  });

  it('teams: normalizeTeamKey is letters and digits only', () => {
    for (const t of teams) expect(normalizeTeamKey(t), t).toMatch(/^[a-z0-9]*$/);
  });
});

describe('identity agreement: intentional differences', () => {
  it('canonicalSwimmerName folds "Last, First"; normalizeSwimmerName is the low-level key and does not (swimmerNames.ts documents both)', () => {
    expect(canonicalSwimmerName('Akin, Bartu')).toBe('bartu akin');
    expect(normalizeSwimmerName('Akin, Bartu')).toBe('akin, bartu');
  });

  it('aliasNameKey folds diacritics (resolution key); aliasIdentityKey keeps them (pair key)', () => {
    expect(aliasNameKey(ACCENTED)).toBe('oliver pozvai');
    expect(aliasIdentityKey(ACCENTED)).toBe(ACCENTED.toLowerCase());
  });

  it('a suffix form with two commas is never reordered', () => {
    expect(canonicalSwimmerName('Malone, Curtis, Jr.')).toBe('malone, curtis, jr.');
  });

  it('a time trial is not the program event: it keeps an identity and has no alias key', () => {
    const tt = 'Event 100 Men 100 Yard Breaststroke Time Trial';
    expect(swimEventIdentity(tt)).toBe('100 breaststroke time trial');
    expect(canonicalProgramEvent(tt)).toBeNull();
    expect(aliasIndividualEventKey(tt)).toBeNull();
    expect(normalizeEventForCutline(tt)).toBe('100 Breaststroke');
  });

  it('the conversion key maps a 50 <stroke> onto the published 100 factor (scyConversion.factorKeyForSpelling: "the only sanctioned substitution")', () => {
    expect(resolveConversionFactorKey('50 Backstroke')).toBe('100 Backstroke');
  });

  it('only SCY program events are lineup candidates: 100 IM, 25 Fly and 1500 Free LCM are readable but not program events', () => {
    expect(canonicalMeetEventLabel('100 Individual Medley')).toBe('100 Individual Medley');
    expect(canonicalProgramEvent('100 Individual Medley')).toBeNull();
    expect(canonicalProgramEvent('25 Fly SCY')).toBeNull();
    expect(canonicalProgramEvent('1500 Free LCM')).toBeNull();
  });

  it('normalizeTeamKey is a fuzzy-match key (letters and digits only); teamLabelKey is an exact-match key', () => {
    expect(normalizeTeamKey('Henderson St.')).toBe('hendersonst');
    expect(teamLabelKey('Henderson St.')).toBe('henderson st.');
  });
});

/*
 * Accidental differences. Each is a real input on which two readers of "the same
 * thing" disagree. None is fixed here: a fix changes how names or events compare,
 * which is a scoring decision. When one is fixed, its assertion fails and the
 * entry moves up to the table above.
 *
 * Provenance of the inputs: A1 ("1,650 Freestyle") is the D1 cutline sheet's own
 * spelling. A2, A3, A6 and A7 are constructed to expose a regex or encoding
 * difference; they are not observed in loaded data. A4 and A5 use label forms
 * from the HyTek and D3-sheet vocabularies. A8 and A9 use real corpus labels.
 */
describe('identity agreement: accidental differences (recorded, not fixed)', () => {
  it('A1: "1,650 Freestyle" is one event to the cutline reader and an unknown label to the lineup readers', () => {
    expect(normalizeEventForCutline('1,650 Freestyle')).toBe('1650 Freestyle');
    expect(swimEventIdentity('1,650 Freestyle')).toBe('1650 freestyle');
    expect(canonicalMeetEventLabel('1,650 Freestyle')).toBe('1,650 Freestyle');
    expect(canonicalProgramEvent('1,650 Freestyle')).toBeNull();
    expect(aliasIndividualEventKey('1,650 Freestyle')).toBeNull();
  });

  it('A2: "50 Metres Freestyle": canonicalMeetEventLabel keeps "Metres", the other readers drop it', () => {
    expect(canonicalMeetEventLabel('50 Metres Freestyle')).toBe('50 Metres Freestyle');
    expect(canonicalProgramEvent('50 Metres Freestyle')).toBeNull();
    expect(aliasIndividualEventKey('50 Metres Freestyle')).toBe('50 freestyle');
    expect(normalizeEventForCutline('50 Metres Freestyle')).toBe('50 Freestyle');
  });

  it('A3: "1M Dives" is a dive to the cutline reader, an individual event to the scoring-rules reader', () => {
    expect(isDivingEventCutline('1M Dives')).toBe(true);
    expect(isDivingEventScoring('1M Dives')).toBe(false);
    expect(canonicalMeetEventLabel('1M Dives')).toBe('1M Dives');
  });

  it('A4: a relay label without the word "Relay" is a relay to the cutline reader and an individual label to canonicalMeetEventLabel', () => {
    expect(normalizeEventForCutline('4x50 Free')).toBe('200 Freestyle Relay');
    expect(canonicalMeetEventLabel('4x50 Free')).toBe('4x50 Freestyle');
    expect(canonicalMeetEventLabel('200 FR')).toBe('200 FR');
    expect(normalizeEventForCutline('200 FR')).toBe('200 Freestyle Relay');
  });

  it('A5: a Mixed time trial keeps "Mixed" in canonicalMeetEventLabel; the cutline reader strips it', () => {
    const mixed = 'Event 403 Mixed 50 Yard Freestyle Time Trial';
    expect(canonicalMeetEventLabel(mixed)).toBe('Mixed 50 Freestyle Time Trial');
    expect(normalizeEventForCutline(mixed)).toBe('50 Freestyle');
    expect(stripEventGenderMarker(mixed)).toBe(mixed);
  });

  it('A6: the colour-lookup key drops a straight apostrophe and keeps a curly one', () => {
    expect(normalizeTeamNameForColorLookup("Saint Mary's")).toBe('saint marys');
    expect(normalizeTeamNameForColorLookup('Saint Mary\u2019s')).toBe('saint mary\u2019s');
    expect(normalizeTeamKey('Saint Mary\u2019s')).toBe(normalizeTeamKey("Saint Mary's"));
  });

  it('A8: a relay-split label: swimEventIdentity keeps the suffix, relayLegEventKey drops it, the alias key is null (no source or test says which is intended)', () => {
    expect(swimEventIdentity('50 Freestyle (Relay split)')).toBe('50 freestyle (relay split)');
    expect(relayLegEventKey('50 Freestyle (Relay split)')).toBe('50 freestyle');
    expect(aliasIndividualEventKey('50 Freestyle (Relay split)')).toBeNull();
  });

  it('A9: relay-leg matching compares names with the comma-order-preserving key, so "Akin, Bartu" (leg) misses "Bartu Akin" (row)', () => {
    // relayLegMatching's private normalizeName compares an assignee or leg spelling with an
    // individual row's spelling (assignedInEvent, resolveOverrideAssignee). The same file's
    // swimmerGenderKey uses canonicalSwimmerName. scorerRosterKey cites BUG 3.4: leg rows
    // and individual rows can store names in different orders.
    expect(legNameKeysOf('Akin, Bartu')).not.toEqual(legNameKeysOf('Bartu Akin'));
    expect(canonicalSwimmerName('Akin, Bartu')).toBe(canonicalSwimmerName('Bartu Akin'));
  });

  it('A7: the same name typed precomposed and decomposed is two canonical keys until it is folded', () => {
    const nfc = ACCENTED.normalize('NFC');
    const nfd = ACCENTED.normalize('NFD');
    expect(canonicalSwimmerName(nfc)).not.toBe(canonicalSwimmerName(nfd));
    expect(aliasNameKey(nfc)).toBe(aliasNameKey(nfd));
  });
});
