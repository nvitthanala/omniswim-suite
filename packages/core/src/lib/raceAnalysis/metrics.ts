import { distanceUnitForCourse, poolLengthForCourse, velocityUnitForCourse } from './course';
import { UNDERWATER_LEGAL_LIMIT_METRES } from './reference';
import { buildRaceSegments, enteredDistanceForLength, firstTag, tagsOfKind } from './segment';
import { validateRaceTags } from './tagStateMachine';
import { absent, measured } from './types';
import type {
  LengthMetrics,
  Measured,
  RaceAnalysisResult,
  RaceConfig,
  RaceTag,
  StrokeCycleMetric,
  TurnMetrics,
} from './types';

const SECONDS_PER_MINUTE = 60;
const SPLIT_EPSILON_SECONDS = 1e-9;
const RELAY_START_REASON = 'relay takeoff \u2014 not comparable to a flat start';

function elapsed(end: RaceTag | undefined, start: RaceTag | undefined, absentReason: string): Measured<number> {
  if (end === undefined || start === undefined) {
    return absent(absentReason);
  }

  if (!Number.isFinite(end.time) || !Number.isFinite(start.time)) {
    return absent('tag times must be finite');
  }

  const duration = end.time - start.time;
  if (!Number.isFinite(duration)) {
    return absent('tag interval must be finite');
  }

  if (duration < 0) {
    return absent('tag interval must not be negative');
  }

  return measured(duration, 'derived', false, 's');
}

function ratio(
  numerator: number | undefined,
  denominator: Measured<number>,
  unit: 'm/s' | 'yd/s',
  absentReason: string,
  approximate: boolean,
): Measured<number> {
  if (denominator.status === 'absent') {
    return absent(denominator.reason);
  }

  if (numerator === undefined) {
    return absent(absentReason);
  }

  if (!Number.isFinite(numerator)) {
    return absent('numerator must be finite');
  }

  if (!Number.isFinite(denominator.value) || denominator.value <= 0) {
    return absent('denominator must be finite and greater than zero');
  }

  return measured(numerator / denominator.value, 'derived', approximate, unit);
}

function meanRate(tags: readonly RaceTag[], unit: 'cycles/min' | 'kicks/min', absentReason: string): Measured<number> {
  if (tags.length < 2) {
    return absent(absentReason);
  }

  const first = tags[0];
  const last = tags[tags.length - 1];
  const duration = last.time - first.time;
  if (!Number.isFinite(duration) || duration <= 0) {
    return absent('tag interval for rate must be finite and greater than zero');
  }

  return measured(SECONDS_PER_MINUTE * (tags.length - 1) / duration, 'derived', false, unit);
}

function cycleMetrics(strokes: readonly RaceTag[]): readonly StrokeCycleMetric[] {
  const cycles: StrokeCycleMetric[] = [];
  for (let index = 0; index < strokes.length - 1; index += 1) {
    const cycleTime = elapsed(strokes[index + 1], strokes[index], 'stroke tags are required for cycle time');
    const instantaneousStrokeRate =
      cycleTime.status === 'absent'
        ? absent<number>(cycleTime.reason)
        : cycleTime.value === 0 || !Number.isFinite(cycleTime.value)
          ? absent<number>('cycle time must be finite and greater than zero')
          : measured(SECONDS_PER_MINUTE / cycleTime.value, 'derived', false, 'cycles/min');
    cycles.push({
      cycleIndex: index + 1,
      cycleTime,
      instantaneousStrokeRate,
    });
  }

  return cycles;
}

function splitForLength(
  tags: readonly RaceTag[],
  lengthIndex: number,
  lengthCount: number,
): Measured<number> {
  const start = firstTag(tags, 'Start');
  const finish = firstTag(tags, 'Finish');

  if (lengthIndex === 1) {
    const boundary = firstTag(tags.filter((tag) => tag.lengthIndex === 1), lengthCount === 1 ? 'Finish' : 'TurnStart');
    return elapsed(boundary, start, 'split boundary is missing');
  }

  const previousBoundary = firstTag(tags.filter((tag) => tag.lengthIndex === lengthIndex - 1), 'TurnStart');
  if (lengthIndex === lengthCount) {
    return elapsed(finish, previousBoundary, 'split boundary is missing');
  }

  const boundary = firstTag(tags.filter((tag) => tag.lengthIndex === lengthIndex), 'TurnStart');
  return elapsed(boundary, previousBoundary, 'split boundary is missing');
}

