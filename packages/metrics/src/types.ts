// All race-analysis types come from the @omniswim/core engine. This package
// re-exports them so components have one local import path; it defines no
// metric shapes of its own.
export type {
  CycleDefinition,
  ImProposal,
  LengthMetrics,
  Measured,
  OperatorKey,
  Problem,
  ProblemCode,
  ProblemSeverity,
  Provenance,
  RaceAnalysisResult,
  RaceConfig,
  RaceCourse,
  RaceTag,
  RaceTagKind,
  RaceTagStateMachine,
  Stroke,
  StrokeCycleMetric,
  TagPressAccepted,
  TagPressRejected,
  TagPressResult,
  TagPreview,
  TurnMetrics,
  Unit,
} from '@omniswim/core/lib/raceAnalysis';
