import { raceLengthCount } from './course';
import { buildRaceSegments, firstTag, tagsOfKind } from './segment';
import { courseDistanceToMetres } from './course';
import { UNDERWATER_LEGAL_LIMIT_METRES } from './reference';
import type {
  OperatorKey,
  Problem,
  ProblemCode,
  ProblemSeverity,
  RaceConfig,
  RaceTag,
  RaceTagKind,
  RaceTagStateMachine,
  TagPressResult,
  TagPreview,
} from './types';
import { enteredDistanceForLength } from './segment';

function problem(
  code: ProblemCode,
  severity: ProblemSeverity,
  message: string,
  lengthIndex?: number,
): Problem {
  if (lengthIndex === undefined) {
    return { code, severity, message };
  }

  return { code, severity, message, lengthIndex };
}

function lengthCountForState(config: RaceConfig): number {
  const computed = raceLengthCount(config);
  if (Number.isInteger(computed)) {
    return Math.round(computed);
  }

  return config.strokePerLength.length;
}

function tagged(tag: RaceTag): TagPressResult {
  return { status: 'tagged', tag };
}

function illegal(reason: string): TagPressResult {
  return { status: 'illegal', reason };
}

function preview(
  key: OperatorKey,
  kind: RaceTagKind | undefined,
  lengthIndex: number | undefined,
  reason: string | undefined,
): TagPreview {
  if (kind === undefined) {
    return { status: 'illegal', key, reason };
  }

  if (lengthIndex === undefined) {
    return { status: 'available', key, kind };
  }

  return { status: 'available', key, kind, lengthIndex };
}

function lastCompletedTurnEnd(tags: readonly RaceTag[]): RaceTag | undefined {
  const turnEnds = tagsOfKind(tags, 'TurnEnd');
  return turnEnds[turnEnds.length - 1];
}

function currentLengthIndex(config: RaceConfig, tags: readonly RaceTag[]): number {
  const start = firstTag(tags, 'Start');
  if (start === undefined) {
    return 1;
  }

  const latestTurnEnd = lastCompletedTurnEnd(tags);
  if (latestTurnEnd === undefined) {
    return 1;
  }

  const nextLength = latestTurnEnd.lengthIndex === undefined ? 1 : latestTurnEnd.lengthIndex + 1;
  const lengthCount = lengthCountForState(config);
  return nextLength > lengthCount ? lengthCount : nextLength;
}

function nextSKind(config: RaceConfig, tags: readonly RaceTag[]): TagPreview {
  const lengthCount = lengthCountForState(config);
  const start = firstTag(tags, 'Start');
  if (start === undefined) {
    return preview('S', 'Start', 1, undefined);
  }

  const entry = firstTag(tags, 'Entry');
  if (entry === undefined) {
    return preview('S', 'Entry', 1, undefined);
  }

  const lengthIndex = currentLengthIndex(config, tags);
  const lengthTags = tags.filter((tag) => tag.lengthIndex === lengthIndex);
  const boundaryStarted = firstTag(lengthTags, 'TurnStart');
  const finish = firstTag(tags, 'Finish');
  if (boundaryStarted !== undefined || finish !== undefined) {
    return preview('S', undefined, undefined, 'S is not legal after this length boundary');
  }

  const breakout = firstTag(lengthTags, 'Breakout');
  if (breakout === undefined) {
    return preview('S', 'Breakout', lengthIndex, undefined);
  }

  if (lengthIndex > lengthCount) {
    return preview('S', undefined, undefined, 'race already has all configured lengths');
  }

  return preview('S', 'Stroke', lengthIndex, undefined);
}

function nextDKind(config: RaceConfig, tags: readonly RaceTag[]): TagPreview {
  const lengthCount = lengthCountForState(config);
  const lengthIndex = currentLengthIndex(config, tags);
  const lengthTags = tags.filter((tag) => tag.lengthIndex === lengthIndex);
  const breakout = firstTag(lengthTags, 'Breakout');
  if (breakout === undefined) {
    return preview('D', undefined, undefined, 'D is not legal before breakout');
  }

  if (lengthIndex === lengthCount) {
    const finish = firstTag(tags, 'Finish');
    if (finish !== undefined) {
      return preview('D', undefined, undefined, 'finish already tagged');
    }

    return preview('D', 'Finish', lengthIndex, undefined);
  }

  const turnStart = firstTag(lengthTags, 'TurnStart');
  if (turnStart === undefined) {
    return preview('D', 'TurnStart', lengthIndex, undefined);
  }

  const turnEnd = firstTag(lengthTags, 'TurnEnd');
  if (turnEnd === undefined) {
    return preview('D', 'TurnEnd', lengthIndex, undefined);
  }

  return preview('D', undefined, undefined, 'turn already completed for this length');
}

