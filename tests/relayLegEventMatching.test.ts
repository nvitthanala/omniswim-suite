/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A relay leg matches an individual swim by event, not by substring
 * (IMPROVEMENTS_2026-09-22 P15).
 *
 * The defect: `eventMatchesStrokeDistance` asked whether the event label
 * CONTAINED the leg distance. `"1000"` contains `"100"`, `"500"` and `"1650"`
 * contain `"50"`, and a HyTek entry number (`Event 500 Women 100 Yard
 * Butterfly Time Trial`) is part of the label too. On the scoring path that
 * did two things:
 *
 *  - `simulateRoster` measured a substitute against the departed swimmer's
 *    500 or 1000 Free instead of the leg, so the relay clock moved by minutes
 *    (HSU women's 200 Free Relay went to -199.47).
 *  - A distance swimmer with no 50 Free qualified for a 50 Free leg on her
 *    1650 time, and the relay-leg swap ranking offered her as a fill.
 *
 * The fixture is real: rows copied verbatim from the 2026 NSISC Championships
 * final results as parsed into `data/meets.json` (relay splits included). The
 * first block below ties every individual time the tests lean on to the
 * committed parser output, `tests/test_nsisc_output.json`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type RelayLegOverride,
  type ScoringSettings,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { findDepartedLegSwim, simulateRoster } from '../packages/core/src/lib/utils';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import {
  eventMatchesStrokeDistance,
  isRelayLegEvent,
  listEligibleRelayLegCandidates,
  relayLegEventName,
  swimmerMatchesRelayLeg,
} from '../packages/core/src/lib/relayLegMatching';
import { applyRelayLegSwap, rankRelayLegSwaps } from '../packages/core/src/lib/crossCourseArbitrage';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const DSU = 'Delta State University';

const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-leg-event-matching.json'), 'utf8')
) as { womenResults: SwimmerResult[]; menResults: SwimmerResult[] };
const { womenResults, menResults } = fixture;

type ParserRow = {
  name: string;
  team: string;
  event: string;
  finals_time: string | null;
  prelims_time: string | null;
  is_relay: boolean;
};
const parserOut = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'test_nsisc_output.json'), 'utf8')
) as ParserRow[];

const W_200FR = 'Event 30 Women 4x50 Yard Freestyle Relay';
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';
const M_400MR = 'Event 20 Men 4x100 Yard Medley Relay';

/** The leg rows of one relay entry, in leg order. */
function relayLegRows(results: SwimmerResult[], team: string, event: string, rank: number): SwimmerResult[] {
  return results
    .filter(r => r.isRelay && r.team === team && r.event === event && r.rank === rank)
    .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
}

function fillOverride(template: SwimmerResult, legIndex: number, assigneeName: string): RelayLegOverride {
  return { relayEntryKey: relayEntryKey(template), legIndex, assigneeName, source: 'manual' };
}

/** The relay rows `simulateRoster` emits for one entry, in leg order. */
function simulatedRelay(out: SwimmerResult[], team: string, event: string, rank: number): SwimmerResult[] {
  return relayLegRows(out, team, event, rank);
}

function individual(results: SwimmerResult[], name: string): SwimmerResult[] {
  return results.filter(r => !r.isRelay && r.name === name);
}

describe('the fixture is the real meet', () => {
  it('every individual time agrees with the committed parser output', () => {
    const parsed = (name: string, team: string) =>
      parserOut
        .filter(r => !r.is_relay && r.name === name && r.team === team)
        .map(r => [r.event, r.finals_time || r.prelims_time]);
    for (const [results, team] of [
      [womenResults, HSU],
      [menResults, HSU],
      [menResults, DSU],
    ] as const) {
      const names = new Set(results.filter(r => !r.isRelay && r.team === team).map(r => r.name));
      expect(names.size).toBeGreaterThan(0);
      for (const name of names) {
        const rows = results.filter(r => !r.isRelay && r.team === team && r.name === name);
        expect(rows.map(r => [r.event, r.time]), name).toStrictEqual(parsed(name, team));
      }
    }
  });

  it('holds the swims the defect reads as leg times', () => {
    const events = (name: string) => individual([...womenResults, ...menResults], name).map(r => [r.event, r.time]);
    // Ryann Grasser (HSU, SR): leads off the 200 Free Relay, never swam a 50 Free.
    expect(events('Ryann Grasser')).toContainEqual(['Event 21 Women 500 Yard Freestyle', '5:23.54']);
    expect(events('Ryann Grasser').some(([e]) => /\b50 Yard Freestyle\b/.test(e))).toBe(false);
    // Daniella Ruiz (HSU): a distance swimmer with no 50 Free.
    expect(events('Daniella Ruiz')).toContainEqual(['Event 32 Women 1650 Yard Freestyle', '18:00.63']);
    // Colton Bennett (HSU): anchors the 400 Free Relay B, never swam a 100 Free.
    expect(events('Colton Bennett')).toContainEqual(['Event 4 Men 1000 Yard Freestyle', '9:26.63']);
    // Austin Huffhines (Delta State): swam both, and the 1000 comes first.
    expect(events('Austin Huffhines')[0]).toStrictEqual(['Event 4 Men 1000 Yard Freestyle', '10:00.10']);
    expect(events('Austin Huffhines')).toContainEqual(['Event 35 Men 100 Yard Freestyle', '45.85']);
  });
});

