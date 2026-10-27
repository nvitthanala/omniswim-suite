/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The simulator adapter (`packages/swimcloud/src/browser`): what it maps, what it refuses, and what it
 * reports as unknown. The parity test (`swimcloudSimulatorParity.test.ts`) shows the whole pipeline
 * reproduces SwimCloud. This file pins the pieces, so a failure there points at one of them.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRulePreset, requireComplete, scoreMeet } from '@omniswim/engine';
import type { RulePreset } from '@omniswim/engine';
import {
  adaptSimulatorSnapshot,
  AdapterError,
  parseSwimCloudHundredths,
  rescoreSimulator,
  SIMULATOR_POINT_TABLES,
  SIMULATOR_RULE_PROVENANCE,
  SIMULATOR_SOURCING,
  SIMULATOR_TABLE_PROVENANCE,
  simulatorCap,
  simulatorPointTable,
  simulatorRulePreset,
} from '@omniswim/swimcloud/browser';
import type { SimulatorSnapshotInput } from '@omniswim/swimcloud/browser';
import { buildSnapshot, type ConfigName } from './helpers/simulatorFixtures';

const OPTS = { meetKey: 'adapter-test', snapshotId: 'fixture' };

/** A mutable deep copy of a built snapshot. The tests edit one field and read the result. */
const clone = (name: ConfigName): any => structuredClone(buildSnapshot(name).snapshot);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AdapterError) return error.code;
    throw error;
  }
  return 'did not throw';
}

describe('structural input', () => {
  it('the extension SimSnapshot is assignable to the adapter input (no copy, no cast)', () => {
    const { snapshot } = buildSnapshot('A');
    const input: SimulatorSnapshotInput = snapshot;
    expect(adaptSimulatorSnapshot(input, OPTS).kind).toBe('ready');
  });

  it('a snapshot with no rosters yet is not_loaded and names what is missing', () => {
    const snap = clone('A');
    snap.swimmers = null;
    snap.splashes = null;
    const outcome = adaptSimulatorSnapshot(snap, OPTS);
    expect(outcome.kind).toBe('not_loaded');
    if (outcome.kind === 'not_loaded') expect(outcome.missing).toEqual(['swimmers', 'splashes']);
    expect(rescoreSimulator(snap, OPTS).kind).toBe('not_loaded');
  });
});

describe('parseSwimCloudHundredths', () => {
  it('reads the page values, floating-point noise included', () => {
    expect(parseSwimCloudHundredths('118.85', 't')).toBe(11885);
    expect(parseSwimCloudHundredths(181.02999999999997, 't')).toBe(18103);
    expect(parseSwimCloudHundredths(87.8, 't')).toBe(8780);
    expect(parseSwimCloudHundredths('22.53', 't')).toBe(2253);
  });

  it('refuses a third decimal instead of rounding it into a time nobody swam', () => {
    expect(code(() => parseSwimCloudHundredths('22.534', 't'))).toBe('invalid_time');
    expect(code(() => parseSwimCloudHundredths(22.535, 't'))).toBe('invalid_time');
  });

  it('refuses zero, negatives, blanks, non-numbers and text', () => {
    for (const bad of [0, -1, '', ' ', 'NT', '1:02.33', NaN, Infinity, '-5.00']) {
      expect(code(() => parseSwimCloudHundredths(bad, 't')), String(bad)).toBe('invalid_time');
    }
  });
});

describe('diving: the highest score across course codes', () => {
  it('keeps one swim per diver and event, with the higher score of the two rows', () => {
    const snap = clone('A');
    const rows = (snap.swims as { kind: string; eventstroke: string; swimmerId: string; eventdistance: number; eventtime: string | number; eventcourse: string }[]).filter(
      (s) => s.eventstroke === 'H'
    );
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const k = `${r.swimmerId}|${r.eventdistance}`;
      groups.set(k, [...(groups.get(k) ?? []), Math.round(Number(r.eventtime) * 100)]);
    }
    const pairs = [...groups.entries()].filter(([, v]) => v.length > 1);
    // Non-vacuous: the fixture has divers with two rows, and the rows differ.
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.some(([, v]) => new Set(v).size > 1)).toBe(true);

    const outcome = adaptSimulatorSnapshot(snap, OPTS);
    if (outcome.kind !== 'ready') throw new Error('not ready');
    const dives = outcome.adapted.model.swims.filter((s) => /Diving/.test(s.eventKey));
    expect(dives).toHaveLength(groups.size);
    for (const [k, v] of groups) {
      const [swimmerId, board] = k.split('|');
      const key = board === '1' ? '1-Meter Diving' : board === '3' ? '3-Meter Diving' : 'Platform Diving';
      const swim = dives.find((d) => d.swimmerId === swimmerId && d.eventKey === key);
      expect(swim?.recordedTime?.hundredths, k).toBe(Math.max(...v));
    }
  });

  it('refuses a dive course code that is neither "6" nor ""', () => {
    const snap = clone('A');
    const row = snap.swims.find((s: { eventstroke: string }) => s.eventstroke === 'H');
    row.eventcourse = 'Y';
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('unsupported_course');
  });
});

