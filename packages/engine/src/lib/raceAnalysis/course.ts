import type { RaceConfig, RaceCourse, Unit } from './types';

const YARD_IN_METRES = 0.9144;

export interface PoolLength {
  value: number;
  unit: 'm' | 'yd';
}

export function poolLengthForCourse(course: RaceCourse): PoolLength {
  if (course === 'LCM') {
    return { value: 50, unit: 'm' };
  }

  if (course === 'SCM') {
    return { value: 25, unit: 'm' };
  }

  return { value: 25, unit: 'yd' };
}

export function velocityUnitForCourse(course: RaceCourse): Unit {
  return poolLengthForCourse(course).unit === 'yd' ? 'yd/s' : 'm/s';
}

export function distanceUnitForCourse(course: RaceCourse): Unit {
  return poolLengthForCourse(course).unit;
}

export function raceLengthCount(config: RaceConfig): number {
  return config.raceDistance / poolLengthForCourse(config.course).value;
}

export function courseDistanceToMetres(distance: number, course: RaceCourse): number {
  if (poolLengthForCourse(course).unit === 'yd') {
    return distance * YARD_IN_METRES;
  }

  return distance;
}

