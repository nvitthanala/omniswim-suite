/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * E1 fingerprint for the engine extraction (plans/2026-10-25/D2-ENGINE-API.md, 2.5 E1).
 *
 * Each case calls a scoring, lineup, conversion or cut-tag function over committed
 * fixtures only (never `data/meets.json`), canonicalises the result, and compares its
 * sha256 with the hash in `tests/fixtures/engineExtractionFingerprint.json`. The hashes
 * were computed BEFORE any file moved out of `packages/core`. Every import below goes
 * through a `packages/core/src` path, so once files move this test runs through the shims.
 * It must stay green with the same hashes at every step. Do not edit the hashes.
 *
 * ## Canonical form
 * Keys sorted at every depth. The keys `id`, `createdAt`, `updatedAt`, `importedAt` and
 * `generated` are dropped (D2 E1). A non-finite number becomes a string token, so `Infinity`
 * (an NT time) never collapses into `null`. The canonicaliser THROWS on a `Map`, `Set`, `Date`,
 * function or class instance: `JSON.stringify` turns those into `{}`, and a case that hashed an
 * empty object would pass forever.
 *
 * ## Each case runs twice
 * Both runs get a fresh `structuredClone` of the input. The two hashes must be equal, which
 * catches a clock or random value leaking into an output.
 *
 * ## Probes that D2 E1 leaves open (synthetic inputs, not competition values)
 * - `scyConversionOutcome`: probe time `2:00.00` for every event, both genders.
 * - `ncaaAltitudeAdjustment`: probe time `10:00.00`; events are the `CONVERSION_FACTORS` keys plus
 *   relay, 25, 50 and diving labels the chart prints no row for; elevations are the three chart
 *   classes plus feet on both sides of each class edge.
 * - `calculatePoints` runs once per gender per fixture file, with no options.
 * - `test_nsisc_output.json` is raw parser output. It is mapped with the same function
 *   `tests/optimizerObjectiveMatchesEngine.test.ts` uses (deterministic ids).
 * - `buildCutlineTag` runs over `isSwimCutline` rows only (diving rows carry points, not a clock
 *   standard) and every tier `cutlineTierTimes` lists, at standard - 0.01, standard, standard + 0.01.
 *
 * ## Known gaps against D2 E1
 * - The theoretical-meet capture store (`tests/fixtures/theoretical-meet/`) holds captures, not a
 *   workspace. It is covered by `tests/engineExtractionFingerprintTheoretical.test.ts`, which reads a
 *   workspace fixture built by `legacy/scripts/gen_engine_fingerprint_workspace.ts`.
 * - `optimize-undo-workspace.json` has no women's rows, so its women's cases hash an empty field.
 * - `optimizeRosterForTeam` and `optimizeEventLineupForTeam` return `activeEntryIds`, uuids that
 *   repeat the plans' `id`. D2 E1 drops only keys named `id`, so those two cases fail the run-twice
 *   check as specified. Each case projects `activeEntryIds` to plan positions (see
 *   `activeIdsAsPlanPositions`). Confirmed by the orchestrator, 2026-10-25.
 *
 * ## Known non-discriminating cases (kept as built; do not read them as coverage)
 * - Every women's case on `optimize-undo-workspace.json` (bundle, snapshot, both optimizers): the
 *   workspace has no women's rows, so the hash covers an empty field.
 * - `buildScoringBundle` with `applyWhatIf=true` and `applyWhatIf=false` on that workspace hash
 *   the same: it has no what-if layer.
 * - `optimizeEventLineupForTeam` for Ouachita men and for both women's teams hash the same
 *   (an empty result).
 * - `calculatePoints` under `NSISC_PRESET_SETTINGS` and under `GENERIC_TOP16_SETTINGS` hash the same
 *   on every fixture: both settings share the place table, relay multiplier and half-rate flag, and
 *   `calculatePoints` is called with no options, so the NSISC conference lock never applies.
 * - `mergeScoringSettings` with conference undefined and `'NSISC'` hash the same for every preset
 *   except `generic-top16`.
 *
 * Set `ENGINE_FINGERPRINT_OUT=<file>` to write the computed hashes to that file instead of
 * comparing. The test never writes anywhere else.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONVERSION_FACTORS, NCAA_ALTITUDE_ADJUSTMENT_TABLE } from '../packages/core/src/constants';
