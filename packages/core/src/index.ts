export * from './types';
export * from './constants';
export * from './preferences/types';
export { SuitePreferencesProvider, useSuitePreferences, applySuitePreferences } from './preferences/SuitePreferencesProvider';

/* --- Published qualifying-standard tables (see CLAUDE.md § Data provenance) --- */
export {
  cutlines,
  allCutlines,
  publishedCutlines,
  cutlineDataFiles,
  cutlineSeasons,
  cutlineSources,
  divisionsWithCutlineData,
  publishedSeasonsForDivision,
  latestSeasonForDivision,
  hasCutlineTable,
  findCutlines,
  getDivingCutlines,
  cutlineTierTimes,
  isIndividualCutline,
  isRelayCutline,
  isDivingCutline,
  isSwimCutline,
  type CutlineRecord,
  type CutlineEntry,
  type CutlineQuery,
  type CutlineTier,
  type CutlineTierTime,
  type CutlineSeason,
  type CutlineCourse,
  type CutlineGender,
  type CutlineSourceRef,
  type CutlineSourceSummary,
  type CutlineDataFile,
  type DivingBoard,
  type DivingCutline,
  type SwimCutline,
  type IndividualCutline,
  type IndividualSingleCutline,
  type IndividualABCutline,
  type IndividualABInvitedCutline,
  type RelayCutline,
  type RelayQualifyingProvisionalCutline,
  type RelayProvisionalOnlyCutline,
  type RelayProvisionalInvitedCutline,
} from './cutlines';

/* --- Cutline lookups. `status` distinguishes a real miss from an absent table. --- */
export {
  DEFAULT_CUTLINE_COURSE,
  normalizeEventForCutline,
  getCutlinesForSwim,
  compareTimeToCutline,
  isACut,
  isBCut,
  courseOfRecordFromEventLabel,
  conversionFactorEventKey,
  nextStrictestTierNotAchieved,
  scyEquivalentForCutline,
  type CutlineLookupStatus,
  type CutlineLookup,
  type CutlineTierValue,
  type CutlineComparison,
  type CourseOfRecordFromLabel,
  type ScyEquivalentSwim,
  type SwimCourseOfRecord,
} from './lib/cutlineUtils';

/* --- Derived cut tags. Never hand-set; always built from the tables above. --- */
export * from './lib/cutlineTags';

/* --- Team → division resolution. `null` means unknown, never D1. --- */
export {
  divisionForTeam,
  divisionForTeamOrNull,
  divisionForTeamOrDefault,
  resolveTeamDivision,
  resolveMeetDivisions,
  registerTeamsFromList,
  knownTeamDivisions,
  divisionForTeamInSeason,
  programCompetedInSeason,
  programSponsorsGender,
  teamSeasonStartYear,
  BOTH_GENDERS,
  LEGACY_UNKNOWN_TEAM_DIVISION,
  type SponsoredGender,
  type TeamDivisionEntry,
  type TeamDivisionMatch,
  type TeamDivisionOptions,
  type TeamDivisionResolution,
  type TeamDivisionPeriod,
  type TeamDivisionProvenance,
  type TeamProgramStatus,
  type TeamSeasonLabel,
  type MeetDivisionStatus,
  type MeetDivisionResolution,
} from './data/teamDivisions';

export * from './lib/swimCloudMultiProfile';
export * from './lib/scoringTheory';
export * from './lib/crossCourseArbitrage';
export * from './lib/swimEditor';
export * from './lib/athleteAliases';
export { buildMeetEventLabelIndex, computeVisibleEvents } from './lib/eventIdentity';
export * from './lib/raceAnalysis';