describe('simulatorCap and the preset caps', () => {
  it('maps SwimCloud 0 to unlimited, never to a cap of 0', () => {
    expect(simulatorCap(0, 'k')).toBe('unlimited');
    expect(simulatorCap(1, 'k')).toBe(1);
    expect(simulatorCap(998, 'k')).toBe(998);
  });

  it('refuses a value that is not 0 or a whole number from 1 to 998', () => {
    for (const bad of [-1, 1.5, 999, 1000, NaN]) {
      expect(code(() => simulatorCap(bad, 'k')), String(bad)).toBe('invalid_setting');
    }
  });

  const settings = (maxScorersPerTeam: number) => ({
    pointSystem: 'college',
    maxScorersPerTeam,
    maxIndrecordsPerAthlete: 3,
    maxIndrecordsPerTeam: 3,
    maxRelaysPerAthlete: 2,
    maxRelaysPerTeam: 2,
    maxTotalPerAthlete: 0,
  });

  it('maxScorersPerTeam sets both the per-event scorer cap (holds place) and the relay cap', () => {
    const p = simulatorRulePreset(settings(3)).preset;
    expect(p.scorers.perEventScorerCap).toMatchObject({ state: 'set', value: { cap: 3, overCap: 'holds-place' } });
    expect(p.scorers.scoringRelaysPerTeamPerEvent).toMatchObject({ state: 'set', value: 3 });
    const none = simulatorRulePreset(settings(0)).preset;
    expect(none.scorers.perEventScorerCap).toMatchObject({ state: 'set', value: { cap: 'unlimited' } });
    expect(none.scorers.scoringRelaysPerTeamPerEvent).toMatchObject({ state: 'set', value: 'unlimited' });
  });

  it('per-athlete limits map to the entry caps, with 0 as unlimited', () => {
    const p = simulatorRulePreset(settings(3)).preset;
    expect(p.entries.maxIndividualPerSwimmer).toMatchObject({ value: 3 });
    expect(p.entries.maxRelayPerSwimmer).toMatchObject({ value: 2 });
    expect(p.entries.maxTotalPerSwimmer).toMatchObject({ value: 'unlimited' });
  });

  it('reports the per-team entry limits as unmapped, with their values', () => {
    const build = simulatorRulePreset({ ...settings(3), maxIndrecordsPerTeam: 4, maxRelaysPerTeam: 1 });
    expect(build.unmapped.map((u) => [u.key, u.value])).toEqual([
      ['maxIndrecordsPerTeam', 4],
      ['maxRelaysPerTeam', 1],
    ]);
  });
});

describe('an unknown point system is pending, never another table', () => {
  it('scoring32 (named by a SwimCloud preset, defined nowhere in the bundle) leaves the points pending', () => {
    const build = simulatorRulePreset({
      pointSystem: 'scoring32',
      maxScorersPerTeam: 0,
      maxIndrecordsPerAthlete: 0,
      maxIndrecordsPerTeam: 0,
      maxRelaysPerAthlete: 0,
      maxRelaysPerTeam: 0,
      maxTotalPerAthlete: 0,
    });
    expect(build.pointTableKnown).toBe(false);
    expect(build.complete).toBe(false);
    expect(build.pending).toEqual(expect.arrayContaining(['scoring.individualPoints', 'scoring.relayPoints']));
    expect(() => requireComplete(build.preset)).toThrow();
  });

  it('rescoreSimulator returns preset_incomplete and scores nothing', () => {
    const snap = clone('A');
    snap.settings.pointSystem = 'scoring32';
    const outcome = rescoreSimulator(snap, OPTS);
    expect(outcome.kind).toBe('preset_incomplete');
    if (outcome.kind === 'preset_incomplete') expect(outcome.pending).toContain('scoring.individualPoints');
    expect('results' in outcome).toBe(false);
  });

  it('a prototype key is not a point system', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(simulatorPointTable(key), key).toBeUndefined();
  });
});

