import { describe, expect, it } from 'vitest';
import {
  analyzeRace,
  createTagStateMachine,
  proposeStandardImStrokeOrder,
  raceAnalysisReferenceBands,
  type Measured,
  type RaceAnalysisResult,
  type RaceConfig,
  type RaceTag,
  type Unit,
} from '../packages/core/src/lib/raceAnalysis';

function valueOf(metric: Measured<number>, unit?: Unit): number {
  expect(metric.status).toBe('value');
  if (metric.status === 'absent') {
    throw new Error(metric.reason);
  }

  if (unit !== undefined) {
    expect(metric.unit).toBe(unit);
  }

  return metric.value;
}

function expectAbsent(metric: Measured<number>, reason?: string): void {
  expect(metric.status).toBe('absent');
  if (metric.status === 'absent' && reason !== undefined) {
    expect(metric.reason).toBe(reason);
  }
}

function strokeTags(lengthIndex: number, start: number, count: number, interval: number): RaceTag[] {
  const tags: RaceTag[] = [];
  for (let index = 0; index < count; index += 1) {
    tags.push({ kind: 'Stroke', time: start + index * interval, lengthIndex });
  }

  return tags;
}

function fixtureA(): { config: RaceConfig; tags: RaceTag[] } {
  const l1Strokes = strokeTags(1, 15.9, 16, 1.2);
  return {
    config: {
      course: 'LCM',
      raceDistance: 100,
      strokePerLength: ['free', 'free'],
      cycleDefinition: 'same-hand',
      breakoutDistanceByLength: [9.5, 8.0],
      flagDistance: 5,
      fifteenMetreReferenceConfirmed: true,
      isRelayLeg: false,
    },
    tags: [
      { kind: 'Signal', time: 10.0 },
      { kind: 'Start', time: 10.68, lengthIndex: 1 },
      { kind: 'Entry', time: 11.4, lengthIndex: 1 },
      { kind: 'Kick', time: 12.0, lengthIndex: 1 },
      { kind: 'Kick', time: 12.4, lengthIndex: 1 },
      { kind: 'Kick', time: 12.8, lengthIndex: 1 },
      { kind: 'Kick', time: 13.2, lengthIndex: 1 },
      { kind: 'Kick', time: 13.6, lengthIndex: 1 },
      { kind: 'Kick', time: 14.0, lengthIndex: 1 },
      { kind: 'Breakout', time: 15.4, lengthIndex: 1 },
      l1Strokes[0],
      { kind: 'FifteenMetre', time: 16.5, lengthIndex: 1 },
      ...l1Strokes.slice(1),
      { kind: 'TurnStart', time: 35.4, lengthIndex: 1 },
      { kind: 'TurnEnd', time: 36.5, lengthIndex: 1 },
      { kind: 'Breakout', time: 40.0, lengthIndex: 2 },
      ...strokeTags(2, 40.5, 4, 1.25),
      { kind: 'FifteenMetre', time: 45.0, lengthIndex: 2 },
      ...strokeTags(2, 45.5, 14, 1.25),
      { kind: 'Flags', time: 63.0, lengthIndex: 2 },
      { kind: 'Finish', time: 65.4, lengthIndex: 2 },
    ],
  };
}

function fixtureB(): { config: RaceConfig; tags: RaceTag[] } {
  const tags: RaceTag[] = [
    { kind: 'Start', time: 5.0, lengthIndex: 1 },
    { kind: 'Entry', time: 5.7, lengthIndex: 1 },
    { kind: 'Breakout', time: 8.0, lengthIndex: 1 },
    ...strokeTags(1, 8.5, 10, 1.0),
    { kind: 'TurnStart', time: 20.0, lengthIndex: 1 },
    { kind: 'TurnEnd', time: 21.0, lengthIndex: 1 },
  ];

  let previousTurnEnd = 21.0;
  for (let lengthIndex = 2; lengthIndex <= 7; lengthIndex += 1) {
    tags.push({ kind: 'Breakout', time: previousTurnEnd + 2.5, lengthIndex });
    tags.push(...strokeTags(lengthIndex, previousTurnEnd + 3.0, 10, 1.0));
    tags.push({ kind: 'TurnStart', time: previousTurnEnd + 19.0, lengthIndex });
    tags.push({ kind: 'TurnEnd', time: previousTurnEnd + 20.0, lengthIndex });
    previousTurnEnd += 20.0;
  }

  tags.push({ kind: 'Breakout', time: 143.5, lengthIndex: 8 });
  tags.push(...strokeTags(8, 144.0, 10, 1.0));
  tags.push({ kind: 'Finish', time: 160.5, lengthIndex: 8 });

  return {
    config: {
      course: 'SCY',
      raceDistance: 200,
      strokePerLength: ['free', 'free', 'free', 'free', 'free', 'free', 'free', 'free'],
      cycleDefinition: 'same-hand',
      fifteenMetreReferenceConfirmed: false,
      isRelayLeg: false,
    },
    tags,
  };
}

