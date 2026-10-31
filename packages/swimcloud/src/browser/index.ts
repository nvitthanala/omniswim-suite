/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `@omniswim/swimcloud/browser`: the browser-safe entry (plan section 3.1, invariant 7).
 *
 * It imports only `@omniswim/engine` and files in this folder. It never imports `node:*`,
 * `playwright-core`, or a swimcloud file outside `browser/` (`tests/swimcloudBrowserBoundary.test.ts`
 * scans for all three). The extension imports this entry and nothing else from the package.
 *
 * P2: the simulator adapter, the SwimCloud rule preset, and the parity report.
 */
export type { AdaptedSimulator, AdaptOptions, AdaptOutcome, ObservedEntry } from './adapt';
export { adaptSimulatorSnapshot } from './adapt';
export type { EntryParity, EntryParityStatus, EventParity, ParityReport, TeamParity } from './parity';
export { parityReport } from './parity';
export type { SimulatorPointTable } from './pointTables';
export { SIMULATOR_POINT_TABLES, simulatorPointTable } from './pointTables';
export type { RescoreOutcome } from './rescore';
export { rescoreSimulator, SIMULATOR_SOURCING } from './rescore';
export type { SimulatorPresetBuild, UnmappedSimulatorSetting } from './simulatorRules';
export { SIMULATOR_RULE_PROVENANCE, SIMULATOR_TABLE_PROVENANCE, simulatorCap, simulatorRulePreset } from './simulatorRules';
export type { SimulatorRuleRefusal, SimulatorRuleReverseMapping, SimulatorRuleSettings } from './simulatorReverseRules';
export { simulatorSettingsFromRulePreset } from './simulatorReverseRules';
export type {
  AdapterErrorCode,
  SimulatorSettingsInput,
  SimulatorSnapshotInput,
  SimulatorSplashInput,
  SimulatorSwimInput,
  SimulatorSwimmerInput,
  SimulatorTeamInput,
} from './simulatorTypes';
export { AdapterError } from './simulatorTypes';
export { parseSwimCloudHundredths } from './times';
export type { BestRelaySplit, HistorySource, TeamHistoryOptions, TimesByEventOptions } from './history';
export { bestRelaySplitsAcrossTeams, parseTeamRelayHistory, parseTimesByEventResponse, teamsFromTimesByEvent } from './history';