describe('the point tables', () => {
  // `_p` from the archived bundle, verbatim (data/swimcloud-captures/simulator/bundle-constants-excerpt.txt).
  const BUNDLE_P =
    '_p={[lp]:{title:"College",IND_EVENTS:[9,4,3,2,1],REL_EVENTS:[11,4,2]},[up]:{title:"High School - 4 lane scoring",IND_EVENTS:[4,3,1],REL_EVENTS:[6,3,1]},[cp]:{title:"High School - 6 lane scoring",IND_EVENTS:[6,4,3,2,1],REL_EVENTS:[8,4,2]},[dp]:{title:"High School - 8 lane scoring",IND_EVENTS:[8,6,5,4,3,2,1],REL_EVENTS:[10,5,3]},[pp]:{title:"Sectional and State Final",IND_EVENTS:[16,13,12,11,10,9,7,5,4,3,2,1],REL_EVENTS:[32,26,24,22,20,18,14,10,8,6,4,2]},[fp]:{title:"16 Place Scoring",IND_EVENTS:[20,17,16,15,14,13,12,11,9,7,6,5,4,3,2,1],REL_EVENTS:[40,34,32,30,28,26,24,22,18,14,12,10,8,6,4,2]},[hp]:{title:"24 Place Scoring",IND_EVENTS:[32,28,27,26,25,24,23,22,20,17,16,15,14,13,12,11,9,7,6,5,4,3,2,1],REL_EVENTS:[64,56,54,52,50,48,46,44,40,34,32,30,28,26,24,22,18,14,12,10,8,6,4,2]}}';
  const KEY_OF: Record<string, string> = { lp: 'college', up: 'school4', cp: 'school6', dp: 'school8', pp: 'scoring12', fp: 'scoring16', hp: 'scoring24' };

  /** Parse the verbatim text with no shared code: one regex per entry. */
  const parsed = [...BUNDLE_P.matchAll(/\[(\w+)\]:\{title:"([^"]+)",IND_EVENTS:\[([\d,]+)\],REL_EVENTS:\[([\d,]+)\]\}/g)].map((m) => ({
    key: KEY_OF[m[1] as string] as string,
    title: m[2] as string,
    individual: (m[3] as string).split(',').map(Number),
    relay: (m[4] as string).split(',').map(Number),
  }));

  it('every table equals the verbatim bundle text, and no table is missing or extra', () => {
    expect(parsed).toHaveLength(7);
    expect(Object.keys(SIMULATOR_POINT_TABLES).sort()).toEqual(parsed.map((p) => p.key).sort());
    for (const p of parsed) {
      const t = simulatorPointTable(p.key);
      expect(t, p.key).toBeDefined();
      expect([...(t?.individual ?? [])], p.key).toEqual(p.individual);
      expect([...(t?.relay ?? [])], p.key).toEqual(p.relay);
      expect(t?.title, p.key).toBe(p.title);
    }
  });

  it('the points SwimCloud recorded in configs A to D are drawn from the table for that config, or 0 for an over-cap entry', () => {
    for (const name of ['A', 'B', 'C', 'D'] as const) {
      const { config, snapshot } = buildSnapshot(name);
      const table = simulatorPointTable(snapshot.settings.pointSystem);
      if (!table) throw new Error(`config ${name}: no table`);
      const seen = { individual: new Set<number>(), relay: new Set<number>() };
      for (const [key, entries] of Object.entries(config.results)) {
        const relay = key.startsWith('6|') || key.startsWith('7|');
        for (const e of entries) {
          const points = e[3];
          if (typeof points === 'number') seen[relay ? 'relay' : 'individual'].add(points);
        }
      }
      expect([...seen.individual].every((p) => p === 0 || table.individual.includes(p)), `${name} individual`).toBe(true);
      expect([...seen.relay].every((p) => p === 0 || table.relay.includes(p)), `${name} relay`).toBe(true);
      // Non-vacuous: the config reaches the top of both tables.
      expect(seen.individual.has(table.individual[0] as number), `${name} top individual`).toBe(true);
      expect(seen.relay.has(table.relay[0] as number), `${name} top relay`).toBe(true);
    }
  });

  const ARCHIVE = path.join(__dirname, '..', 'data', 'swimcloud-captures', 'simulator');
  const sha = (file: string) => createHash('sha256').update(readFileSync(path.join(ARCHIVE, file))).digest('hex');
  // The archive is gitignored, so CI has none. A developer machine that has it must find the recorded hashes.
  it.skipIf(!existsSync(path.join(ARCHIVE, 'bundle-constants-excerpt.txt')))('the provenance hashes name the archived files (local archive only)', () => {
    expect(SIMULATOR_TABLE_PROVENANCE).toMatchObject({ kind: 'tool-derived', archive: { sha256: sha('bundle-constants-excerpt.txt') } });
    expect(SIMULATOR_RULE_PROVENANCE).toMatchObject({ kind: 'tool-derived', archive: { sha256: sha('simulator.1792676876.js') } });
  });
});