import { cutlineTierTimes, isSwimCutline, publishedCutlines } from '../packages/core/src/cutlines';
import { Gender } from '../packages/core/src/types';
import type { NcaaDivision, SwimmerResult, Workspace } from '../packages/core/src/types';
import { ncaaAltitudeAdjustment } from '../packages/core/src/lib/altitude';
import { calculatePoints } from '../packages/core/src/lib/calculatePoints';
import { buildCutlineTag } from '../packages/core/src/lib/cutlineTags';
import { optimizeEventLineupForTeam, optimizeRosterForTeam } from '../packages/core/src/lib/rosterOptimizer';
import { scyConversionOutcome } from '../packages/core/src/lib/scyConversion';
import {
  BUILT_IN_SCORING_PRESETS,
  GENERIC_TOP16_SETTINGS,
  NSISC_PRESET_SETTINGS,
  mergeScoringSettings,
  settingsForBuiltInScoringPreset,
} from '../packages/core/src/lib/scoringDefaults';
import { buildScoringBundle, buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine';
import { convertTimeToSeconds } from '../packages/core/src/lib/utils';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const HASH_FILE = join(root, 'tests', 'fixtures', 'engineExtractionFingerprint.json');
const OUT_PATH = process.env.ENGINE_FINGERPRINT_OUT;

/* -------------------------------------------------------------------------- */
/* Canonical form and hash                                                    */
/* -------------------------------------------------------------------------- */

const DROPPED_KEYS: ReadonlySet<string> = new Set(['id', 'createdAt', 'updatedAt', 'importedAt', 'generated']);

function canonical(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : `<number:${String(value)}>`;
    case 'undefined':
      return null;
    case 'bigint':
      return `<bigint:${value.toString()}>`;
    case 'function':
    case 'symbol':
      throw new Error(`fingerprint: ${typeof value} at ${path}`);
    default:
      break;
  }
  if (Array.isArray(value)) return value.map((item, i) => canonical(item, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`fingerprint: non-plain object (${(value as object).constructor?.name ?? 'unknown'}) at ${path}`);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (DROPPED_KEYS.has(key)) continue;
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    out[key] = canonical(child, `${path}.${key}`);
  }
  return out;
}

function sha256Of(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value, '$'))).digest('hex');
}

