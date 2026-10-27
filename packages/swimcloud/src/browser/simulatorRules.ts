/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A `RulePreset` built from SwimCloud's own simulator settings, so the parity check compares like
 * with like (plans/2026-10-25/01-REDESIGN-PLAN.md, section 3.3).
 *
 * What the page does (recon Q13, `gf` in the archived bundle):
 * - Entries sort by time (dives by score, descending). The place index is the entry's index in the
 *   full sorted list, over-cap entries included.
 * - `maxScorersPerTeam` caps a team's scoring entries per event, swimming and relays alike. An entry
 *   over the cap earns 0 and keeps its place: `overCap: 'holds-place'`, and for a relay
 *   `scorers.relayOverCap: 'holds-place'` (README R67: the entry-limits tab allows more relays and marks them
 *   all scoring). A cap of `0` means no cap.
 * - There is no meet-wide scoring team, no scorer roster and no finals structure.
 * - Every `--` entry limit is stored as `0`, and `0` means unlimited. `0` is mapped to `'unlimited'`
 *   here and never reaches `parseCap`, where `0` is a real cap.
 * - Ties are not split. Places come from position in a stable sort, so equal times keep their input
 *   order (recon, "P2: how the simulator ranks ties"): `scoring.ties: 'ordered'`, and the tiebreak is the
 *   lineup's entry order.
 *
 * ## Values with no SwimCloud counterpart
 * `requireComplete` needs every applicable setting `set`. A few settings have no meaning on the
 * simulator (a half-rate relay credit, an A-final bracket, a diver weight, the time-trial flags, the
 * roster auto rules). They are set to a neutral value and listed in `inert`. The scorer never reads
 * them for a SwimCloud lineup: `tests/swimcloudSimulatorAdapter.test.ts` changes each one and shows the
 * totals do not move. They carry `engine-neutral` provenance, which claims nothing about SwimCloud.
 *
 * `maxIndrecordsPerTeam` and `maxRelaysPerTeam` limit how many entries a team may enter per event.
 * `RulePreset` has no per-team entry limit, so they are reported in `unmapped`, never dropped.
 *
 * An unknown `pointSystem` leaves the points `pending`. Nothing falls back to another table.
 */
import type { Cap, Provenance, RulePreset, Setting } from '@omniswim/engine';
import { pendingPaths } from '@omniswim/engine';
import { simulatorPointTable } from './pointTables';
import { AdapterError } from './simulatorTypes';
import type { SimulatorSettingsInput } from './simulatorTypes';

const TOOL = { name: 'SwimCloud meet simulator', url: 'https://www.swimcloud.com/meetsimulator/' } as const;

/** The point tables: the constants excerpt of the archived bundle. */
export const SIMULATOR_TABLE_PROVENANCE: Provenance = {
  kind: 'tool-derived',
  tool: TOOL,
  archive: {
    path: 'data/swimcloud-captures/simulator/bundle-constants-excerpt.txt',
    sha256: '090d398e6e98c106d6779290e817403847e71c22d9ef169bf1247642bbbc2a7c',
  },
  capturedOn: '2026-10-26',
  basis: 'inferred-from-tool-outputs',
};

/** The scoring rule (`gf`) and the settings the page holds: the archived bundle. */
export const SIMULATOR_RULE_PROVENANCE: Provenance = {
  kind: 'tool-derived',
  tool: TOOL,
  archive: {
    path: 'data/swimcloud-captures/simulator/simulator.1792676876.js',
    sha256: '93f6be650c703f41b3ac5f01d1614cfcfe2160b2bf0b3220e140f1987b69c6da',
  },
  capturedOn: '2026-10-26',
  basis: 'inferred-from-tool-outputs',
};

const BLOCKS = ['requireComplete', 'scoreMeet'] as const;

/** A neutral value the simulator never reads. No source states it, and no tool does. */
const NEUTRAL: Provenance = {
  kind: 'engine-neutral',
  reason: 'The SwimCloud simulator has no such setting. The value only lets the preset be complete, and the scorer does not read it for a simulator lineup.',
};

const set = <T>(value: T, provenance: Provenance): Setting<T> => ({ state: 'set', value, provenance });

export interface UnmappedSimulatorSetting {
  readonly key: 'maxIndrecordsPerTeam' | 'maxRelaysPerTeam';
  readonly value: number;
  readonly reason: string;
}

export interface SimulatorPresetBuild {
  readonly preset: RulePreset;
  /** The page's `pointSystem`, verbatim. */
  readonly pointSystem: string;
  /** Whether `pointSystem` has a table in this adapter. */
  readonly pointTableKnown: boolean;
  /** `pendingPaths(preset)`: empty when the preset can score. */
  readonly pending: readonly string[];
  readonly complete: boolean;
  /** Page settings the preset cannot hold. */
  readonly unmapped: readonly UnmappedSimulatorSetting[];
  /** Preset paths with no SwimCloud meaning. Set to a neutral value; the SwimCloud scorer does not read them. */
  readonly inert: readonly string[];
}

/** SwimCloud's `0` is "no limit"; any other value is a whole number of 1 to 998. */
export function simulatorCap(raw: number, key: string): Cap {
  if (!Number.isInteger(raw) || raw < 0 || raw >= 999) {
    throw new AdapterError('invalid_setting', `settings.${key}`, `${String(raw)} is not 0 (unlimited) or a whole number from 1 to 998`);
  }
  return raw === 0 ? 'unlimited' : raw;
}

