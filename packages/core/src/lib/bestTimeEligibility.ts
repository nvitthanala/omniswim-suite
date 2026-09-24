/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two questions every reader that picks a best time must answer the same
 * way:
 *
 * 1. **May this swim be a best?** A time SwimCloud took out of a longer swim's
 *    splits (`X`, "Extracted") and a time someone typed in (`U`, "User
 *    Inputted") are not results. Neither is ever ranked, cut-tagged, entered
 *    or projected. {@link isRankableSwim} is the one test for that, and it
 *    reads both places the fact can live: the flags the SwimCloud JSON bridge
 *    sets, and the `swimcloudBadge` a pasted row carries. Every workspace
 *    stored before 2026-09-24 holds pasted rows with the badge and no flag.
 *
 * 2. **Do these two swims compete for the same best?** One event reaches this
 *    app under several labels: `'50 Free SCY'` (SwimCloud JSON),
 *    `'50 Freestyle'` (paste, CSV, theory), `'Event 8 Men 50 Yard Freestyle'`
 *    (HyTek). {@link swimEventIdentity} folds them to one key. Keying a best on
 *    the raw label gave one swimmer two bests, and two entries, for one event.
 *
 * Before this module each reader carried its own copy of question 1, and the
 * copies drifted: `categorizeBestEvents` excluded extracted splits while the
 * import, the theory, cross-course arbitrage and the history merge did not.
 *
 * This module sits at the bottom of the import graph (types and the
 * dependency-free event-name normalizer only), so `rosterCatalog.ts`,
 * `athleteHistory.ts` and `utils.ts` can all use it without a cycle.
 */

import type { HistoricalSwim, SwimCloudBadge } from '../types';
import { normalizeEventForCutline } from './cutlineEventNames';

/* -------------------------------------------------------------------------- */
/* May this swim be a best?                                                    */
/* -------------------------------------------------------------------------- */

/** The fields that say whether a swim is a result. */
export type BestTimeProvenance = Pick<
  HistoricalSwim,
  'isExtractedSplit' | 'isUserInputted' | 'swimcloudBadge'
>;

/**
 * Where a swim belongs when bests are picked.
 *
 * - `result` — a race at this distance. The only lane a best comes from.
 * - `extracted_split` — taken out of a longer swim's splits. May stand in for
 *   a relay leg when the swimmer has no standalone time at that distance.
 * - `user_inputted` — self-reported. Listed, never used for anything.
 */
export type BestTimeLane = 'result' | 'extracted_split' | 'user_inputted';

/**
 * The swim was taken out of a longer swim's splits (SwimCloud `X`).
 * True for the bridge's flag and for a pasted row's `'extracted'` badge.
 * See {@link HistoricalSwim.isExtractedSplit}.
 */
export function isExtractedSplitSwim(
  swim: Pick<HistoricalSwim, 'isExtractedSplit' | 'swimcloudBadge'>
): boolean {
  return swim.isExtractedSplit === true || swim.swimcloudBadge === 'extracted';
}

/**
 * The swim is self-reported (SwimCloud `U`), not a meet result. True for the
 * bridge's flag and for a pasted row's `'user_input'` badge. Such a swim is
 * never a best. See {@link HistoricalSwim.isUserInputted}.
 */
export function isUserInputtedSwim(
  swim: Pick<HistoricalSwim, 'isUserInputted' | 'swimcloudBadge'>
): boolean {
  return swim.isUserInputted === true || swim.swimcloudBadge === 'user_input';
}

/**
 * The lane a swim is picked in. A swim marked both ways is `user_inputted`:
 * a typed-in time is not a measured split, so it may not fill a relay leg.
 */
export function bestTimeLane(swim: BestTimeProvenance): BestTimeLane {
  if (isUserInputtedSwim(swim)) return 'user_inputted';
  if (isExtractedSplitSwim(swim)) return 'extracted_split';
  return 'result';
}

/**
 * The swim may be a best: ranked, cut-tagged, entered, projected. False for
 * an extracted split and for a self-reported time. An altitude-adjusted time
 * is still a best.
 */
export function isRankableSwim(swim: BestTimeProvenance): boolean {
  return bestTimeLane(swim) === 'result';
}

/* -------------------------------------------------------------------------- */
/* SwimCloud stamps as text                                                    */
/* -------------------------------------------------------------------------- */

/** What one pasted or stored SwimCloud stamp says about its swim. */
export type SwimCloudStampReading = {
  badge: SwimCloudBadge;
  /** The stamp carries the `X` ("Extracted") chip. */
  extractedSplit: boolean;
  /** The stamp carries the `U` ("User Inputted") chip. */
  userInputted: boolean;
};

const EXACT_STAMPS: Record<string, SwimCloudStampReading> = {
  x: { badge: 'extracted', extractedSplit: true, userInputted: false },
  extracted: { badge: 'extracted', extractedSplit: true, userInputted: false },
  u: { badge: 'user_input', extractedSplit: false, userInputted: true },
  user_input: { badge: 'user_input', extractedSplit: false, userInputted: true },
  b: { badge: 'd1_b', extractedSplit: false, userInputted: false },
  'd1-b': { badge: 'd1_b', extractedSplit: false, userInputted: false },
  'd1-a': { badge: 'd1_a', extractedSplit: false, userInputted: false },
  // A bare `A` is not a cut. SwimCloud's altitude chip is a bare `A` (title
  // "Altitude Adjusted" in the times JSON) and its cut chips name the division
  // (`D2 B`). But the paste has also printed cuts as bare letters (the Blaise
  // Vera fixture's `B`), so the text alone cannot prove which one a bare `A`
  // is. Recorded as a stamp of unknown meaning: no cut, and no altitude flag.
  a: { badge: 'other', extractedSplit: false, userInputted: false },
};

/**
 * Read one stamp as SwimCloud prints it in a pasted row, or as the roster
 * catalog stores it. Returns `null` for text that is not a stamp.
 *
 * SwimCloud prints a row's chips with no separator between them: an extracted
 * split of a relay leadoff reads `XR`, a self-reported leadoff `UR`. A token
 * made only of the single-letter chips `X`, `U` and `R`, each at most once, is
 * read chip by chip. A cut label with a chip appended (`D2 BR`, `NCSAX`) is not
 * decoded: cut names end in those letters too (`FTR-18U`), so the split point
 * is not provable.
 */
export function readSwimCloudStamp(raw: string | null | undefined): SwimCloudStampReading | null {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return null;
  const exact = EXACT_STAMPS[key];
  if (exact) return { ...exact };
  if (/^d1-?[ab]$/.test(key)) {
    return { badge: key.endsWith('a') ? 'd1_a' : 'd1_b', extractedSplit: false, userInputted: false };
  }
  if (/^(r|rcon|pb)$/.test(key)) return { badge: 'other', extractedSplit: false, userInputted: false };
  if (/^[xur]{2,3}$/.test(key) && new Set(key).size === key.length) {
    const extractedSplit = key.includes('x');
    const userInputted = key.includes('u');
    const badge: SwimCloudBadge = userInputted ? 'user_input' : 'extracted';
    return { badge, extractedSplit, userInputted };
  }
  return null;
}

/**
 * The {@link BestTimeLane} of a time known only by its stored stamp (the
 * roster catalog's free-text `swimcloudBadge`). Same precedence as
 * {@link bestTimeLane}. An absent or unrecognized stamp is a `result`.
 */
export function bestTimeLaneOfStamp(stamp: string | null | undefined): BestTimeLane {
  const reading = readSwimCloudStamp(stamp);
  if (reading?.userInputted) return 'user_inputted';
  if (reading?.extractedSplit) return 'extracted_split';
  return 'result';
}

/**
 * A stored stamp allows the time to be a best. False for `X`/`U` in either
 * vocabulary and for a concatenated chip token that carries one.
 */
export function isRankableSwimCloudStamp(stamp: string | null | undefined): boolean {
  return bestTimeLaneOfStamp(stamp) === 'result';
}

/* -------------------------------------------------------------------------- */
/* Do these two swims compete for the same best?                               */
/* -------------------------------------------------------------------------- */

const TIME_TRIAL = /\btime\s+trials?\b/i;

/**
 * The key that decides which swims compete for one best: the published event
 * name (`normalizeEventForCutline`), lower-cased.
 *
 * Course is not part of it. A caller that picks bests per course keys on the
 * course as well; a caller that picks SCY bests has already stated every swim
 * in yards.
 *
 * A time trial keeps its own identity. It is swum at the meet but it is not
 * the program event, so a time-trial result never occupies the event.
 *
 * Never a display label. Show the label the swim was recorded with.
 */
export function swimEventIdentity(event: string): string {
  const raw = String(event ?? '').replace(/\s+/g, ' ').trim();
  const canonical = normalizeEventForCutline(raw) || raw;
  return `${canonical}${TIME_TRIAL.test(raw) ? ' time trial' : ''}`.toLowerCase();
}

/** Both labels name the same event. See {@link swimEventIdentity}. */
export function isSameSwimEvent(a: string, b: string): boolean {
  return swimEventIdentity(a) === swimEventIdentity(b);
}