function distancePerCycleForLength(
  config: RaceConfig,
  lengthIndex: number,
  lengthCount: number,
  cycleCount: Measured<number>,
  tags: readonly RaceTag[],
): Measured<number> {
  const breakoutDistance = enteredDistanceForLength(config, lengthIndex);
  if (breakoutDistance === undefined) {
    return absent('breakout distance was not entered');
  }

  if (cycleCount.status === 'absent') {
    return absent(cycleCount.reason);
  }

  if (!Number.isFinite(cycleCount.value) || cycleCount.value <= 0) {
    return absent('at least one stroke tag is required for distance per cycle');
  }

  const poolLength = poolLengthForCourse(config.course).value;
  const hasFlags = firstTag(tags, 'Flags') !== undefined;
  const finishApproach =
    lengthIndex === lengthCount && hasFlags && config.flagDistance !== undefined ? config.flagDistance : 0;
  const distance = poolLength - breakoutDistance - finishApproach;
  if (!Number.isFinite(distance)) {
    return absent('distance for distance per cycle must be finite');
  }
  return measured(
    distance / cycleCount.value,
    'derived',
    true,
    distanceUnitForCourse(config.course),
  );
}

function firstToLastDelta(
  first: Measured<number> | undefined,
  last: Measured<number> | undefined,
  unit: 'cycles/min' | 'm/s' | 'yd/s',
  reason: string,
): Measured<number> {
  if (first === undefined || last === undefined) {
    return absent(reason);
  }

  if (first.status === 'absent') {
    return absent(first.reason);
  }

  if (last.status === 'absent') {
    return absent(last.reason);
  }

  const delta = last.value - first.value;
  if (!Number.isFinite(delta)) {
    return absent('first-to-last delta must be finite');
  }

  return measured(delta, 'derived', false, unit);
}

function validKicksForLength(
  lengthIndex: number,
  lengthTags: readonly RaceTag[],
  allTags: readonly RaceTag[],
): readonly RaceTag[] {
  const breakout = firstTag(lengthTags, 'Breakout');
  const startBoundary =
    lengthIndex === 1
      ? firstTag(allTags, 'Start')
      : firstTag(allTags.filter((tag) => tag.lengthIndex === lengthIndex - 1), 'TurnEnd');

  return tagsOfKind(lengthTags, 'Kick').filter(
    (kick) =>
      startBoundary !== undefined &&
      breakout !== undefined &&
      Number.isFinite(kick.time) &&
      kick.time >= startBoundary.time &&
      kick.time <= breakout.time,
  );
}

function absentLengthMetrics(segments: ReturnType<typeof buildRaceSegments>): LengthMetrics[] {
  const reason = 'length indexes could not be resolved';
  return segments.lengths.map((length) => ({
    lengthIndex: length.lengthIndex,
    stroke: length.stroke,
    breakoutTime: absent(reason),
    underwaterTime: absent(reason),
    underwaterVelocity: absent(reason),
    kickCount: absent(reason),
    kickTempo: absent(reason),
    fifteenMetreTime: absent(reason),
    zeroToFifteenMetreVelocity: absent(reason),
    cycleCount: absent(reason),
    strokeRate: absent(reason),
    strokeCycles: [],
    distancePerCycle: absent(reason),
    split: absent(reason),
    meanVelocity: absent(reason),
  }));
}

