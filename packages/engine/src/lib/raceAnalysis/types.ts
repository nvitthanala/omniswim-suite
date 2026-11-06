export type Provenance = 'tagged' | 'entered' | 'derived' | 'official';

export type Unit = 'm' | 'yd' | 's' | 'm/s' | 'yd/s' | 'cycles/min' | 'kicks/min' | 'count';

export type Measured<T> =
  | { status: 'value'; value: T; provenance: Provenance; approximate: boolean; unit: Unit }
  | { status: 'absent'; reason: string };

export type RaceCourse = 'SCY' | 'SCM' | 'LCM';

export type Stroke = 'fly' | 'back' | 'breast' | 'free';

export type CycleDefinition = 'same-hand' | 'single-pull';

export type RaceTagKind =
  // OURS, not Swimcloud: starting horn or strobe.
  | 'Signal'
  | 'Start'
  | 'Entry'
  | 'Breakout'
  | 'Stroke'
  | 'TurnStart'
  | 'TurnEnd'
  | 'Finish'
  | 'FifteenMetre'
  // OURS, not Swimcloud: head crossing the backstroke flags on the final length.
  | 'Flags'
  // OURS, not Swimcloud: underwater dolphin kick.
  | 'Kick';

export type OperatorKey = 'S' | 'D' | 'A';

export interface RaceTag {
  kind: RaceTagKind;
  time: number;
  lengthIndex?: number;
}

export interface RaceConfig {
  course: RaceCourse;
  raceDistance: number;
  strokePerLength: readonly Stroke[];
  /**
   * Display and provenance metadata only; maths deliberately never reads this.
   * Under both conventions one Stroke tag equals one cycle: free/back tag a
   * same-hand entry, while fly/breast tag one simultaneous-arm pull. No divisor
   * belongs in the calculations.
   */
  cycleDefinition: CycleDefinition;
  /** Course units: yards for SCY, metres for SCM/LCM. */
  breakoutDistanceByLength?: readonly number[] | Readonly<Record<number, number>>;
  /** Course units: yards for SCY, metres for SCM/LCM. */
  flagDistance?: number;
  fifteenMetreReferenceConfirmed: boolean;
  isRelayLeg: boolean;
}

export type ProblemSeverity = 'error' | 'warning' | 'info';

export type ProblemCode =
  | 'MISSING_START'
  | 'MISSING_FINISH'
  | 'MISSING_BREAKOUT'
  | 'UNPAIRED_TURN'
  | 'TURN_ON_LAST_LENGTH'
  | 'FINISH_BEFORE_LAST_LENGTH'
  | 'STROKE_BEFORE_BREAKOUT'
  | 'INSUFFICIENT_STROKE_TAGS'
  | 'NON_MONOTONIC_TAGS'
  | 'BREAKOUT_EXCEEDS_15M'
  | 'LENGTH_COUNT_MISMATCH'
  | 'FIFTEEN_METRE_UNAVAILABLE'
  | 'IM_LENGTHS_NOT_DIVISIBLE'
  | 'SPLIT_DIVERGENCE'
  | 'LENGTHS_UNRESOLVED'
  | 'FLAGS_NOT_ON_FINAL_LENGTH'
  | 'FLAGS_AFTER_FINISH'
  | 'KICK_OUTSIDE_UNDERWATER';

export interface Problem {
  code: ProblemCode;
  severity: ProblemSeverity;
  message: string;
  lengthIndex?: number;
}

export interface TagPreview {
  status: 'available' | 'illegal';
  key: OperatorKey;
  kind?: RaceTagKind;
  lengthIndex?: number;
  reason?: string;
}

export interface TagPressAccepted {
  status: 'tagged';
  tag: RaceTag;
}

export interface TagPressRejected {
  status: 'illegal';
  reason: string;
}

export type TagPressResult = TagPressAccepted | TagPressRejected;

export interface RaceTagStateMachine {
  nextS(): TagPreview;
  nextD(): TagPreview;
  nextA(): TagPreview;
  canPress(key: OperatorKey): boolean;
  press(key: OperatorKey, time: number): TagPressResult;
  undo(): TagPressResult;
  tags(): readonly RaceTag[];
}

export interface StrokeCycleMetric {
  cycleIndex: number;
  cycleTime: Measured<number>;
  instantaneousStrokeRate: Measured<number>;
}

export interface LengthMetrics {
  lengthIndex: number;
  stroke: Stroke;
  breakoutTime: Measured<number>;
  /** Time actually used as the underwater-velocity denominator. */
  underwaterTime: Measured<number>;
  underwaterVelocity: Measured<number>;
  kickCount: Measured<number>;
  kickTempo: Measured<number>;
  /**
   * Starts at Start on length 1. On later lengths it starts at TurnEnd, after
   * the swimmer has left the wall, so it is approximate rather than a true
   * zero-to-15-m interval.
   */
  fifteenMetreTime: Measured<number>;
  /** See fifteenMetreTime: its later-length origin makes this velocity approximate. */
  zeroToFifteenMetreVelocity: Measured<number>;
  /** N Stroke tags. Stroke rate correctly averages the N - 1 gaps between them. */
  cycleCount: Measured<number>;
  strokeRate: Measured<number>;
  strokeCycles: readonly StrokeCycleMetric[];
  distancePerCycle: Measured<number>;
  split: Measured<number>;
  meanVelocity: Measured<number>;
}

export interface TurnMetrics {
  turnIndex: number;
  lengthIndex: number;
  turnTime: Measured<number>;
}

export interface RaceAnalysisResult {
  problems: readonly Problem[];
  lengths: readonly LengthMetrics[];
  turns: readonly TurnMetrics[];
  reactionTime: Measured<number>;
  flightTime: Measured<number>;
  raceTime: Measured<number>;
  raceMeanVelocity: Measured<number>;
  finishSegmentTime: Measured<number>;
  finishSegmentVelocity: Measured<number>;
  firstToLastStrokeRateDelta: Measured<number>;
  firstToLastLengthMeanVelocityDelta: Measured<number>;
}

export interface ImProposal {
  strokePerLength: readonly Stroke[];
  problems: readonly Problem[];
}

export function measured<T>(
  value: T,
  provenance: Provenance,
  approximate: boolean,
  unit: Unit,
): Measured<T> {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return absent('computed value is non-finite');
  }

  return { status: 'value', value, provenance, approximate, unit };
}

export function absent<T>(reason: string): Measured<T> {
  return { status: 'absent', reason };
}
