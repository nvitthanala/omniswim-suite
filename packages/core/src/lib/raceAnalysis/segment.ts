import { poolLengthForCourse, raceLengthCount } from './course';
import type { RaceConfig, RaceTag, RaceTagKind, Stroke } from './types';

export interface LengthSegment {
  lengthIndex: number;
  stroke: Stroke;
  tags: readonly RaceTag[];
}

export interface RaceSegments {
  lengthCount: number;
  poolLength: number;
  lengthUnit: 'm' | 'yd';
  lengths: readonly LengthSegment[];
  allTags: readonly RaceTag[];
  /** False when tags without length indexes cannot be deterministically assigned. */
  lengthsResolved: boolean;
}

export function buildRaceSegments(config: RaceConfig, tags: readonly RaceTag[]): RaceSegments {
  const pool = poolLengthForCourse(config.course);
  const lengthCount = raceLengthCount(config);
  const roundedLengthCount = Math.round(lengthCount);
  const configuredLengthCount = config.strokePerLength.length;
  const usableLengthCount = Number.isInteger(lengthCount) ? roundedLengthCount : configuredLengthCount;
  // Signal is race-level rather than length-scoped, so its omitted index is valid.
  const needsLengthResolution = tags.some((tag) => tag.kind !== 'Signal' && tag.lengthIndex === undefined);
  const canResolveLengths =
    !needsLengthResolution ||
    tags.every(
      (tag, index) => Number.isFinite(tag.time) && (index === 0 || tag.time >= tags[index - 1].time),
    );
  const allTags: readonly RaceTag[] =
    !needsLengthResolution || !canResolveLengths
      ? tags
      : (() => {
          let lengthIndex = 1;
          return tags.map((tag) => {
            const resolvedTag = { ...tag, lengthIndex };
            if (tag.kind === 'TurnEnd') {
              lengthIndex += 1;
            }
            return resolvedTag;
          });
        })();
  const lengths: LengthSegment[] = [];

  for (let index = 1; index <= usableLengthCount; index += 1) {
    const stroke = config.strokePerLength[index - 1];
    if (stroke !== undefined) {
      lengths.push({
        lengthIndex: index,
        stroke,
        tags: allTags.filter((tag) => tag.lengthIndex === index),
      });
    }
  }

  return {
    lengthCount: usableLengthCount,
    poolLength: pool.value,
    lengthUnit: pool.unit,
    lengths,
    allTags,
    lengthsResolved: canResolveLengths,
  };
}

export function tagsOfKind(tags: readonly RaceTag[], kind: RaceTagKind): readonly RaceTag[] {
  return tags.filter((tag) => tag.kind === kind);
}

export function firstTag(tags: readonly RaceTag[], kind: RaceTagKind): RaceTag | undefined {
  return tags.filter((tag) => tag.kind === kind).reduce<RaceTag | undefined>(
    (earliest, tag) => earliest === undefined || tag.time < earliest.time ? tag : earliest,
    undefined,
  );
}

export function enteredDistanceForLength(
  config: RaceConfig,
  lengthIndex: number,
): number | undefined {
  const distances = config.breakoutDistanceByLength;
  if (distances === undefined) {
    return undefined;
  }

  if (Array.isArray(distances)) {
    return distances[lengthIndex - 1];
  }

  return distances[lengthIndex];
}