export function analyzeRace(config: RaceConfig, tags: readonly RaceTag[]): RaceAnalysisResult {
  const segments = buildRaceSegments(config, tags);
  const problems = validateRaceTags(config, tags);
  const unresolvedReason = 'length indexes could not be resolved';
  if (!segments.lengthsResolved) {
    const lengths = absentLengthMetrics(segments);
    return {
      problems,
      lengths,
      turns: segments.lengths
        .filter((length) => length.lengthIndex < segments.lengthCount)
        .map((length) => ({
          turnIndex: length.lengthIndex,
          lengthIndex: length.lengthIndex,
          turnTime: absent(unresolvedReason),
        })),
      reactionTime: absent(unresolvedReason),
      flightTime: absent(unresolvedReason),
      raceTime: absent(unresolvedReason),
      raceMeanVelocity: absent(unresolvedReason),
      finishSegmentTime: absent(unresolvedReason),
      finishSegmentVelocity: absent(unresolvedReason),
      firstToLastStrokeRateDelta: absent(unresolvedReason),
      firstToLastLengthMeanVelocityDelta: absent(unresolvedReason),
    };
  }

  const resolvedTags = segments.allTags;
  const start = firstTag(resolvedTags, 'Start');
  const signal = firstTag(resolvedTags, 'Signal');
  const entry = firstTag(resolvedTags, 'Entry');
  const finish = firstTag(resolvedTags, 'Finish');
  const flags = firstTag(resolvedTags, 'Flags');
  const velocityUnit = velocityUnitForCourse(config.course) as 'm/s' | 'yd/s';

  const reactionTime = config.isRelayLeg
    ? absent<number>(RELAY_START_REASON)
    : elapsed(start, signal, 'signal tag is required for reaction time');
  const flightTime = config.isRelayLeg
    ? absent<number>(RELAY_START_REASON)
    : elapsed(entry, start, 'start and entry tags are required for flight time');
  const raceTime = elapsed(finish, start, 'start and finish tags are required for race time');
  const raceMeanVelocity = ratio(config.raceDistance, raceTime, velocityUnit, 'race time is required for race mean velocity', false);
  const invalidFlags = problems.some(
    (candidate) => candidate.code === 'FLAGS_NOT_ON_FINAL_LENGTH' || candidate.code === 'FLAGS_AFTER_FINISH',
  );
  const finishSegmentTime = invalidFlags
    ? absent<number>('flags tag is invalid for finish segment metrics')
    : elapsed(finish, flags, 'flags tag is required for finish segment time');
  const finishSegmentVelocity = ratio(
    config.flagDistance,
    finishSegmentTime,
    velocityUnit,
    'flag distance must be supplied for finish segment velocity',
    false,
  );

  const lengths: LengthMetrics[] = segments.lengths.map((length) => {
    const lengthTags = length.tags;
    const breakout = firstTag(lengthTags, 'Breakout');
    const previousTurnEnd =
      length.lengthIndex === 1
        ? start
        : firstTag(resolvedTags.filter((tag) => tag.lengthIndex === length.lengthIndex - 1), 'TurnEnd');
    const breakoutTime = elapsed(
      breakout,
      previousTurnEnd,
      length.lengthIndex === 1
        ? 'start and breakout tags are required for breakout time'
        : 'previous turn end and breakout tags are required for breakout time',
    );
    const underwaterTime =
      length.lengthIndex === 1
        ? elapsed(breakout, entry, 'entry and breakout tags are required for underwater time')
        : elapsed(breakout, previousTurnEnd, 'previous turn end and breakout tags are required for underwater time');
    const underwaterVelocity = ratio(
      enteredDistanceForLength(config, length.lengthIndex),
      underwaterTime,
      velocityUnit,
      'breakout distance was not entered',
      true,
    );
    const taggedKicks = tagsOfKind(lengthTags, 'Kick');
    const kicks = validKicksForLength(length.lengthIndex, lengthTags, resolvedTags);
    const strokes = tagsOfKind(lengthTags, 'Stroke');
    const fifteenMetreTag = firstTag(lengthTags, 'FifteenMetre');
    const rawFifteenMetreTime =
      config.course === 'SCY' && !config.fifteenMetreReferenceConfirmed
        ? absent<number>('FIFTEEN_METRE_UNAVAILABLE')
        : elapsed(
            fifteenMetreTag,
            previousTurnEnd,
            length.lengthIndex === 1
              ? 'start and 15 m tags are required for 15 m time'
              : 'previous turn end and 15 m tags are required for 15 m time',
          );
    const fifteenMetreApproximate = length.lengthIndex > 1;
    const fifteenMetreTime =
      rawFifteenMetreTime.status === 'absent'
        ? rawFifteenMetreTime
        : measured(rawFifteenMetreTime.value, rawFifteenMetreTime.provenance, fifteenMetreApproximate, 's');
    const zeroToFifteenMetreVelocity = ratio(
      UNDERWATER_LEGAL_LIMIT_METRES,
      fifteenMetreTime,
      'm/s',
      '15 m time is required for 15 m velocity',
      fifteenMetreApproximate,
    );
    const cycleCount =
      strokes.length === 0
        ? absent<number>('stroke tags were not tagged for this length')
        : measured(strokes.length, 'tagged', false, 'count');
    const kickCount =
      taggedKicks.length === 0
        ? absent<number>('kick tags were not tagged for this length')
        : kicks.length === 0
          ? absent<number>('no valid kick tags were tagged for this length')
          : measured(kicks.length, 'tagged', false, 'count');
    const split = splitForLength(resolvedTags, length.lengthIndex, segments.lengthCount);
    const meanVelocity = ratio(
      poolLengthForCourse(config.course).value,
      split,
      velocityUnit,
      'split is required for length mean velocity',
      false,
    );

    return {
      lengthIndex: length.lengthIndex,
      stroke: length.stroke,
      breakoutTime,
      underwaterTime,
      underwaterVelocity,
      kickCount,
      kickTempo: meanRate(kicks, 'kicks/min', 'at least two valid kick tags are required for kick tempo'),
      fifteenMetreTime,
      zeroToFifteenMetreVelocity,
      cycleCount,
      strokeRate: meanRate(strokes, 'cycles/min', 'at least two stroke tags are required for stroke rate'),
      strokeCycles: cycleMetrics(strokes),
      distancePerCycle: distancePerCycleForLength(config, length.lengthIndex, segments.lengthCount, cycleCount, resolvedTags),
      split,
      meanVelocity,
    };
  });

  const turns: TurnMetrics[] = [];
  for (const length of segments.lengths) {
    if (length.lengthIndex < segments.lengthCount) {
      const turnStart = firstTag(length.tags, 'TurnStart');
      const turnEnd = firstTag(length.tags, 'TurnEnd');
      turns.push({
        turnIndex: length.lengthIndex,
        lengthIndex: length.lengthIndex,
        turnTime: elapsed(turnEnd, turnStart, 'turn start and turn end tags are required for turn time'),
      });
    }
  }

  const splitValues = lengths
    .map((length) => length.split)
    .filter((split): split is Extract<Measured<number>, { status: 'value' }> => split.status === 'value');
  if (raceTime.status === 'value' && splitValues.length === lengths.length) {
    const splitTotal = splitValues.reduce((total, split) => total + split.value, 0);
    if (Math.abs(splitTotal - raceTime.value) > SPLIT_EPSILON_SECONDS) {
      problems.push({
        code: 'SPLIT_DIVERGENCE',
        severity: 'warning',
        message: 'sum of length splits does not match race time',
      });
    }
  }

  return {
    problems,
    lengths,
    turns,
    reactionTime,
    flightTime,
    raceTime,
    raceMeanVelocity,
    finishSegmentTime,
    finishSegmentVelocity,
    firstToLastStrokeRateDelta:
      lengths.length < 2
        ? absent('a single-length race has no first-to-last comparison')
        : firstToLastDelta(
            lengths[0]?.strokeRate,
            lengths[lengths.length - 1]?.strokeRate,
            'cycles/min',
            'first and last stroke rates are required for delta',
          ),
    firstToLastLengthMeanVelocityDelta:
      lengths.length < 2
        ? absent('a single-length race has no first-to-last comparison')
        : firstToLastDelta(
            lengths[0]?.meanVelocity,
            lengths[lengths.length - 1]?.meanVelocity,
            velocityUnit,
            'first and last length mean velocities are required for delta',
          ),
  };
}
