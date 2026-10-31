/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The storage layer's public surface (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5).
 * Extension pages and the service worker import from here. A content-script entry must not
 * (D3 decision 0.2; tests/extensionBundleBoundaries.test.ts T-B6).
 */
export * from './schema';
export * from './errors';
export { MIGRATIONS, assertMigrationChain } from './migrations';
export type { Migration } from './migrations';
export { openOmniDb } from './open';
export type { OpenOmniDbOptions } from './open';
export { createStorageRepo } from './repo';
export type { GetResult, PutManyOp, PutManyOptions, StorageRepo, StorageRepoOptions } from './repo';
export * from './changeBus';
export { createUndoStack } from './undo';
export type { UndoChange, UndoEntry, UndoOutcome, UndoStack } from './undo';
export { assertValidRecord, validateRecord, validateLineup, validateSessionPreset, assertJsonSafe } from './validate';
export { BUNDLED_SOURCE_MANIFESTS, publishedSourceProblem } from './sourceManifests';
export { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, EXPORT_STORE_ORDER, exportData, importData } from './exportImport';
export type { ExportOptions, ImportOptions, ImportReport, OmniSwimExportV1, OnConflict, SkipReason } from './exportImport';
export * from './presets';
export { isDraftMeet, requireScorableMeet } from './meetGuard';
export type { MeetRefusal, MeetRefusalReason, ScorableMeet, ScorableMeetResult } from './meetGuard';
export { classifyRoster, readRosterState, verifiedEmptyRoster } from './rosterState';
export type { RosterKey, RosterState } from './rosterState';
export { readClassYear, resolveClassYear } from './classYear';
export type { ClassYearInput, ClassYearQuery, ResolvedClassYear } from './classYear';
export { readScorerOwnTeam, saveScorerOwnTeam } from './scorerOwnTeam';
export { readScorerRulePreset, saveScorerRulePreset } from './scorerRulePreset';
export { readSessionPresetChoice, saveSessionPresetChoice, readSessionPreset, readSessionLoadPreference, saveSessionLoadPreference, saveEditedSessionPreset } from './sessionPlanner';
export { defaultLoadPreference, pendingPenaltyPreference, parseLoadPreference, userPreference } from './sessionPreference';
