/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Barrel. The code lives in the sibling modules named below. This file keeps every
// name it exported before the split, so no importer changes.

export { DEFAULT_SCORING_SETTINGS, mergeScoringSettings } from './scoringDefaults';

export {
  colorForChartStroke,
  normalizeTeamNameForColorLookup,
  parseTeamColorEntry,
  resolveTeamColorKey,
  scoreTeamColorKeyMatch,
} from './teamColorLookup';

// Re-exported beside the converters that raise it. `courseEvents.ts` is the home.
export {
  COURSE_DISTANCE_PAIRS,
  eventNotSwumInCourse,
  EventNotSwumInCourseError,
  findSwimsNotSwumInCourse,
  recordedCourseOfSwim,
  swimEventNotSwumInCourse,
  type CourseDistancePair,
  type CourseDistancePairId,
  type CourseDistanceSourceDocument,
  type CourseWithSourcedEvents,
  type EventNotSwumInCourse,
  type RecordedSwim,
  type SwimNotSwumInCourse,
} from './courseEvents';

export {
  convertTimeToSeconds,
  formatSecondsToTime,
  calculateProjectedTime,
} from './timeFormat';

export {
  normalizeSwimmerName,
  canonicalSwimmerName,
  isGraduatingClassYear,
  foldDiacritics,
  looksLikeInstitutionTeamName,
  getYearsRemaining,
} from './swimmerNames';

export {
  eventMeetSortKey,
  sortEventsByMeetOrder,
  stripEventGenderMarker,
  compactEventTitleAttr,
  formatCompactEventLabel,
  formatEventChartAxisLabel,
} from './eventLabels';

export {
  rgbColorDistance,
  synthesizeSecondaryColor,
  getTeamColors,
  getTeamColor,
  assignTeamLineStyles,
} from './teamColorStyles';

export {
  resolveConversionFactorKey,
  hasConversionFactor,
  type NcaaScmConversionCoverage,
  type NcaaScmConversionEvent,
  ncaaScmConversionEvent,
  hasConversionFactorForCourse,
  type ScyConversionOptions,
  type ScmConversionTableReason,
  type ScmConversionTableChoice,
  scmConversionTableFor,
  ncaaScmConversionRow,
  ncaaScmConvertedSeconds,
  type ScyConversionBasis,
  type ScyConversion,
  convertToSCY,
  convertSwimToSCY,
  convertSwimToSCYDetailed,
  type ScyConversionOutcome,
  scyConversionOutcome,
  scyConversionProvenance,
} from './scyConversion';

export {
  classifyRoundTier,
  isTimeTrialSwim,
  parseEventNumber,
  isOutsideScoredProgram,
  isFinalsRound,
  type EventScoringStage,
  eventScoringStage,
  isPrelimsFinalsEvent,
  swimResultClock,
  isScoringSwimTime,
  isScoringSwimResult,
  parseRankInt,
  isRelayResult,
  individualPlaceTable,
  placePointAt,
  tiedPlaceShare,
  pointsForPlacementOrNull,
  pointsForPlacement,
  relayTeamPointsForIndex,
  isDivingEvent,
} from './scoringRules';

export {
  isTimedFinalDistanceHeat,
  type OverCapPlaceBehavior,
} from './individualScoring';

export {
  relayTeamClock,
  relayEntryLegSignature,
  relayEntryGroupKey,
} from './relayScoring';

export {
  type CalculatePointsOptions,
  prepareRecruitsForScoring,
  chooseMeetEventLabels,
  type MeetPlace,
  type MeetPlaceField,
  buildMeetPlaceField,
  calculatePoints,
} from './calculatePoints';

export {
  findDepartedLegSwim,
  simulateRoster,
  relaySplitQualificationCutEvent,
} from './relaySimulation';

export {
  buildCatalogEntryResult,
  type CatalogEventOrder,
  type CategorizedScoringInputArgs,
  buildCategorizedScoringInputs,
} from './catalogScoringInputs';