/** A function result, or the error it threw: a refusal is part of the behaviour the move must keep. */
function outcome<T>(fn: () => T): { returned: T } | { threw: { name: string; message: string } } {
  try {
    return { returned: fn() };
  } catch (err) {
    const e = err as Error;
    return { threw: { name: e.name, message: e.message } };
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const readJson = (...parts: string[]): unknown => JSON.parse(readFileSync(join(root, ...parts), 'utf8'));
const clone = <T>(value: T): T => structuredClone(value);

const optimizeUndoWorkspace = readJson('tests', 'fixtures', 'optimize-undo-workspace.json') as Workspace;
const GENDERS = [Gender.MEN, Gender.WOMEN] as const;

type ParserRow = {
  rank: number;
  name: string;
  year: string;
  team: string;
  finals_time: string | null;
  prelims_time: string | null;
  round_swam: string;
  event: string;
  gender: string;
  is_relay: boolean;
  relay_team_time: string | null;
};

/** Same mapping as `tests/optimizerObjectiveMatchesEngine.test.ts` (`toSwimmerResult`). */
function parserRowToResult(r: ParserRow, idx: number): SwimmerResult {
  const time = r.round_swam === 'Preliminaries' ? r.prelims_time ?? '' : r.finals_time ?? r.prelims_time ?? '';
  return {
    id: `nsisc-2026-${idx}`,
    rank: r.rank,
    name: r.name,
    classYear: r.year,
    team: r.team,
    time,
    finalsTime: r.finals_time ?? undefined,
    prelimsTime: r.prelims_time ?? undefined,
    roundSwam: r.round_swam,
    event: r.event,
    gender: r.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
    isRelay: r.is_relay,
    ...(r.relay_team_time ? { relayTeamTime: r.relay_team_time } : {}),
    isExhibition: false,
    isTimeTrial: /time trial/i.test(r.event),
    points: 0,
  } as SwimmerResult;
}

type ResultFile = { label: string; men: SwimmerResult[]; women: SwimmerResult[] };

const NSISC_FIXTURE_FILES = [
  'nsisc-2026-dq-relay-leg.json',
  'nsisc-2026-relay-followups-r1.json',
  'nsisc-2026-relay-leg-event-matching.json',
] as const;

const resultFiles: ResultFile[] = NSISC_FIXTURE_FILES.map(name => {
  const parsed = readJson('tests', 'fixtures', name) as { menResults?: SwimmerResult[]; womenResults?: SwimmerResult[] };
  return { label: name, men: parsed.menResults ?? [], women: parsed.womenResults ?? [] };
});
{
  const rows = (readJson('tests', 'test_nsisc_output.json') as ParserRow[]).map(parserRowToResult);
  resultFiles.push({
    label: 'test_nsisc_output.json',
    men: rows.filter(r => r.gender === Gender.MEN),
    women: rows.filter(r => r.gender === Gender.WOMEN),
  });
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

type FingerprintCase = { id: string; run: () => unknown };
const cases: FingerprintCase[] = [];

// buildScoringBundle / buildScoringSnapshot on the committed workspace, both genders.
for (const gender of GENDERS) {
  for (const applyWhatIf of [true, false]) {
    cases.push({
      id: `buildScoringBundle|optimize-undo-workspace|${gender}|applyWhatIf=${applyWhatIf}`,
      run: () => {
        const workspace = clone(optimizeUndoWorkspace);
        return buildScoringBundle({
          workspace,
          gender,
          removeSeniors: false,
          applyWhatIf,
          scorerRosterOverrides: workspace.scorerRosterOverrides,
        });
      },
    });
  }
  cases.push({
    id: `buildScoringSnapshot|optimize-undo-workspace|${gender}`,
    run: () => buildScoringSnapshot(clone(optimizeUndoWorkspace), gender, false),
  });
}

// calculatePoints under both settings objects.
const SETTINGS_UNDER_TEST = [
  { label: 'NSISC_PRESET_SETTINGS', settings: NSISC_PRESET_SETTINGS },
  { label: 'GENERIC_TOP16_SETTINGS', settings: GENERIC_TOP16_SETTINGS },
] as const;
for (const file of resultFiles) {
  for (const gender of GENDERS) {
    const rows = gender === Gender.MEN ? file.men : file.women;
    for (const { label, settings } of SETTINGS_UNDER_TEST) {
      cases.push({
        id: `calculatePoints|${file.label}|${gender}|${label}`,
        run: () => calculatePoints(clone(rows), clone(settings)),
      });
    }
  }
}

/**
 * The optimizers mint a fresh uuid for each plan, and `activeEntryIds` repeats those uuids as plain
 * strings, so the key-based drop of `id` does not remove them and the run-twice check fails. Each
 * active id is replaced by the position of the plan that holds it (-1 if no plan does). That keeps
 * which plans are active and drops only the random value. This is a per-case projection, not a change
 * to the canonical form. See "Known gaps".
 */
function activeIdsAsPlanPositions(activeIds: readonly string[], plans: readonly { id: string }[]): number[] {
  return activeIds.map(activeId => plans.findIndex(plan => plan.id === activeId));
}

// The optimizers over the committed workspace, per gender and team.
const OPTIMIZE_TEAMS = ['Henderson State University', 'Ouachita Baptist University'] as const;
for (const gender of GENDERS) {
  for (const team of OPTIMIZE_TEAMS) {
    cases.push({
      id: `optimizeRosterForTeam|optimize-undo-workspace|${gender}|${team}`,
      run: () => {
        const workspace = clone(optimizeUndoWorkspace);
        const result = optimizeRosterForTeam(workspace, gender, team, false, clone(workspace.scoringSettings!));
        return { ...result, activeEntryIds: activeIdsAsPlanPositions(result.activeEntryIds, result.meetEntryPlans) };
      },
    });
    cases.push({
      id: `optimizeEventLineupForTeam|optimize-undo-workspace|${gender}|${team}`,
      run: () => {
        const workspace = clone(optimizeUndoWorkspace);
        const result = optimizeEventLineupForTeam(workspace, gender, team, clone(workspace.scoringSettings!));
        return { ...result, activeEntryIds: activeIdsAsPlanPositions(result.activeEntryIds, result.plans) };
      },
    });
  }
}

// mergeScoringSettings for each built-in preset, with and without the NSISC conference.
for (const preset of BUILT_IN_SCORING_PRESETS) {
  for (const conference of [undefined, 'NSISC'] as const) {
    cases.push({
      id: `mergeScoringSettings|${preset.id}|conference=${conference ?? 'undefined'}`,
      run: () =>
        outcome(() => mergeScoringSettings(settingsForBuiltInScoringPreset(preset.id), { conference })),
    });
  }
}

// buildCutlineTag for every published swim row and tier, three probes each. One case per table.
const swimRows = publishedCutlines().filter(isSwimCutline);
const cutlineGroups = new Map<string, typeof swimRows>();
for (const row of swimRows) {
  const key = `${row.division}|${row.season}|${row.gender}`;
  cutlineGroups.set(key, [...(cutlineGroups.get(key) ?? []), row]);
}
const cutlineProbeResults: { tagged: number; total: number } = { tagged: 0, total: 0 };
for (const [key, rows] of [...cutlineGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  cases.push({
    id: `buildCutlineTag|${key}`,
    run: () => {
      const out: unknown[] = [];
      for (const row of rows) {
        for (const tier of cutlineTierTimes(row)) {
          const standard = convertTimeToSeconds(tier.time);
          for (const delta of [-0.01, 0, 0.01]) {
            const result = outcome(() =>
              buildCutlineTag({
                timeSec: Math.round((standard + delta) * 100) / 100,
                gender: row.gender,
                event: row.event,
                division: row.division,
                season: row.season,
                tableCourse: row.course,
                swimCourse: row.course,
              })
            );
            cutlineProbeResults.total += 1;
            if ('returned' in result && result.returned.state === 'tagged') cutlineProbeResults.tagged += 1;
            out.push({ event: row.event, tier: tier.tier, standard: tier.time, delta, result });
          }
        }
      }
      return out;
    },
  });
}

// scyConversionOutcome for every CONVERSION_FACTORS event x course x division. One case per event.
const DIVISIONS: readonly (NcaaDivision | null)[] = ['D1', 'D2', 'D3', 'NAIA', null];
for (const event of Object.keys(CONVERSION_FACTORS)) {
  cases.push({
    id: `scyConversionOutcome|${event}`,
    run: () => {
      const out: unknown[] = [];
      for (const gender of GENDERS) {
        for (const course of ['SCY', 'SCM', 'LCM'] as const) {
          for (const division of DIVISIONS) {
            out.push({
              gender,
              course,
              division,
              result: outcome(() => scyConversionOutcome(event, '2:00.00', gender, course, { division })),
            });
          }
        }
      }
      return out;
    },
  });
}

// ncaaAltitudeAdjustment over the whole table grid. One case per course.
const ALTITUDE_EVENTS = [
  ...Object.keys(CONVERSION_FACTORS),
  '25 Freestyle',
  '200 Freestyle Relay',
  '400 Freestyle Relay',
  '800 Freestyle Relay',
  '200 Medley Relay',
  '400 Medley Relay',
  '1 Meter Diving',
];
const ALTITUDE_ELEVATIONS = [
  ...(Object.keys(NCAA_ALTITUDE_ADJUSTMENT_TABLE.elevationClasses) as ('I' | 'II' | 'III')[]).map(elevationClass => ({
    elevationClass,
  })),
  ...[2999, 3000, 4250, 4251, 6500, 6501, 9000].map(feet => ({ feet })),
];
const altitudeStatusCounts: Record<string, number> = {};
for (const course of ['SCY', 'SCM', 'LCM'] as const) {
  cases.push({
    id: `ncaaAltitudeAdjustment|${course}`,
    run: () => {
      const out: unknown[] = [];
      for (const event of ALTITUDE_EVENTS) {
        for (const elevation of ALTITUDE_ELEVATIONS) {
          const result = outcome(() => ncaaAltitudeAdjustment({ event, time: '10:00.00', course, elevation }));
          if ('returned' in result) {
            altitudeStatusCounts[result.returned.status] = (altitudeStatusCounts[result.returned.status] ?? 0) + 1;
          }
          out.push({ event, elevation, result });
        }
      }
      return out;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

const expected: Record<string, string> =
  OUT_PATH === undefined
    ? ((JSON.parse(readFileSync(HASH_FILE, 'utf8')) as { cases: Record<string, string> }).cases)
    : {};

describe('engine extraction fingerprint (D2 E1)', () => {
  it('has unique case ids', () => {
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  });

  if (OUT_PATH !== undefined) {
    it('writes the computed hashes', () => {
      const computed: Record<string, string> = {};
      for (const c of cases) {
        const first = sha256Of(c.run());
        const second = sha256Of(c.run());
        expect(second, c.id).toBe(first);
        computed[c.id] = first;
      }
      writeFileSync(OUT_PATH, `${JSON.stringify({ cases: computed }, null, 2)}\n`);
      expect(existsSync(OUT_PATH)).toBe(true);
    });
    return;
  }

  it('covers exactly the committed case ids', () => {
    expect(cases.map(c => c.id).sort()).toStrictEqual(Object.keys(expected).sort());
  });

  for (const c of cases) {
    it(c.id, () => {
      const first = sha256Of(c.run());
      const second = sha256Of(c.run());
      expect(second, 'two runs of one case differ: a clock or random value leaked').toBe(first);
      expect(first).toBe(expected[c.id]);
    });
  }

  it('is not vacuous', () => {
    // Self-contained: count from the return values of the cases themselves, never from state
    // another test filled, so this passes alone (`-t "is not vacuous"`).
    type Probe = { result: { returned?: { state?: string; status?: string } } };
    const runCases = (prefix: string): Probe[] =>
      cases.filter(c => c.id.startsWith(prefix)).flatMap(c => c.run() as Probe[]);
    const cutlineProbes = runCases('buildCutlineTag|');
    expect(cutlineProbes.length).toBeGreaterThan(0);
    expect(cutlineProbes.filter(p => p.result.returned?.state === 'tagged').length).toBeGreaterThan(0);
    const altitudeProbes = runCases('ncaaAltitudeAdjustment|');
    for (const status of ['adjusted', 'below_threshold', 'event_not_in_table']) {
      expect(altitudeProbes.filter(p => p.result.returned?.status === status).length, status).toBeGreaterThan(0);
    }
    for (const file of resultFiles) {
      const scored = calculatePoints(clone([...file.men, ...file.women]), clone(NSISC_PRESET_SETTINGS));
      expect(scored.some(r => Number(r.points) > 0), file.label).toBe(true);
    }
    const bundle = buildScoringBundle({
      workspace: clone(optimizeUndoWorkspace),
      gender: Gender.MEN,
      removeSeniors: false,
      applyWhatIf: true,
      scorerRosterOverrides: optimizeUndoWorkspace.scorerRosterOverrides,
    });
    expect(bundle.sortedTeams.length).toBeGreaterThan(0);
  });
});