function nextAKind(config: RaceConfig, tags: readonly RaceTag[]): TagPreview {
  const lengthIndex = currentLengthIndex(config, tags);
  const lengthTags = tags.filter((tag) => tag.lengthIndex === lengthIndex);
  const alreadyTagged = firstTag(lengthTags, 'FifteenMetre');
  if (alreadyTagged !== undefined) {
    return preview('A', undefined, undefined, '15 m mark already tagged for this length');
  }

  const start = firstTag(tags, 'Start');
  if (start === undefined) {
    return preview('A', undefined, undefined, 'A is not legal before start');
  }

  return preview('A', 'FifteenMetre', lengthIndex, undefined);
}

export function createTagStateMachine(config: RaceConfig, initialTags: readonly RaceTag[] = []): RaceTagStateMachine {
  const committedTags: RaceTag[] = [...initialTags];

  return {
    nextS: () => nextSKind(config, committedTags),
    nextD: () => nextDKind(config, committedTags),
    nextA: () => nextAKind(config, committedTags),
    canPress: (key: OperatorKey) => {
      const currentPreview = key === 'S' ? nextSKind(config, committedTags) : key === 'D' ? nextDKind(config, committedTags) : nextAKind(config, committedTags);
      return currentPreview.status === 'available';
    },
    press: (key: OperatorKey, time: number) => {
      const currentPreview = key === 'S' ? nextSKind(config, committedTags) : key === 'D' ? nextDKind(config, committedTags) : nextAKind(config, committedTags);
      if (currentPreview.status === 'illegal' || currentPreview.kind === undefined) {
        return illegal(currentPreview.reason === undefined ? 'press is not legal' : currentPreview.reason);
      }

      const tag =
        currentPreview.lengthIndex === undefined
          ? { kind: currentPreview.kind, time }
          : { kind: currentPreview.kind, time, lengthIndex: currentPreview.lengthIndex };
      committedTags.push(tag);
      return tagged(tag);
    },
    undo: () => {
      const tag = committedTags.pop();
      if (tag === undefined) {
        return illegal('no tag to undo');
      }

      return tagged(tag);
    },
    tags: () => [...committedTags],
  };
}