const INERT: readonly string[] = [
  'scorers.autoRules',
  'scoring.halfRateRelaySwimmer',
  'scoring.aFinalBracketSize',
  'scoring.nonScorerPlacement',
  'scoring.abFinalsScorersOnly',
  'scoring.cFinal',
  'scorers.diverWeight',
  'entries.timeTrialsCount',
  'entries.relayLegsAllowTimeTrials',
];

export function simulatorRulePreset(
  settings: Pick<
    SimulatorSettingsInput,
    'pointSystem' | 'maxScorersPerTeam' | 'maxIndrecordsPerAthlete' | 'maxIndrecordsPerTeam' | 'maxRelaysPerAthlete' | 'maxRelaysPerTeam' | 'maxTotalPerAthlete'
  >
): SimulatorPresetBuild {
  const rule = SIMULATOR_RULE_PROVENANCE;
  const table = simulatorPointTable(settings.pointSystem);
  const scorerCap = simulatorCap(settings.maxScorersPerTeam, 'maxScorersPerTeam');
  const perAthleteInd = simulatorCap(settings.maxIndrecordsPerAthlete, 'maxIndrecordsPerAthlete');
  const perAthleteRelay = simulatorCap(settings.maxRelaysPerAthlete, 'maxRelaysPerAthlete');
  const perAthleteTotal = simulatorCap(settings.maxTotalPerAthlete, 'maxTotalPerAthlete');
  // Validated, not used: the per-team entry limits have no preset field.
  simulatorCap(settings.maxIndrecordsPerTeam, 'maxIndrecordsPerTeam');
  simulatorCap(settings.maxRelaysPerTeam, 'maxRelaysPerTeam');

  const noTable = (): Setting<never> => ({
    state: 'pending',
    question: `SwimCloud point system "${settings.pointSystem}" has no table in this adapter. Add it from the archived bundle, with a test.`,
    blocks: BLOCKS,
  });

  const preset: RulePreset = {
    payloadVersion: 3,
    scoring: {
      individualPoints: table ? set([...table.individual], SIMULATOR_TABLE_PROVENANCE) : noTable(),
      relayPoints: table ? set({ kind: 'table' as const, points: [...table.relay] }, SIMULATOR_TABLE_PROVENANCE) : noTable(),
      divingPoints: set({ kind: 'same-as-individual' as const }, rule),
      halfRateRelaySwimmer: set(true, NEUTRAL),
      aFinalBracketSize: set(8, NEUTRAL),
      nonScorerPlacement: set('holds-place' as const, NEUTRAL),
      abFinalsScorersOnly: set(false, NEUTRAL),
      cFinal: set({ kind: 'none' as const }, NEUTRAL),
      // The archived bundle's `gf` gives consecutive places, and its event ranking `Ra` sorts with lodash
      // `orderBy` (module 2877, offset 381954), which breaks a full tie by input index: a stable sort. The
      // later bundle `index.1793017582.js` has the same `Ra`. Recon doc, "P2: how the simulator ranks ties".
      ties: set('ordered' as const, rule),
    },
    scorers: {
      eligibility: set('points_pool' as const, rule),
      autoRules: set(null, NEUTRAL),
      scoringTeamSize: set('unlimited' as const, rule),
      scoringTeamScope: set('event' as const, rule),
      diverWeight: set({ numerator: 1, denominator: 1 }, NEUTRAL),
      perEventScorerCap: set(scorerCap === 'unlimited' ? { cap: 'unlimited' as const } : { cap: scorerCap, overCap: 'holds-place' as const }, rule),
      divingPerEventScorerCap: set({ kind: 'same-as-swimming' as const }, rule),
      scoringRelaysPerTeamPerEvent: set(scorerCap, rule),
      // `gf` zeroes a relay over `maxScorersPerTeam` and keeps it in its place, as it does for any entry.
      // The scorer reads this setting, so it is not in `INERT`.
      relayOverCap: set('holds-place' as const, rule),
      relayEligibleFromScorerPool: set(false, rule),
      relayLegsMustBeScorers: {
        state: 'pending',
        question: 'Not applicable: the simulator has no scorer roster, and this setting applies under "roster" eligibility only.',
        blocks: BLOCKS,
      },
    },
    entries: {
      maxIndividualPerSwimmer: set(perAthleteInd, rule),
      maxRelayPerSwimmer: set(perAthleteRelay, rule),
      maxTotalPerSwimmer: set(perAthleteTotal, rule),
      timeTrialsCount: set(false, NEUTRAL),
      exhibitionCounts: set(true, rule),
      relayLegsAllowTimeTrials: set(false, NEUTRAL),
    },
  };

  const reason = 'RulePreset has no per-team entry limit (D2 3.4). It limits which entries the page picks, not how a lineup scores.';
  const pending = pendingPaths(preset);
  return {
    preset,
    pointSystem: settings.pointSystem,
    pointTableKnown: table !== undefined,
    pending,
    complete: pending.length === 0,
    unmapped: [
      { key: 'maxIndrecordsPerTeam', value: settings.maxIndrecordsPerTeam, reason },
      { key: 'maxRelaysPerTeam', value: settings.maxRelaysPerTeam, reason },
    ],
    inert: INERT,
  };
}