function collectValueUnits(value: unknown, units: Unit[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValueUnits(item, units);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.status === 'value' && typeof record.unit === 'string') {
      units.push(record.unit as Unit);
    }

    for (const child of Object.values(record)) {
      collectValueUnits(child, units);
    }
  }
}

describe('raceAnalysis', () => {
  it('computes Fixture A 100 LCM freestyle metrics without applying display bands as rules', () => {
    const { config, tags } = fixtureA();
    const result = analyzeRace(config, tags);

    expect(result.problems).toHaveLength(0);
    expect(valueOf(result.reactionTime, 's')).toBeCloseTo(0.68, 6);
    expect(valueOf(result.flightTime, 's')).toBeCloseTo(0.72, 6);
    expect(valueOf(result.lengths[0].breakoutTime, 's')).toBeCloseTo(4.72, 6);
    expect(valueOf(result.lengths[1].breakoutTime, 's')).toBeCloseTo(3.5, 6);
    expect(valueOf(result.lengths[0].underwaterVelocity, 'm/s')).toBeCloseTo(2.375, 6);
    expect(valueOf(result.lengths[1].underwaterVelocity, 'm/s')).toBeCloseTo(2.285714285714286, 6);
    expect(valueOf(result.lengths[0].kickCount, 'count')).toBe(6);
    expect(valueOf(result.lengths[0].kickTempo, 'kicks/min')).toBeCloseTo(150.0, 6);
    expect(valueOf(result.lengths[0].fifteenMetreTime, 's')).toBeCloseTo(5.82, 6);
    expect(valueOf(result.lengths[0].zeroToFifteenMetreVelocity, 'm/s')).toBeCloseTo(2.577319587628866, 6);
    expect(valueOf(result.lengths[0].cycleCount, 'count')).toBe(16);
    expect(valueOf(result.lengths[1].cycleCount, 'count')).toBe(18);
    expect(valueOf(result.lengths[0].strokeRate, 'cycles/min')).toBeCloseTo(50.0, 6);
    expect(valueOf(result.lengths[1].strokeRate, 'cycles/min')).toBeCloseTo(48.0, 6);
    expect(valueOf(result.lengths[0].distancePerCycle, 'm')).toBeCloseTo(2.53125, 6);
    expect(valueOf(result.lengths[1].distancePerCycle, 'm')).toBeCloseTo(2.055555555555556, 6);
    expect(valueOf(result.turns[0].turnTime, 's')).toBeCloseTo(1.1, 6);
    expect(valueOf(result.lengths[0].split, 's')).toBeCloseTo(24.72, 6);
    expect(valueOf(result.lengths[1].split, 's')).toBeCloseTo(30.0, 6);
    expect(valueOf(result.lengths[0].meanVelocity, 'm/s')).toBeCloseTo(2.022653721682848, 6);
    expect(valueOf(result.lengths[1].meanVelocity, 'm/s')).toBeCloseTo(1.666666666666667, 6);
    expect(valueOf(result.raceTime, 's')).toBeCloseTo(54.72, 6);
    expect(valueOf(result.raceMeanVelocity, 'm/s')).toBeCloseTo(1.827485380116959, 6);
    expect(valueOf(result.finishSegmentTime, 's')).toBeCloseTo(2.4, 6);
    expect(valueOf(result.finishSegmentVelocity, 'm/s')).toBeCloseTo(2.083333333333333, 6);

    expect(valueOf(result.lengths[0].underwaterTime, 's')).toBeCloseTo(4.0, 6);
    expect(valueOf(result.lengths[1].underwaterTime, 's')).toBeCloseTo(3.5, 6);
    expect(result.lengths[0].underwaterVelocity.status === 'value' && result.lengths[0].underwaterVelocity.approximate).toBe(true);
    expect(result.lengths[1].underwaterVelocity.status === 'value' && result.lengths[1].underwaterVelocity.approximate).toBe(true);
    expect(result.lengths[0].distancePerCycle.status === 'value' && result.lengths[0].distancePerCycle.approximate).toBe(true);
    expect(result.lengths[0].fifteenMetreTime.status === 'value' && result.lengths[0].fifteenMetreTime.approximate).toBe(false);
    expect(valueOf(result.lengths[1].fifteenMetreTime, 's')).toBeCloseTo(8.5, 6);
    expect(result.lengths[1].fifteenMetreTime.status === 'value' && result.lengths[1].fifteenMetreTime.approximate).toBe(true);
    expect(result.lengths[0].zeroToFifteenMetreVelocity.status === 'value' && result.lengths[0].zeroToFifteenMetreVelocity.approximate).toBe(false);
    expect(result.lengths[1].zeroToFifteenMetreVelocity.status === 'value' && result.lengths[1].zeroToFifteenMetreVelocity.approximate).toBe(true);
    expect(result.reactionTime.status === 'value' && result.reactionTime.provenance).toBe('derived');
    expect(result.lengths[0].split.status === 'value' && result.lengths[0].split.provenance).toBe('derived');
    const subtractionMetrics = [
      result.reactionTime,
      result.flightTime,
      result.raceTime,
      result.lengths[0].breakoutTime,
      result.lengths[0].underwaterTime,
      result.lengths[0].fifteenMetreTime,
      result.lengths[0].split,
      result.turns[0].turnTime,
      result.finishSegmentTime,
      result.lengths[0].strokeCycles[0].cycleTime,
    ];
    for (const metric of subtractionMetrics) {
      expect(metric.status).toBe('value');
      if (metric.status === 'value') {
        expect(metric.provenance).toBe('derived');
      }
    }

    const splitSum = valueOf(result.lengths[0].split) + valueOf(result.lengths[1].split);
    expect(splitSum).toBeCloseTo(valueOf(result.raceTime), 6);
    expect(valueOf(result.reactionTime)).toBeCloseTo(0.68, 6);
    expect(raceAnalysisReferenceBands.find((band) => band.key === 'start')?.quote).toBe('.75 to 1.00 avg.');
    expect(result.problems.map((problem) => problem.code)).not.toContain('SPLIT_DIVERGENCE');
  });

  it('computes Fixture B 200 SCY freestyle in yard units and blocks unconfirmed 15 m metrics', () => {
    const { config, tags } = fixtureB();
    const result = analyzeRace(config, tags);

    expect(valueOf(result.flightTime, 's')).toBeCloseTo(0.7, 6);
    expectAbsent(result.reactionTime);
    expect(result.problems.filter((problem) => problem.code === 'FIFTEEN_METRE_UNAVAILABLE')).toHaveLength(1);

    for (const length of result.lengths) {
      expectAbsent(length.fifteenMetreTime, 'FIFTEEN_METRE_UNAVAILABLE');
      expectAbsent(length.zeroToFifteenMetreVelocity, 'FIFTEEN_METRE_UNAVAILABLE');
      expectAbsent(length.underwaterVelocity);
      expectAbsent(length.distancePerCycle);
      expectAbsent(length.kickCount, 'kick tags were not tagged for this length');
      expect(valueOf(length.cycleCount, 'count')).toBe(10);
      expect(valueOf(length.strokeRate, 'cycles/min')).toBeCloseTo(60.0, 6);
    }

    expect(valueOf(result.lengths[0].breakoutTime, 's')).toBeCloseTo(3.0, 6);
    for (const length of result.lengths.slice(1)) {
      expect(valueOf(length.breakoutTime, 's')).toBeCloseTo(2.5, 6);
    }

    expect(result.turns).toHaveLength(7);
    for (const turn of result.turns) {
      expect(valueOf(turn.turnTime, 's')).toBeCloseTo(1.0, 6);
    }

    expect(valueOf(result.lengths[0].split, 's')).toBeCloseTo(15.0, 6);
    for (const length of result.lengths.slice(1, 7)) {
      expect(valueOf(length.split, 's')).toBeCloseTo(20.0, 6);
    }
    expect(valueOf(result.lengths[7].split, 's')).toBeCloseTo(20.5, 6);

    const splitSum = result.lengths.reduce((total, length) => total + valueOf(length.split), 0);
    expect(splitSum).toBeCloseTo(155.5, 6);
    expect(valueOf(result.lengths[0].meanVelocity, 'yd/s')).toBeCloseTo(1.666666666666667, 6);
    for (const length of result.lengths.slice(1, 7)) {
      expect(valueOf(length.meanVelocity, 'yd/s')).toBeCloseTo(1.25, 6);
    }
    expect(valueOf(result.lengths[7].meanVelocity, 'yd/s')).toBeCloseTo(1.219512195121951, 6);
    expect(valueOf(result.raceTime, 's')).toBeCloseTo(155.5, 6);
    expect(valueOf(result.raceMeanVelocity, 'yd/s')).toBeCloseTo(1.286173633440514, 6);
    expectAbsent(result.finishSegmentTime);

    const totalCycleCount = result.lengths.reduce((total, length) => total + valueOf(length.cycleCount), 0);
    expect(totalCycleCount).toBe(80);

    const units: Unit[] = [];
    collectValueUnits(result, units);
    expect(units).not.toContain('m');
    expect(units).not.toContain('m/s');
  });

  it('keeps Fixture C splits and stroke segmentation stable when a turn end is missing', () => {
    const { config, tags } = fixtureA();
    const result: RaceAnalysisResult = analyzeRace(
      config,
      tags.filter((tag) => !(tag.kind === 'TurnEnd' && tag.time === 36.5)),
    );

    const unpairedTurns = result.problems.filter((problem) => problem.code === 'UNPAIRED_TURN');
    expect(unpairedTurns).toHaveLength(1);
    expect(unpairedTurns[0].severity).toBe('warning');
    expectAbsent(result.turns[0].turnTime);
    expectAbsent(result.lengths[1].breakoutTime);
    expectAbsent(result.lengths[1].underwaterVelocity);
    expect(valueOf(result.lengths[0].split, 's')).toBeCloseTo(24.72, 6);
    expect(valueOf(result.lengths[1].split, 's')).toBeCloseTo(30.0, 6);
    expect(valueOf(result.lengths[1].strokeRate, 'cycles/min')).toBeCloseTo(48.0, 6);
    expect(valueOf(result.raceTime, 's')).toBeCloseTo(54.72, 6);
  });

  it('re-derives every missing length index from monotonic tag order', () => {
    const { config, tags } = fixtureA();
    const result = analyzeRace(config, tags.map(({ lengthIndex: _lengthIndex, ...tag }) => tag));

    expect(result.problems.map((problem) => problem.code)).not.toContain('LENGTHS_UNRESOLVED');
    expect(valueOf(result.lengths[0].split, 's')).toBeCloseTo(24.72, 6);
    expect(valueOf(result.lengths[1].split, 's')).toBeCloseTo(30.0, 6);
    expect(valueOf(result.lengths[0].cycleCount, 'count')).toBe(16);
    expect(valueOf(result.lengths[1].strokeRate, 'cycles/min')).toBeCloseTo(48.0, 6);
  });

  it('reports unresolved lengths and emits no plausible metrics when missing indexes are non-monotonic', () => {
    const { config, tags } = fixtureA();
    const indexFreeTags = tags.map(({ lengthIndex: _lengthIndex, ...tag }) => tag);
    const result = analyzeRace(config, [indexFreeTags[1], indexFreeTags[0], ...indexFreeTags.slice(2)]);

    expect(result.problems.find((problem) => problem.code === 'LENGTHS_UNRESOLVED')?.severity).toBe('error');
    expectAbsent(result.raceTime, 'length indexes could not be resolved');
    expectAbsent(result.lengths[0].split, 'length indexes could not be resolved');
  });

  it('returns absent for an identical-timestamp rate denominator and single-length deltas', () => {
    const config: RaceConfig = {
      course: 'LCM',
      raceDistance: 50,
      strokePerLength: ['free'],
      cycleDefinition: 'same-hand',
      fifteenMetreReferenceConfirmed: true,
      isRelayLeg: false,
    };
    const result = analyzeRace(config, [
      { kind: 'Start', time: 0, lengthIndex: 1 },
      { kind: 'Entry', time: 0.5, lengthIndex: 1 },
      { kind: 'Breakout', time: 2, lengthIndex: 1 },
      { kind: 'Stroke', time: 3, lengthIndex: 1 },
      { kind: 'Stroke', time: 3, lengthIndex: 1 },
      { kind: 'Finish', time: 30, lengthIndex: 1 },
    ]);

    expectAbsent(result.lengths[0].strokeRate, 'tag interval for rate must be finite and greater than zero');
    expectAbsent(result.lengths[0].strokeCycles[0].instantaneousStrokeRate, 'cycle time must be finite and greater than zero');
    expectAbsent(result.firstToLastStrokeRateDelta, 'a single-length race has no first-to-last comparison');
    expectAbsent(result.firstToLastLengthMeanVelocityDelta, 'a single-length race has no first-to-last comparison');

    const noStrokeResult = analyzeRace(
      config,
      [
        { kind: 'Start', time: 0, lengthIndex: 1 },
        { kind: 'Entry', time: 0.5, lengthIndex: 1 },
        { kind: 'Breakout', time: 2, lengthIndex: 1 },
        { kind: 'Finish', time: 30, lengthIndex: 1 },
      ],
    );
    expectAbsent(noStrokeResult.lengths[0].cycleCount, 'stroke tags were not tagged for this length');
  });

  it('invalidates finish metrics for misplaced flags and excludes out-of-window kicks', () => {
    const config: RaceConfig = {
      course: 'LCM',
      raceDistance: 50,
      strokePerLength: ['free'],
      cycleDefinition: 'same-hand',
      flagDistance: 5,
      fifteenMetreReferenceConfirmed: true,
      isRelayLeg: false,
    };
    const result = analyzeRace(config, [
      { kind: 'Start', time: 0, lengthIndex: 1 },
      { kind: 'Entry', time: 0.5, lengthIndex: 1 },
      { kind: 'Breakout', time: 2, lengthIndex: 1 },
      { kind: 'Kick', time: 3, lengthIndex: 1 },
      { kind: 'Stroke', time: 4, lengthIndex: 1 },
      { kind: 'Stroke', time: 5, lengthIndex: 1 },
      { kind: 'Flags', time: 20, lengthIndex: 2 },
      { kind: 'Finish', time: 30, lengthIndex: 1 },
    ]);

    expect(result.problems.map((problem) => problem.code)).toContain('FLAGS_NOT_ON_FINAL_LENGTH');
    expect(result.problems.map((problem) => problem.code)).toContain('KICK_OUTSIDE_UNDERWATER');
    expectAbsent(result.finishSegmentTime, 'flags tag is invalid for finish segment metrics');
    expectAbsent(result.finishSegmentVelocity, 'flags tag is invalid for finish segment metrics');
    expectAbsent(result.lengths[0].kickCount, 'no valid kick tags were tagged for this length');
  });

  it('supports legal and illegal tag presses, including undo', () => {
    const state = createTagStateMachine({
      course: 'LCM',
      raceDistance: 50,
      strokePerLength: ['free'],
      cycleDefinition: 'same-hand',
      fifteenMetreReferenceConfirmed: true,
      isRelayLeg: false,
    });

    expect(state.press('D', 0).status).toBe('illegal');
    expect(state.press('S', 0).status).toBe('tagged');
    expect(state.press('S', 0.5).status).toBe('tagged');
    expect(state.press('S', 2).status).toBe('tagged');
    expect(state.press('D', 30).status).toBe('tagged');
    expect(state.undo().status).toBe('tagged');
    expect(state.nextD().status).toBe('available');
  });

  it('proposes standard IM order and rejects non-quarterable length counts', () => {
    const proposal = proposeStandardImStrokeOrder(8);
    expect(proposal.strokePerLength).toStrictEqual(['fly', 'fly', 'back', 'back', 'breast', 'breast', 'free', 'free']);
    expect(proposal.problems).toHaveLength(0);

    const invalid = proposeStandardImStrokeOrder(6);
    expect(invalid.strokePerLength).toStrictEqual([]);
    expect(invalid.problems[0].code).toBe('IM_LENGTHS_NOT_DIVISIBLE');
  });
});