describe('the SwimCloud preset', () => {
  it('survives a JSON round trip through parseRulePreset, provenance included', () => {
    for (const name of ['A', 'D'] as const) {
      const outcome = adaptSimulatorSnapshot(clone(name), OPTS);
      if (outcome.kind !== 'ready') throw new Error('not ready');
      const json: unknown = JSON.parse(JSON.stringify(outcome.adapted.preset.preset));
      expect(parseRulePreset(json)).toEqual(outcome.adapted.preset.preset);
    }
  });

  // Intent changed from "tool-derived throughout" (2026-10-26, lead decision item 5): a neutral value the
  // simulator never reads must not claim the tool states it. What the tool states stays tool-derived.
  it('provenance: engine-neutral on exactly the inert settings, tool-derived on the rest, never published or user', () => {
    const outcome = adaptSimulatorSnapshot(clone('A'), OPTS);
    if (outcome.kind !== 'ready') throw new Error('not ready');
    const { preset, inert } = outcome.adapted.preset;
    const kindAt = new Map<string, string>();
    for (const section of ['scoring', 'scorers', 'entries'] as const) {
      for (const [key, s] of Object.entries(preset[section] as Record<string, { state: string; provenance?: { kind: string } }>)) {
        if (s.state === 'set' && s.provenance) kindAt.set(`${section}.${key}`, s.provenance.kind);
      }
    }
    const neutral = [...kindAt].filter(([, k]) => k === 'engine-neutral').map(([p]) => p).sort();
    expect(neutral).toEqual([...inert].sort());
    expect(inert.length).toBe(9);
    for (const [path, kind] of kindAt) {
      if (!inert.includes(path)) expect(kind, path).toBe('tool-derived');
    }
    expect(kindAt.get('scoring.ties')).toBe('tool-derived');
    expect(kindAt.get('scoring.individualPoints')).toBe('tool-derived');
  });

  it("the SwimCloud preset ties 'ordered': set, tool-derived, with the archive hash", () => {
    const outcome = adaptSimulatorSnapshot(clone('A'), OPTS);
    if (outcome.kind !== 'ready') throw new Error('not ready');
    expect(outcome.adapted.preset.preset.scoring.ties).toMatchObject({
      state: 'set',
      value: 'ordered',
      provenance: { kind: 'tool-derived', archive: { sha256: SIMULATOR_RULE_PROVENANCE.kind === 'tool-derived' ? SIMULATOR_RULE_PROVENANCE.archive.sha256 : '' } },
    });
    expect(outcome.adapted.preset.preset.payloadVersion).toBe(2);
  });

  it('inert settings: changing each one does not move any total', () => {
    for (const name of ['A', 'D'] as const) {
      const outcome = adaptSimulatorSnapshot(clone(name), OPTS);
      if (outcome.kind !== 'ready') throw new Error('not ready');
      const { adapted } = outcome;
      const base = scoreMeet(adapted.model, adapted.lineup, [], requireComplete(adapted.preset.preset), SIMULATOR_SOURCING);
      const p = adapted.preset.preset;
      const prov = SIMULATOR_RULE_PROVENANCE;
      const set = <T>(value: T) => ({ state: 'set' as const, value, provenance: prov });
      const variants: Record<string, RulePreset> = {
        'scorers.autoRules': {
          ...p,
          scorers: {
            ...p.scorers,
            autoRules: set({ abFinalTiers: ['A' as const], includeRelayLegsInFinals: false, distanceFinalRequired: false, distanceEventPattern: [], splitTimedFinalMarksScorer: false }),
          },
        },
        'scoring.halfRateRelaySwimmer': { ...p, scoring: { ...p.scoring, halfRateRelaySwimmer: set(false) } },
        'scoring.aFinalBracketSize': { ...p, scoring: { ...p.scoring, aFinalBracketSize: set(16) } },
        'scoring.nonScorerPlacement': { ...p, scoring: { ...p.scoring, nonScorerPlacement: set('removed-from-consideration' as const) } },
        'scoring.abFinalsScorersOnly': { ...p, scoring: { ...p.scoring, abFinalsScorersOnly: set(true) } },
        'scoring.cFinal': { ...p, scoring: { ...p.scoring, cFinal: set({ kind: 'non-scorers' as const, size: 8 }) } },
        'scorers.diverWeight': { ...p, scorers: { ...p.scorers, diverWeight: set({ numerator: 1, denominator: 2 }) } },
        'entries.timeTrialsCount': { ...p, entries: { ...p.entries, timeTrialsCount: set(true) } },
        'entries.relayLegsAllowTimeTrials': { ...p, entries: { ...p.entries, relayLegsAllowTimeTrials: set(true) } },
      };
      expect(Object.keys(variants).sort()).toEqual([...adapted.preset.inert].sort());
      for (const [key, variant] of Object.entries(variants)) {
        const got = scoreMeet(adapted.model, adapted.lineup, [], requireComplete(variant), SIMULATOR_SOURCING);
        expect(got.teams.map((t) => [t.teamId, t.points]), `${name} ${key}`).toEqual(base.teams.map((t) => [t.teamId, t.points]));
      }
    }
  });
});