describe('simulateRoster measures a fill against the departed leg, not a longer swim', () => {
  it('HSU women 200 Free Relay: Shelby Travis fills the senior leadoff leg', () => {
    const legs = relayLegRows(womenResults, HSU, W_200FR, 12);
    expect(legs.map(l => [l.name, l.classYear, l.relayLegSplit, l.relayTeamTime])).toStrictEqual([
      ['Ryann Grasser', 'SR', '25.17', '1:39.74'],
      ['Ryleigh Wells', 'FR', '25.01', '1:39.74'],
      ['Allie Grace Rhodes', 'FR', '25.45', '1:39.74'],
      ['Iris McNamara', 'FR', '24.11', '1:39.74'],
    ]);
    // "Drop seniors" removes Grasser. She has no 50 Free, so her own recorded
    // split is what leaves: 1:39.74 - 25.17 + 24.33 = 1:38.90.
    const out = simulateRoster(womenResults, [], true, new Set(), [fillOverride(legs[0], 0, 'Shelby Travis')]);
    const relay = simulatedRelay(out, HSU, W_200FR, 12);
    expect(relay.map(r => r.name)).toStrictEqual(['Shelby Travis', 'Ryleigh Wells', 'Allie Grace Rhodes', 'Iris McNamara']);
    expect(relay.map(r => r.relayTeamTime)).toStrictEqual(['1:38.90', '1:38.90', '1:38.90', '1:38.90']);
  });

  it('HSU men 400 Free Relay B: Reid Remmert fills Colton Bennett\'s anchor leg', () => {
    const legs = relayLegRows(menResults, HSU, M_400FR, 10);
    expect(legs[3].name).toBe('Colton Bennett');
    expect(legs[3].relayLegSplit).toBe('47.24');
    // No 100 Free for Bennett, so his 47.24 split leaves: 3:06.60 - 47.24 + 46.12.
    const out = simulateRoster(menResults, [], false, new Set(['colton bennett']), [
      fillOverride(legs[0], 3, 'Reid Remmert'),
    ]);
    const relay = simulatedRelay(out, HSU, M_400FR, 10);
    expect(relay[3].name).toBe('Reid Remmert');
    expect(relay[3].relayTeamTime).toBe('3:05.48');
  });

  it('Delta State 400 Free Relay A: the departed time is Huffhines\'s 100 Free, not his 1000 Free', () => {
    const legs = relayLegRows(menResults, DSU, M_400FR, 0);
    expect(legs[3].name).toBe('Austin Huffhines');
    // Flat-start 100 Free 45.85 leaves, 46.73 arrives: 3:00.20 + 0.88 = 3:01.08.
    const out = simulateRoster(menResults, [], false, new Set(['austin huffhines']), [
      fillOverride(legs[0], 3, 'Sergio Rodriguez Rodriguez'),
    ]);
    const relay = simulatedRelay(out, DSU, M_400FR, 0);
    expect(relay[3].name).toBe('Sergio Rodriguez Rodriguez');
    expect(relay[3].relayTeamTime).toBe('3:01.08');
  });

  it('HSU men 400 Medley Relay A: Cam Mask fills the senior breaststroke leg', () => {
    const legs = relayLegRows(menResults, HSU, M_400MR, 2);
    expect(legs.map(l => [l.name, l.classYear, l.relayLegSplit])).toStrictEqual([
      ['Avery Henke', 'JR', '49.58'],
      ['Oskar Cebula', 'SR', '54.11'],
      ['Colin Candebat', 'SO', '47.26'],
      ['Oliver Pozvai', 'SO', '44.29'],
    ]);
    // "Drop seniors" removes Cebula. His program 100 Breast (55.45) leaves and
    // Mask's 55.52 arrives: 3:15.24 + 0.07 = 3:15.31.
    const out = simulateRoster(menResults, [], true, new Set(), [fillOverride(legs[0], 1, 'Cam Mask')]);
    const relay = simulatedRelay(out, HSU, M_400MR, 2);
    expect(relay[1].name).toBe('Cam Mask');
    expect(relay[1].relayTeamTime).toBe('3:15.31');
  });
});