export function validateRaceTags(config: RaceConfig, tags: readonly RaceTag[]): Problem[] {
  const problems: Problem[] = [];
  const computedLengthCount = raceLengthCount(config);
  if (!Number.isInteger(computedLengthCount) || Math.round(computedLengthCount) !== config.strokePerLength.length) {
    problems.push(
      problem(
        'LENGTH_COUNT_MISMATCH',
        'error',
        'raceDistance divided by pool length must match strokePerLength length',
      ),
    );
  }

  if (config.course === 'SCY' && !config.fifteenMetreReferenceConfirmed) {
    problems.push(
      problem(
        'FIFTEEN_METRE_UNAVAILABLE',
        'info',
        '15 m metrics are unavailable for SCY without a confirmed metric reference',
      ),
    );
  }

  for (let index = 1; index < tags.length; index += 1) {
    if (tags[index].time < tags[index - 1].time) {
      problems.push(problem('NON_MONOTONIC_TAGS', 'error', 'tag times must be monotonic by input order'));
      break;
    }
  }

  const segments = buildRaceSegments(config, tags);
  if (!segments.lengthsResolved) {
    problems.push(problem('LENGTHS_UNRESOLVED', 'error', 'length indexes cannot be re-derived from non-monotonic tag times'));
  }

  const resolvedTags = segments.allTags;
  const start = firstTag(resolvedTags, 'Start');
  const finish = firstTag(resolvedTags, 'Finish');
  if (start === undefined) {
    problems.push(problem('MISSING_START', 'error', 'start tag is required'));
  }

  if (finish === undefined) {
    problems.push(problem('MISSING_FINISH', 'error', 'finish tag is required'));
  } else if (finish.lengthIndex !== undefined && finish.lengthIndex !== segments.lengthCount) {
    problems.push(problem('FINISH_BEFORE_LAST_LENGTH', 'error', 'finish must be on the final length', finish.lengthIndex));
  }

  const flags = tagsOfKind(resolvedTags, 'Flags');
  for (const flag of flags) {
    if (flag.lengthIndex !== segments.lengthCount) {
      problems.push(problem('FLAGS_NOT_ON_FINAL_LENGTH', 'error', 'flags tag must be on the final length', flag.lengthIndex));
    }
    if (finish === undefined || flag.time >= finish.time) {
      problems.push(problem('FLAGS_AFTER_FINISH', 'error', 'flags tag must occur before finish', flag.lengthIndex));
    }
  }

  for (const length of segments.lengths) {
    const breakout = firstTag(length.tags, 'Breakout');
    if (breakout === undefined) {
      problems.push(problem('MISSING_BREAKOUT', 'warning', 'breakout tag is required for length metrics', length.lengthIndex));
    }

    const strokes = tagsOfKind(length.tags, 'Stroke');
    if (strokes.length < 2) {
      problems.push(problem('INSUFFICIENT_STROKE_TAGS', 'info', 'at least two stroke tags are required for stroke rate', length.lengthIndex));
    }

    if (breakout !== undefined) {
      const strokeBeforeBreakout = strokes.find((stroke) => stroke.time < breakout.time);
      if (strokeBeforeBreakout !== undefined) {
        problems.push(problem('STROKE_BEFORE_BREAKOUT', 'warning', 'stroke tag occurs before breakout', length.lengthIndex));
      }
    }

    const lengthStart =
      length.lengthIndex === 1
        ? start
        : firstTag(
            segments.lengths.find((candidate) => candidate.lengthIndex === length.lengthIndex - 1)?.tags ?? [],
            'TurnEnd',
          );
    for (const kick of tagsOfKind(length.tags, 'Kick')) {
      if (lengthStart === undefined || breakout === undefined || kick.time < lengthStart.time || kick.time > breakout.time) {
        problems.push(
          problem(
            'KICK_OUTSIDE_UNDERWATER',
            'warning',
            'kick tag must lie between the length start boundary and breakout',
            length.lengthIndex,
          ),
        );
      }
    }

    const turnStarts = tagsOfKind(length.tags, 'TurnStart');
    const turnEnds = tagsOfKind(length.tags, 'TurnEnd');
    if (length.lengthIndex === segments.lengthCount && (turnStarts.length > 0 || turnEnds.length > 0)) {
      problems.push(problem('TURN_ON_LAST_LENGTH', 'warning', 'turn tags are not expected on the final length', length.lengthIndex));
    }

    if (length.lengthIndex < segments.lengthCount && turnStarts.length !== turnEnds.length) {
      problems.push(problem('UNPAIRED_TURN', 'warning', 'turn start and turn end tags are not paired', length.lengthIndex));
    }

    const breakoutDistance = enteredDistanceForLength(config, length.lengthIndex);
    if (
      breakoutDistance !== undefined &&
      courseDistanceToMetres(breakoutDistance, config.course) > UNDERWATER_LEGAL_LIMIT_METRES
    ) {
      problems.push(
        problem(
          'BREAKOUT_EXCEEDS_15M',
          'warning',
          'entered breakout distance exceeds the legal 15 m underwater limit',
          length.lengthIndex,
        ),
      );
    }
  }

  for (const kick of tagsOfKind(resolvedTags, 'Kick')) {
    if (!segments.lengths.some((length) => length.lengthIndex === kick.lengthIndex)) {
      problems.push(
        problem(
          'KICK_OUTSIDE_UNDERWATER',
          'warning',
          'kick tag must lie on a configured length between its start boundary and breakout',
          kick.lengthIndex,
        ),
      );
    }
  }

  return problems;
}

export function proposeStandardImStrokeOrder(lengthCount: number): import('./types').ImProposal {
  const problems: Problem[] = [];
  if (lengthCount % 4 !== 0) {
    problems.push(
      problem(
        'IM_LENGTHS_NOT_DIVISIBLE',
        'warning',
        'standard IM stroke order requires a length count divisible by four',
      ),
    );
    return { strokePerLength: [], problems };
  }

  const quarter = lengthCount / 4;
  const strokePerLength = [
    ...Array(quarter).fill('fly'),
    ...Array(quarter).fill('back'),
    ...Array(quarter).fill('breast'),
    ...Array(quarter).fill('free'),
  ];

  return { strokePerLength, problems };
}

