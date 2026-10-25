/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the season progression chart says and where it draws, read from
 * `buildSeasonProgressions`. Nothing here measures a swim: it words each state
 * and turns seconds into coordinates.
 *
 * A gap is a `null`. It has no coordinates, no segment crosses it, and it is
 * never read as 0.
 */
import type {
  ProgressionEventOption,
  ProgressionMeet,
  SeasonProgressions,
  SwimmerProgression,
} from '@omniswim/core/lib/seasonAnalytics';

/** `100 Freestyle (SCY)`: the event picker's label for one option. */
export function progressionEventLabel(option: Pick<ProgressionEventOption, 'label' | 'course'>): string {
  const course = option.course === 'METRIC_UNSPECIFIED' ? 'meters' : option.course;
  return `${option.label} (${course})`;
}

/** Seconds, to the hundredth, with the unit: `0.70 seconds`. */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)} seconds`;
}

/**
 * The drop in plain words. `null` is one swim (nothing to compare yet), `0` is a
 * first swim that is still the best.
 */
export function describeDrop(dropSeconds: number | null): string {
  if (dropSeconds === null) return 'Only one swim so far, so no drop yet.';
  if (dropSeconds === 0) return 'No drop yet: the first swim is still the best.';
  return `Dropped ${formatSeconds(dropSeconds)} from the first swim to the best.`;
}

/** The one-line text alternative for one swimmer's small chart. */
export function describeSwimmerProgression(swimmer: SwimmerProgression, meets: readonly ProgressionMeet[]): string {
  const swims = `${swimmer.meetsSwum} of ${meets.length} ${meets.length === 1 ? 'meet' : 'meets'}`;
  if (swimmer.dropSeconds === null) {
    const at = meets[swimmer.firstIndex]?.label;
    return `${swimmer.name}: one swim, ${swimmer.firstTime}${at ? ` at ${at}` : ''}. No drop yet.`;
  }
  const best = meets[swimmer.bestIndex]?.label;
  const first = meets[swimmer.firstIndex]?.label;
  return (
    `${swimmer.name}: swam ${swims}. First swim ${swimmer.firstTime}${first ? ` at ${first}` : ''}, ` +
    `best ${swimmer.bestTime}${best ? ` at ${best}` : ''}. ${describeDrop(swimmer.dropSeconds)}`
  );
}

/** The note for rows whose time was not a number (DQ, no show, a typo), or `null` when none. */
export function describeUnreadableTimes(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? 'result' : 'results'} for this event had no readable time and ${count === 1 ? 'was' : 'were'} left out.`;
}

/** The note for meets where a swimmer swam the event twice (prelims and finals), or `null` when none. */
export function describeRepeatSwims(progressions: Pick<SeasonProgressions, 'swimmers'>): string | null {
  let count = 0;
  for (const s of progressions.swimmers) for (const p of s.points) if (p && p.swimsAtMeet > 1) count += 1;
  if (count === 0) return null;
  return `${count} ${count === 1 ? 'meet has' : 'meets have'} two swims of this event by one swimmer (prelims and finals). The faster swim is plotted.`;
}

export type SparkBox = { width: number; height: number; padX: number; padTop: number; padBottom: number };

export const SPARK_BOX: SparkBox = { width: 240, height: 76, padX: 12, padTop: 10, padBottom: 18 };

export type SparkMark = { x: number; y: number };

export type SparkGeometry = {
  /** One per meet, `null` where the swimmer has no time. */
  marks: (SparkMark | null)[];
  /** The x of every meet, for the meet numbers under the chart. */
  xs: number[];
  /** One path per run of consecutive meets with a time. A gap ends a run. A lone point has no path. */
  paths: string[];
};

/**
 * Where each point goes. The meets are evenly spaced, left to right. Higher
 * seconds sit higher, so a faster swim is a lower point and a drop reads as a
 * drop. The scale is this swimmer's own: it runs from their fastest to their
 * slowest time at this event.
 */
export function sparkGeometry(seconds: readonly (number | null)[], box: SparkBox = SPARK_BOX): SparkGeometry {
  const real = seconds.filter((s): s is number => s !== null);
  const lo = Math.min(...real);
  const hi = Math.max(...real);
  const plotWidth = box.width - box.padX * 2;
  const plotHeight = box.height - box.padTop - box.padBottom;
  const x = (i: number) =>
    seconds.length === 1 ? box.width / 2 : box.padX + (plotWidth * i) / (seconds.length - 1);
  const y = (s: number) => (hi === lo ? box.padTop + plotHeight / 2 : box.padTop + plotHeight * (1 - (s - lo) / (hi - lo)));

  const xs = seconds.map((_, i) => x(i));
  const marks = seconds.map((s, i) => (s === null ? null : { x: x(i), y: y(s) }));
  const paths: string[] = [];
  let run: SparkMark[] = [];
  const flush = () => {
    if (run.length > 1) paths.push(run.map((m, k) => `${k === 0 ? 'M' : 'L'}${m.x.toFixed(1)} ${m.y.toFixed(1)}`).join(' '));
    run = [];
  };
  for (const m of marks) {
    if (m === null) flush();
    else run.push(m);
  }
  flush();
  return { marks, paths, xs };
}