describe('a leg takes only a swimmer with a swim at its distance and stroke', () => {
  it('a 1650 swimmer named for a 50 Free leg leaves the leg vacant', () => {
    const legs = relayLegRows(womenResults, HSU, W_200FR, 12);
    const unfilled = simulatedRelay(simulateRoster(womenResults, [], true), HSU, W_200FR, 12);
    const named = simulatedRelay(
      simulateRoster(womenResults, [], true, new Set(), [fillOverride(legs[0], 0, 'Daniella Ruiz')]),
      HSU,
      W_200FR,
      12
    );
    expect(named[0].name).toBe('—');
    expect(named[0].relayLegVacant).toBe(true);
    // Naming her is the same as naming nobody.
    expect(named.map(r => [r.name, r.relayTeamTime, r.relayLegSplit])).toStrictEqual(
      unfilled.map(r => [r.name, r.relayTeamTime, r.relayLegSplit])
    );
  });

  it('the leg candidate list holds only 50 Free swimmers', () => {
    const active = womenResults.filter(r => !r.isRelay);
    const names = listEligibleRelayLegCandidates(active, W_200FR, 0, new Set(), HSU).map(r => `${r.name} ${r.event}`);
    expect(names).toStrictEqual([
      'Shelby Travis Event 7 Women 50 Yard Freestyle',
      'Ryleigh Wells Event 7 Women 50 Yard Freestyle',
      'Allie Grace Rhodes Event 7 Women 50 Yard Freestyle',
    ]);
    const colton = individual(menResults, 'Colton Bennett');
    expect(colton.some(r => swimmerMatchesRelayLeg(r, M_400FR, 3))).toBe(false);
  });
});

describe('the relay-leg swap ranking', () => {
  // Legs in an A/B final are not auto-eligible here, so the non-scorer's
  // vacated leg makes the relay ineligible until it is refilled.
  const settings: ScoringSettings = {
    ...NSISC_PRESET_SETTINGS,
    scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
  };
  const ws = {
    id: 'ws-nsisc-2026-p15',
    name: '2026 NSISC (P15 relay legs)',
    createdAt: 0,
    menResults,
    womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    conference: 'NSISC',
    scoringSettings: settings,
    scorerRosterOverrides: [{ name: 'Ryann Grasser', team: HSU, gender: Gender.WOMEN, isScorer: false }],
  } as unknown as Workspace;

  it('offers only a 50 Free swimmer and holds the clock at the departed split', () => {
    const ranking = rankRelayLegSwaps(ws, { team: HSU, gender: Gender.WOMEN, settings });
    expect(ranking.candidatesEvaluated).toBe(1);
    expect(ranking.swaps.map(s => [s.inAthlete, s.outAthlete, s.legIndex, s.clockLegTime])).toStrictEqual([
      ['Shelby Travis', 'Ryann Grasser', 0, '25.17'],
    ]);

    // The held clock is the clock: applying the swap leaves the relay at 1:39.74.
    const { patch } = applyRelayLegSwap(ws, ranking.swaps[0], { team: HSU, gender: Gender.WOMEN });
    const out = simulateRoster(
      womenResults,
      [],
      false,
      new Set(),
      patch.relayLegOverrides ?? [],
      new Set(['ryann grasser'])
    );
    const relay = simulatedRelay(out, HSU, W_200FR, 12);
    expect(relay[0].name).toBe('Shelby Travis');
    expect(relay.map(r => r.relayTeamTime)).toStrictEqual(['1:39.74', '1:39.74', '1:39.74', '1:39.74']);
  });

  /** Rank the swaps for one non-scorer leg holder, apply the top one, re-simulate. */
  function holdFor(results: SwimmerResult[], outName: string) {
    const w = {
      ...ws,
      womenResults: results,
      scorerRosterOverrides: [{ name: outName, team: HSU, gender: Gender.WOMEN, isScorer: false }],
    } as Workspace;
    const ranking = rankRelayLegSwaps(w, { team: HSU, gender: Gender.WOMEN, settings });
    const swap = ranking.swaps.find(s => s.inAthlete === 'Shelby Travis');
    if (!swap) throw new Error(`no Shelby Travis swap for ${outName}`);
    const { patch } = applyRelayLegSwap(w, swap, { team: HSU, gender: Gender.WOMEN });
    const out = simulateRoster(
      results,
      [],
      false,
      new Set(),
      patch.relayLegOverrides ?? [],
      new Set([outName.toLowerCase()])
    );
    return { swap, relay: simulatedRelay(out, HSU, W_200FR, 12) };
  }

  it('holds the clock at the departed swimmer\'s own 50 Free when she has one', () => {
    // Ryleigh Wells split 25.01 on the relay and swam the 50 Free in 25.55.
    // simulateRoster subtracts the 25.55, so the hold must carry 25.55 too.
    const { swap, relay } = holdFor(womenResults, 'Ryleigh Wells');
    expect([swap.outAthlete, swap.legIndex, swap.clockLegTime]).toStrictEqual(['Ryleigh Wells', 1, '25.55']);
    expect(relay[1].name).toBe('Shelby Travis');
    expect(relay.map(r => r.relayTeamTime)).toStrictEqual(['1:39.74', '1:39.74', '1:39.74', '1:39.74']);
  });

  it('holds the clock when the relay spells the leg holder "Last, First"', () => {
    // Variant of the real rows: the relay roster names Wells the way a HyTek
    // relay line can ("Wells, Ryleigh"); her individual rows keep "Ryleigh Wells".
    const respelled = womenResults.map(r =>
      r.isRelay
        ? {
            ...r,
            relayNames: r.relayNames?.map(n => (n.name === 'Ryleigh Wells' ? { ...n, name: 'Wells, Ryleigh' } : n)),
          }
        : r
    );
    const { swap, relay } = holdFor(respelled, 'Wells, Ryleigh');
    expect(swap.clockLegTime).toBe('25.55');
    expect(relay.map(r => r.relayTeamTime)).toStrictEqual(['1:39.74', '1:39.74', '1:39.74', '1:39.74']);
  });
});