describe('what the adapter refuses', () => {
  it('an exhibition entry: the page scores it in a way no engine rule matches', () => {
    const snap = clone('A');
    const splash = snap.splashes.find((s: { relay_id?: unknown; swimmerId: unknown }) => s.swimmerId !== null && s.relay_id === undefined);
    splash.exhibition = true;
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('unsupported_exhibition');
  });

  it('a non-yards simulator (SCM)', () => {
    const snap = clone('A');
    snap.settings.eventCourse = 'S';
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('unsupported_course');
  });

  it('an entry with no time, instead of reading it as the best swim', () => {
    const snap = clone('A');
    const splash = snap.splashes.find((s: { relay_id?: unknown; swimmerId: unknown }) => s.swimmerId !== null && s.relay_id === undefined);
    splash.eventtime = null;
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('invalid_splash');
  });

  it('an entry time that matches no swim (a coach edit), instead of inventing a swim', () => {
    const snap = clone('A');
    const splash = snap.splashes.find((s: { relay_id?: unknown; swimmerId: unknown; eventstroke: string }) => s.swimmerId !== null && s.relay_id === undefined && s.eventstroke !== 'H');
    splash.eventtime = '1.23';
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('time_not_in_swims');
  });

  it('a relay whose four legs do not sum to the relay time', () => {
    const snap = clone('A');
    const relay = snap.splashes.find((s: { swimmerId: unknown; relay_id?: unknown; eventstroke: string }) => s.swimmerId === null && s.relay_id === undefined && s.eventstroke === '7');
    relay.eventtime = relay.eventtime + 0.01;
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('relay_time_mismatch');
  });

  it('a relay with a leg that does not say flat or flying start', () => {
    const snap = clone('A');
    const leg = snap.splashes.find((s: { relay_id?: unknown }) => s.relay_id !== undefined);
    delete leg.flystart;
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('invalid_relay');
  });

  it('a team with no swimmers: an unknown swimmer on a splash', () => {
    const snap = clone('A');
    const splash = snap.splashes.find((s: { relay_id?: unknown; swimmerId: unknown }) => s.swimmerId !== null && s.relay_id === undefined);
    splash.swimmerId = 'nobody';
    expect(code(() => adaptSimulatorSnapshot(snap, OPTS))).toBe('unresolved_reference');
  });

  it('a swimmer who states no gender, or the wrong gender', () => {
    const none = clone('A');
    none.swimmers[0].gender = null;
    expect(code(() => adaptSimulatorSnapshot(none, OPTS))).toBe('swimmer_gender');
    const wrong = clone('A');
    wrong.swimmers[0].gender = 'F';
    expect(code(() => adaptSimulatorSnapshot(wrong, OPTS))).toBe('swimmer_gender');
  });

  it('a swim from a mixed event ("X") counts for its swimmer: the 2025-26 live check', () => {
    // The user's live load of the 2025-26 season threw `unsupported_gender` on `swims[55].eventgender: "X"`.
    // The swimmer's own gender is checked on the swimmer row, so the swim's time is theirs.
    const snap = clone('A');
    const individual = snap.swims.filter((s: { kind: string }) => s.kind !== 'relay');
    expect(individual.length).toBeGreaterThan(0);
    for (const s of individual) s.eventgender = 'X';
    const outcome = rescoreSimulator(snap, OPTS);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') throw new Error('expected a scored outcome');
    expect(outcome.parity).toMatchObject({ kind: 'compared', matches: true });
  });

  it('a swim row of the other gender, or an unknown gender code, still throws', () => {
    const other = clone('A');
    other.swims.find((s: { kind: string }) => s.kind !== 'relay').eventgender = 'F';
    expect(code(() => adaptSimulatorSnapshot(other, OPTS))).toBe('swimmer_gender');
    const unknown = clone('A');
    unknown.swims.find((s: { kind: string }) => s.kind !== 'relay').eventgender = 'Q';
    expect(code(() => adaptSimulatorSnapshot(unknown, OPTS))).toBe('unsupported_gender');
  });
});

