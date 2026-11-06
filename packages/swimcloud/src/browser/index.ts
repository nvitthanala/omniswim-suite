/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `@omniswim/swimcloud/browser`: the browser-safe entry (plan section 3.1, invariant 7).
 *
 * It imports only `@omniswim/engine`, files in this folder, and the ten shared pure parser files
 * listed as SHARED_PURE in `tests/swimcloudBrowserBoundary.test.ts` (the roster reader wraps the page
 * parsers, D7 section 1). It never imports `node:*`, `playwright-core`, or any other swimcloud file.
 * The test scans for all of these and fails if the shared files reached differ from the list. The
 * extension imports this entry and nothing else from the package.
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
export type { RosterClassCode, RosterFetchInput, RosterFetchOutcome, RosterFetchRefusalCode, RosterFetchTarget } from './rosterFetch';
export { findRosterPagination, readRosterFetch } from './rosterFetch';
export type { EnrichInput, EnrichMode, EnrichResult, RemovedEntry, RosterEvidence, TeamEnrichment, TeamRosterStatus } from './enrich';
export { enrichRosterMembership } from './enrich';