describe('findDepartedLegSwim', () => {
  it('finds the leg event, not the first longer swim of the stroke', () => {
    // Huffhines's 1000 Free is his first row; his 100 Free is the leg event.
    const hit = findDepartedLegSwim(menResults, 'Austin Huffhines', M_400FR, 3, DSU);
    expect([hit?.event, hit?.time]).toStrictEqual(['Event 35 Men 100 Yard Freestyle', '45.85']);
  });

  it('is absent when the swimmer never swam the leg event', () => {
    expect(findDepartedLegSwim(menResults, 'Colton Bennett', M_400FR, 3, HSU)).toBeUndefined();
    expect(findDepartedLegSwim(womenResults, 'Ryann Grasser', W_200FR, 0, HSU)).toBeUndefined();
  });

  it('reads the stroke of a medley leg from its index', () => {
    // Oskar Cebula (HSU) swims the breaststroke leg (index 1) of the 400 Medley Relay.
    expect(findDepartedLegSwim(menResults, 'Oskar Cebula', M_400MR, 1, HSU)?.event).toBe(
      'Event 26 Men 100 Yard Breaststroke'
    );
    expect(findDepartedLegSwim(menResults, 'Oskar Cebula', M_400MR, 0, HSU)).toBeUndefined();
  });

  it('takes the first matching row: the program swim before the later time trial', () => {
    // Cebula swam the program 100 Breast (55.45) and a time trial (54.86R).
    // Rows are searched in results order, and the program event comes first.
    const rows = individual(menResults, 'Oskar Cebula').filter(r => isRelayLegEvent(r.event, 100, 'breast'));
    expect(rows.map(r => [r.event, r.time])).toStrictEqual([
      ['Event 26 Men 100 Yard Breaststroke', '55.45'],
      ['Event 100 Men 100 Yard Breaststroke Time Trial', '54.86R'],
    ]);
    expect(findDepartedLegSwim(menResults, 'Oskar Cebula', M_400MR, 1, HSU)?.time).toBe('55.45');
  });

  it('compares names the way simulateRoster does', () => {
    expect(findDepartedLegSwim(menResults, 'Huffhines, Austin', M_400FR, 3, DSU)?.time).toBe('45.85');
    expect(findDepartedLegSwim(menResults, '  austin  HUFFHINES ', M_400FR, 3, DSU)?.time).toBe('45.85');
  });
});