describe('parityReport: an entry the page left unset', () => {
  it('engine points on an entry with no recorded points are a mismatch, with observed still null', () => {
    const snap = clone('A');
    const splash = snap.splashes.find((s: { relay_id?: unknown; swimmerId: unknown; points?: number }) => s.swimmerId !== null && s.relay_id === undefined && (s.points ?? 0) > 0);
    delete splash.points;
    const outcome = rescoreSimulator(snap, OPTS);
    if (outcome.kind !== 'scored' || outcome.parity.kind !== 'compared') throw new Error('not scored');
    const rows = outcome.parity.events.flatMap((e) => e.rows);
    const row = rows.find((r) => r.swimmerId === String(splash.swimmerId) && r.status === 'mismatch');
    expect(row).toMatchObject({ observed: null, status: 'mismatch' });
    expect(row?.engine).toBeGreaterThan(0);
    expect(outcome.parity.matches).toBe(false);
    expect(outcome.parity.differingEvents.length).toBe(1);
  });

  it('an unset entry the engine also scores 0 stays not_stated, and does not make the report differ', () => {
    const outcome = rescoreSimulator(clone('A'), OPTS);
    if (outcome.kind !== 'scored' || outcome.parity.kind !== 'compared') throw new Error('not scored');
    const unset = outcome.parity.events.flatMap((e) => e.rows).filter((r) => r.status === 'not_stated');
    expect(unset.length).toBeGreaterThan(0);
    expect(unset.every((r) => r.observed === null && r.engine === 0)).toBe(true);
    expect(outcome.parity.matches).toBe(true);
  });
});

describe('what the adapter says it does not know', () => {
  it('every team is an unmapped division, not D1 and not D2', () => {
    const outcome = adaptSimulatorSnapshot(clone('A'), OPTS);
    if (outcome.kind !== 'ready') throw new Error('not ready');
    expect(outcome.adapted.model.teams.length).toBeGreaterThan(0);
    for (const t of outcome.adapted.model.teams) {
      expect(t.division).toEqual({ state: 'unknown', reason: 'unmapped_team' });
    }
  });

  it('every swimmer has an unknown class year, and the model passes validation', () => {
    const outcome = adaptSimulatorSnapshot(clone('B'), OPTS);
    if (outcome.kind !== 'ready') throw new Error('not ready');
    for (const s of outcome.adapted.model.swimmers) expect(s.classYear).toBeNull();
    expect(outcome.adapted.ignored.relayRows).toBeGreaterThan(0);
  });

  it('a snapshot with no totals scores and reports parity as not_observed', () => {
    const snap = clone('A');
    snap.totalScores = null;
    const outcome = rescoreSimulator(snap, OPTS);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind === 'scored') {
      expect(outcome.parity).toEqual({ kind: 'not_observed' });
      expect(outcome.results.teams.length).toBeGreaterThan(0);
    }
  });
});
