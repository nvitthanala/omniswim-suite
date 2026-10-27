/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `@omniswim/engine` root: the P1 surface of plans/2026-10-25/D2-ENGINE-API.md.
 *
 * Not here, on purpose:
 * - The legacy bridge. `@omniswim/engine/rules/legacyBridge` carries the legacy `ScoringSettings`
 *   type, and the root stays free of it (D2 decision 0.4).
 * - The rest of the sourcing functions (3.10: flyover, SourcingSettings) and the planner functions
 *   (3.11). They arrive in P4 and P5. Cut tags (3.9), the conversion (3.10, 3.13), `validateMeetModel`
 *   (3.6) and `scoreMeet` (3.8, P2) are here.
 * The moved modules stay reachable by their own subpaths (`@omniswim/engine/lib/*`).
 */

// 3.1 Primitives
export type { Course, EventKey, Gender, Hundredths, IsoDate, IsoTime, NcaaDivision, SwimmerId, TeamId, TimeValue } from './model/primitives';
export { formatHundredths, parseTimeText } from './model/primitives';

// 3.2 Provenance
export type { Provenance, Setting, SourceRef } from './model/provenance';
export { parseProvenance, parseSetting } from './model/provenance';

// 3.3 Cap
export type { Cap, RulePresetErrorCode } from './rules/cap';
export { capAllows, parseCap, RulePresetError } from './rules/cap';

// 3.4 RulePreset
export type {
  CFinalRule,
  CompleteRulePreset,
  DiverWeight,
  DivingPerEventScorerCap,
  DivingPointRule,
  EngineScorerAutoRules,
  PerEventScorerCap,
  PlaceTreatment,
  RelayOverCapRule,
  RelayPointRule,
  RulePreset,
  RulePresetV1,
  RulePresetV2,
  ScorerAutoRules,
  TieRule,
} from './rules/rulePreset';
export {
  editSetting,
  migrateRulePresetV1,
  migrateRulePresetV2,
  parseRulePreset,
  parseRulePresetV1,
  parseRulePresetV2,
  pendingPaths,
  requireComplete,
} from './rules/rulePreset';

// 3.6 MeetModel (types in P1, `validateMeetModel` in P2)
export type {
  ConversionBasis,
  DateWindow,
  DivisionRef,
  MeetDisplay,
  MeetEvent,
  MeetModel,
  MeetSwim,
  MeetSwimmer,
  MeetTeam,
  RelaySplit,
  RosterMembership,
  ScyStatement,
  SwimFlags,
  SwimOrigin,
} from './model/meet';

export type { MeetModelErrorCode } from './model/validate';
export { MeetModelError, validateMeetModel } from './model/validate';

// 3.7 Lineup
export type {
  IndividualEntry,
  LegBasis,
  Lineup,
  LineupDisplay,
  LineupEntry,
  RelayEntry,
  RelayLeg,
  ScorerRole,
  ScorerTag,
} from './model/lineup';
export { entryKey, stripSwimCloudData } from './model/lineup';

// 3.8 Results and scoring (P2)
export type { NotScoredReason, ResultRow, Results, ScoreMeetErrorCode, Violation } from './model/results';
export { ScoreMeetError, scoreMeet, stripResultsDisplay } from './model/results';

// 3.14 Suggested opponent rosters (P3.core-c). The solver is injected: the engine takes no `highs` dependency.
export type { LpSolution, LpSolve, RosterSuggestErrorCode, RosterSuggestRequest, RosterSuggestion } from './model/rosterSuggest';
export { RosterSuggestError, suggestScoringRosters } from './model/rosterSuggest';

// 3.10 Table D types. Retired from use (R58): no function reads them.
export type { TableDPreset, TableDRow } from './sourcing/tableD';

// 3.10 and 3.13 Conversion (the rest of 3.10, the flyover and SourcingSettings, arrives in P4)
export type { ConversionSettings, ConvertedScy } from './sourcing/convert';
export { scyEventKeyFor, scyStatementFor, scyStatementForSplit } from './sourcing/convert';
export type {
  LcmToScyAbsentReason,
  LcmToScyAppliedTo,
  LcmToScyBasis,
  LcmToScyPreset,
  LcmToScyResult,
  LcmToScyRow,
} from './sourcing/lcmToScy';
export { convertLcmToScy, LCM_SCY_DIVISOR_SCALE } from './sourcing/lcmToScy';

// 3.9 Cut tags
export type { CloseThreshold, CutGap, CutTag, CutTier, CutUnknownReason } from './sourcing/cutTag';
export { closeThresholdFromPercent, cutTagForSwim, cutTagFromLegacy, foldEventCutTags } from './sourcing/cutTag';

// 3.11 Planner (types only in P1)
export type { EventFormat, LoadPreference, ScheduledEvent, SessionPreset, SessionRef, SessionSlot } from './planner/types';

// 3.12 Built-ins
export type { Builtin, RuleBuiltin } from './rules/builtins';
export { BUILTIN_RULE_PRESETS, builtinRulePreset } from './rules/builtins';
export { BUILTIN_SESSION_PRESETS } from './planner/builtins';
export { BUILTIN_LCM_TO_SCY, BUILTIN_TABLE_D, builtinLcmToScy } from './sourcing/builtins';