describe('event labels', () => {
  const FREE = ['freestyle', 'free'];
  const FLY = ['butterfly', 'fly'];

  it('names the leg event canonically', () => {
    expect(relayLegEventName(50, 'free')).toBe('50 Freestyle');
    expect(relayLegEventName(100, 'back')).toBe('100 Backstroke');
    expect(relayLegEventName(100, 'breast')).toBe('100 Breaststroke');
    expect(relayLegEventName(200, 'free')).toBe('200 Freestyle');
    expect(relayLegEventName(50, 'fly')).toBe('50 Butterfly');
  });

  it('isRelayLegEvent takes the stroke directly', () => {
    expect(isRelayLegEvent('Event 13 Men 100 Yard Butterfly', 100, 'fly')).toBe(true);
    expect(isRelayLegEvent('Event 13 Men 100 Yard Butterfly', 100, 'free')).toBe(false);
    expect(isRelayLegEvent('Event 13 Men 100 Yard Butterfly', 50, 'fly')).toBe(false);
    expect(isRelayLegEvent('Event 42 Men 4x100 Yard Freestyle Relay', 100, 'free')).toBe(false);
    expect(isRelayLegEvent('', 100, 'free')).toBe(false);
  });

  it('keywords that name no stroke match nothing', () => {
    expect(eventMatchesStrokeDistance('100 Freestyle', 100, [])).toBe(false);
    expect(eventMatchesStrokeDistance('100 Freestyle', 100, ['im'])).toBe(false);
    // Keywords naming two strokes accept either leg event.
    expect(eventMatchesStrokeDistance('100 Back', 100, ['free', 'back'])).toBe(true);
    expect(eventMatchesStrokeDistance('100 Free', 100, ['FREE'])).toBe(true);
  });

  it('a longer distance never stands in for the leg distance', () => {
    for (const label of [
      '1000 Freestyle',
      '1,000 Freestyle',
      'Event 4 Men 1000 Yard Freestyle',
      '1000 Free SCY',
    ]) {
      expect(eventMatchesStrokeDistance(label, 100, FREE), label).toBe(false);
    }
    for (const label of ['500 Free SCY', 'Event 21 Women 500 Yard Freestyle', '1650 Freestyle']) {
      expect(eventMatchesStrokeDistance(label, 50, FREE), label).toBe(false);
    }
  });

  it('a HyTek entry number is not a distance', () => {
    // Real label: Event 500 is a 100 Fly time trial, not a 50 Fly.
    expect(eventMatchesStrokeDistance('Event 500 Women 100 Yard Butterfly Time Trial', 50, FLY)).toBe(false);
    expect(eventMatchesStrokeDistance('Event 50 Women 200 Yard Freestyle', 50, FREE)).toBe(false);
  });

  it('every spelling of the leg event matches', () => {
    for (const label of [
      '100 Freestyle',
      '100 Free',
      '100 Free SCY',
      'Event 35 Men 100 Yard Freestyle',
      '100 Freestyle (relay split)',
      // A time trial is the same swim over the same distance and stroke.
      'Event 201 Men 100 Yard Freestyle Time Trial',
    ]) {
      expect(eventMatchesStrokeDistance(label, 100, FREE), label).toBe(true);
    }
  });

  it('medley legs match by stroke in leg order', () => {
    const row = (event: string) => ({ event, isRelay: false }) as SwimmerResult;
    const MR = 'Event 20 Men 4x100 Yard Medley Relay';
    expect(swimmerMatchesRelayLeg(row('Event 24 Men 100 Yard Backstroke'), MR, 0)).toBe(true);
    expect(swimmerMatchesRelayLeg(row('100 Breaststroke'), MR, 1)).toBe(true);
    expect(swimmerMatchesRelayLeg(row('100 Fly'), MR, 2)).toBe(true);
    expect(swimmerMatchesRelayLeg(row('100 Free SCY'), MR, 3)).toBe(true);
    expect(swimmerMatchesRelayLeg(row('100 Backstroke'), MR, 1)).toBe(false);
    expect(swimmerMatchesRelayLeg(row('Event 4 Men 1000 Yard Freestyle'), MR, 3)).toBe(false);
    expect(swimmerMatchesRelayLeg(row('Event 6 Men 200 Yard IM'), MR, 3)).toBe(false);
  });

  it('a relay row never fills a leg, whatever its label says', () => {
    const splitRow = { event: '100 Freestyle (relay split)', isRelay: true } as SwimmerResult;
    expect(swimmerMatchesRelayLeg(splitRow, M_400FR, 0)).toBe(false);
    expect(swimmerMatchesRelayLeg({ ...splitRow, isRelay: false }, M_400FR, 0)).toBe(true);
  });
});
