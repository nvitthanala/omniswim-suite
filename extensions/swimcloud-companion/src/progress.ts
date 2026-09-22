/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure formatting for the crawl progress panel described in
 * `plans/2026-09-08/03-extension-crawler.md`'s "Progress and cancel"
 * section. Takes a plain state object, returns strings — no DOM, no timers,
 * so the exact text on the panel is a unit test rather than something only a
 * screenshot can confirm.
 */

import {
  crawlScopeFloorPagesPerTeam,
  crawlScopePlansPass,
  passesOutsideCrawlScope,
  scopePassesNeedingRenderedDom,
  type SwimCloudCrawlPass,
  type SwimCloudCrawlScope,
} from '@omniswim/swimcloud/crawlPlan';
import type { SwimCloudResumeDegradation } from './captureResume';

export type SwimCloudCrawlGenderLabel = 'Men' | 'Women';

/** `'M'`/`'F'` as the planner and parser write it, per gender label. */
export function genderLabelFor(gender: 'M' | 'F'): SwimCloudCrawlGenderLabel {
  return gender === 'M' ? 'Men' : 'Women';
}

export interface SwimCloudCrawlProgressState {
  /** 1-based index of the team currently being fetched. */
  readonly teamIndex: number;
  readonly teamCount: number;
  readonly gender: SwimCloudCrawlGenderLabel;
  /** 1-based page within this team+gender. */
  readonly page: number;
  /** Total pages known for this team+gender (at least 1). */
  readonly pageCountForTeamGender: number;
  /** Pages relayed so far, across the whole crawl. */
  readonly pagesDone: number;
  /** Total pages the plan currently expects, across the whole crawl. */
  readonly pagesTotal: number;
  /** The politeness delay between requests, for the ETA estimate. */
  readonly minDelayMs: number;
}

/** Line 1: `Team 3 of 4 · Women · page 5 of 8`. */
export function formatProgressLine1(state: SwimCloudCrawlProgressState): string {
  return `Team ${state.teamIndex} of ${state.teamCount} · ${state.gender} · page ${state.page} of ${state.pageCountForTeamGender}`;
}

/** Line 2: `41 of 66 pages · about 1 min left`. */
export function formatProgressLine2(state: SwimCloudCrawlProgressState): string {
  const remaining = Math.max(0, state.pagesTotal - state.pagesDone);
  return `${state.pagesDone} of ${state.pagesTotal} pages · ${formatEtaLabel(remaining, state.minDelayMs)}`;
}

/**
 * "about N min left" / "about N sec left" / "almost done" for the last page,
 * rounded up so the estimate never reads as finished before it is.
 */
export function formatEtaLabel(remainingPages: number, minDelayMs: number): string {
  if (remainingPages <= 0) {
    return 'done';
  }
  const remainingMs = remainingPages * minDelayMs;
  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) {
    return `about ${totalSeconds} sec left`;
  }
  const minutes = Math.ceil(totalSeconds / 60);
  return `about ${minutes} min left`;
}

/** Determinate progress-bar fraction in `[0, 1]`. `pagesTotal === 0` reads as 0, never `NaN`. */
export function progressFraction(pagesDone: number, pagesTotal: number): number {
  if (pagesTotal <= 0) return 0;
  return Math.min(1, Math.max(0, pagesDone / pagesTotal));
}

/**
 * The panel's resume line, shown as soon as the crawl finds a stored capture
 * for this subject — before team discovery, so a coach who restarts a crawl
 * sees immediately that the earlier one's pages survived.
 *
 * Returns `''` for a fresh crawl. The caller renders nothing for an empty
 * string rather than an empty row, so a first crawl's panel is unchanged.
 */
export function formatStoredCaptureLine(storedPageCount: number): string {
  if (storedPageCount <= 0) return '';
  const pages = storedPageCount === 1 ? '1 page' : `${storedPageCount} pages`;
  return `An earlier crawl of this meet already stored ${pages}. Those are not fetched again.`;
}

export interface SwimCloudCrawlResumeState {
  /** Planned pages this run is skipping because the store already holds their bytes. */
  readonly skippedPages: number;
  /** Pages in the whole plan. */
  readonly pagesTotal: number;
  /** Pages the store holds for this subject, whether or not they are in this plan. */
  readonly storedPageCount: number;
}

/**
 * The panel's resume line once the full plan is known and the skip set is
 * final: exactly how many planned pages this run does not have to fetch.
 *
 * The "page 1 is always re-read" sentence is not decoration. Page 1 of every
 * team+gender is re-fetched even when it is already stored, because a fresh
 * page 1 is the only thing that proves how many pages that team+gender has —
 * the stored page refs give a floor (the pages a previous run got to), never
 * the total, and planning against a floor would silently drop the pages past
 * it. Saying so on the panel is the difference between a coach seeing a
 * deliberate re-read and seeing the resume quietly not work.
 *
 * The third case is the one that would otherwise lie: pages are stored, but
 * none of them are in *this* plan (the coach unchecked the teams the earlier
 * crawl covered, say). Leaving the earlier "already stored N pages" line up
 * would claim a saving this run is not getting, so this replaces it with the
 * truth rather than clearing it and saying nothing.
 */
export function formatResumeSkipLine(state: SwimCloudCrawlResumeState): string {
  if (state.skippedPages > 0) {
    return `Resuming: ${state.skippedPages} of ${state.pagesTotal} planned pages are already captured and are not being fetched again. Page 1 of each team is always re-read, because only a fresh page 1 proves that team's page count.`;
  }
  if (state.storedPageCount > 0) {
    const stored =
      state.storedPageCount === 1 ? 'The 1 page stored for this meet is' : `The ${state.storedPageCount} pages stored for this meet are`;
    return `${stored} not in this plan. All ${state.pagesTotal} planned pages will be fetched.`;
  }
  return '';
}

/**
 * Why this run could not find out what is already stored.
 *
 * Returns `''` for `'none'` and for `'app-unreachable'`: the first is the
 * healthy case, and the second already has its own long-standing line on the
 * checklist (a crawl with the app closed simply shows no resume note). The
 * three that do speak are the ones that used to be invisible — a round trip
 * that timed out, a channel that failed, or a worker that answered with an
 * error. Those are exactly the states that previously froze the panel, so they
 * must now be readable on it.
 */
export function formatResumeDegradationLine(degradation: SwimCloudResumeDegradation): string {
  switch (degradation) {
    case 'timed-out':
      return 'Could not check what is already captured — the Omniswim app did not answer in time. Every page will be fetched.';
    case 'errored':
    case 'worker-error-reply':
      return 'Could not check what is already captured — the extension could not reach the Omniswim app. Every page will be fetched.';
    case 'unreadable-reply':
      return 'Could not read what is already captured — the reply was not a capture record this version understands. Every page will be fetched.';
    case 'app-unreachable':
      // This is the case a real 234-page crawl hit silently on 2026-09-09:
      // `app-unreachable` used to fall through to the empty-string default
      // below, so an unpaired extension gave no warning at all before every
      // single page fell back to a separate downloaded file. This is the one
      // degradation `runCrawl` also checks directly to gate the crawl behind
      // a "Continue anyway?" confirmation — see `awaitPairingConfirmation` in
      // `crawler-content.ts` — so this string doubles as that gate's message.
      return 'Not connected to the Omniswim app. Paste the pairing token from the app\'s startup banner into this extension\'s options page, then reload this page and try again — otherwise every page will be saved to your Downloads folder instead of the app.';
    default:
      return '';
  }
}

/**
 * The persistent note shown while any page in this crawl has fallen back to
 * `chrome.downloads` — live, not just in the final summary, so a coach
 * watching the panel sees this the moment it starts happening rather than
 * discovering it after the crawl finishes (or not at all, before 2026-09-09 —
 * see `relayFetchedPage`'s doc comment in `crawler-content.ts`).
 *
 * Empty string hides the row, matching every other `render*Note`/`renderWarning`
 * caller's "empty means hide" convention in this file's sibling `crawler-content.ts`.
 */
export function formatDownloadsFallbackNote(count: number): string {
  if (count === 0) return '';
  return `${count} page${count === 1 ? '' : 's'} saved to Downloads instead of the app so far — combined into one file when this crawl finishes.`;
}

/**
 * The final-summary line once the crawl is done, for whatever pages fell back
 * to `chrome.downloads`. `filename` is present only when `flushDownloads`
 * actually wrote a combined file; its absence with `count > 0` means the
 * flush itself failed, which is said explicitly rather than implied by a
 * missing filename.
 */
export function formatDownloadsFallbackSummary(count: number, filename: string | undefined): string {
  if (count === 0) return '';
  if (filename === undefined) {
    return `${count} page${count === 1 ? '' : 's'} were saved to Downloads instead of the app, but combining them into one file failed — check your Downloads folder for individual pages under omniswim-swimcloud-captures/.`;
  }
  return `${count} page${count === 1 ? '' : 's'} were saved to Downloads instead of the app (not connected/paired) — combined into one file: ${filename}. Pair the extension with the app and re-run to get these into the app directly.`;
}

/**
 * Pass 1 of the crawl: page 1 of every team+gender, read to learn each one's
 * page count before the full plan exists.
 *
 * This pass has its own progress state because it has its own denominator. It
 * is `teamCount × 2` pages long, and the real total is not knowable until it
 * ends. Rendering it against the eventual total would need a number that does
 * not exist yet; rendering nothing at all — which is what this panel used to do
 * — leaves the crawl looking dead for the full length of the pass. On a
 * thirteen-team meet that is twenty-six polite requests: at least seventy-eight
 * seconds of a completely static panel, which is indistinguishable from a hang.
 */
export interface SwimCloudCrawlPage1SweepState {
  /** 1-based index of the team currently being read. */
  readonly teamIndex: number;
  readonly teamCount: number;
  readonly gender: SwimCloudCrawlGenderLabel;
  /** First pages read so far in this pass. */
  readonly pagesDone: number;
  /** First pages in this pass — `teamCount × 2`. */
  readonly pagesTotal: number;
  readonly minDelayMs: number;
}

/** Line 1 during pass 1: `Pass 1 of 2 · page 1 of each team · Team 4 of 13 · Men`. */
export function formatPage1SweepLine1(state: SwimCloudCrawlPage1SweepState): string {
  return `Pass 1 of 2 · page 1 of each team · Team ${state.teamIndex} of ${state.teamCount} · ${state.gender}`;
}

/** Line 2 during pass 1: `7 of 26 first pages · about 1 min left · full page count known when this pass ends`. */
export function formatPage1SweepLine2(state: SwimCloudCrawlPage1SweepState): string {
  const remaining = Math.max(0, state.pagesTotal - state.pagesDone);
  return `${state.pagesDone} of ${state.pagesTotal} first pages · ${formatEtaLabel(remaining, state.minDelayMs)} · full page count known when this pass ends`;
}

/**
 * The line that explains the bar restarting when pass 2 begins.
 *
 * Pass 1's bar is a fraction of `teamCount × 2`; pass 2's is a fraction of the
 * real total, which is larger. Without this sentence the bar appears to jump
 * backwards for no reason — on a meet where pass 1 found 104 pages behind 26
 * first pages, from full to a quarter.
 */
export function formatPassTwoHeadline(pagesAlreadyRead: number, pagesTotal: number): string {
  return `Pass 2 of 2 · page counts known · ${pagesAlreadyRead} of ${pagesTotal} pages read so far`;
}

/* -------------------------------------------------------------------------- */
/* Pass 3: rosters                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The roster pass: `/team/{id}/roster/?gender=` for every confirmed team, both
 * genders, fetched at the same sequential 3 s pacing as the swims passes.
 *
 * It has its own denominator for the same reason pass 1 does — `teamCount × 2`
 * — and one thing pass 1 does not: it is also where the *next* pass's size is
 * discovered. Every roster read adds its swimmers to the list of swimmer-times
 * pages to fetch, and the total is unknown until the last roster is parsed. The
 * panel says the running count rather than implying a total it does not have.
 */
export interface SwimCloudCrawlRosterSweepState {
  /** 1-based index of the team whose roster is being read. */
  readonly teamIndex: number;
  readonly teamCount: number;
  readonly gender: SwimCloudCrawlGenderLabel;
  /** Roster pages read so far in this pass. */
  readonly pagesDone: number;
  /** Roster pages in this pass — `teamCount × 2`. */
  readonly pagesTotal: number;
  /** Distinct swimmers found across the rosters parsed so far. */
  readonly swimmersSoFar: number;
  readonly minDelayMs: number;
}

/** Line 1 during the roster pass: `Rosters · Team 4 of 13 · Men`. */
export function formatRosterSweepLine1(state: SwimCloudCrawlRosterSweepState): string {
  return `Rosters · Team ${state.teamIndex} of ${state.teamCount} · ${state.gender}`;
}

/**
 * Line 2 during the roster pass: `7 of 26 roster pages · about 1 min left ·
 * 118 swimmers so far, total known when this pass ends`.
 *
 * "so far" is load-bearing. This number grows as rosters are read and is not a
 * total until the pass finishes, so it is never printed as a denominator.
 */
export function formatRosterSweepLine2(state: SwimCloudCrawlRosterSweepState): string {
  const remaining = Math.max(0, state.pagesTotal - state.pagesDone);
  return `${state.pagesDone} of ${state.pagesTotal} roster pages · ${formatEtaLabel(remaining, state.minDelayMs)} · ${state.swimmersSoFar} swimmers so far, total known when this pass ends`;
}

/* -------------------------------------------------------------------------- */
/* Pass 4: swimmer times                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How the parsed rosters turned into a swimmer-times page count, said out loud
 * before the pass starts.
 *
 * A bare "412 swimmers" hides the two ways this number can be quietly wrong: a
 * roster row with no `/swimmer/{id}/` link yields no page, and the same swimmer
 * on two rosters yields one page rather than two. Both are normal; both change
 * the count away from "rows the rosters listed"; neither should have to be
 * inferred from a smaller-than-expected number on the panel.
 *
 * Returns `''` when nothing was dropped and nothing was deduplicated — the
 * common case, where the count needs no explanation.
 */
export function formatSwimmerTimesPlanLine(plan: {
  /** The planned pages. Only its length is read, so a test need not build URLs. */
  readonly steps: readonly unknown[];
  readonly rosterRowsSeen: number;
  readonly withoutSwimmerId: number;
  readonly duplicates: number;
}): string {
  const parts: string[] = [];
  if (plan.withoutSwimmerId > 0) {
    parts.push(
      `${plan.withoutSwimmerId} roster ${plan.withoutSwimmerId === 1 ? 'row carries' : 'rows carry'} no SwimCloud profile link, so ${plan.withoutSwimmerId === 1 ? 'that swimmer has' : 'those swimmers have'} no times page to fetch`,
    );
  }
  if (plan.duplicates > 0) {
    parts.push(`${plan.duplicates} listed on more than one roster and ${plan.duplicates === 1 ? 'is' : 'are'} fetched once`);
  }
  if (parts.length === 0) return '';
  return `${plan.steps.length} swimmer times pages from ${plan.rosterRowsSeen} roster rows: ${parts.join('; ')}.`;
}

/**
 * The swimmer-times pass, which is the one pass that runs several fetches at
 * once. See `../src/boundedFetchPool.ts` for why, and what it trades.
 */
export interface SwimCloudSwimmerTimesProgressState {
  /** Pages this run has finished fetching, whether or not the relay landed. */
  readonly fetched: number;
  /** Pages in this pass, including any skipped as already captured. */
  readonly total: number;
  /** Pages skipped because a previous crawl already stored them. */
  readonly alreadyCaptured: number;
  /** Pages that never reached the capture: a fetch that failed, or a relay that was lost. */
  readonly failed: number;
  /**
   * Pages SwimCloud answered with a non-2xx status.
   *
   * Counted separately from {@link failed} because the two mean different
   * things and only one of them is worth acting on. A 404 is SwimCloud saying
   * that swimmer has no times page — recorded in the capture as an outcome with
   * no bytes, which is a real answer. A lost relay is a page this run *had* and
   * could not file. Folding them together would let a coach read "0 not saved"
   * on a pass where a quarter of the swimmers came back 404.
   */
  readonly notServed: number;
  /** Simultaneous in-flight fetches this pass is allowed. */
  readonly concurrency: number;
  /** Minimum gap between the start of one fetch and the next. */
  readonly staggerMs: number;
}

/**
 * Line 1 during the swimmer-times pass: `Swimmer times: 143 of 412 fetched`,
 * with the two counts that would otherwise be invisible appended only when they
 * are non-zero.
 */
export function formatSwimmerTimesLine1(state: SwimCloudSwimmerTimesProgressState): string {
  const parts = [`Swimmer times: ${state.fetched} of ${state.total} fetched`];
  if (state.alreadyCaptured > 0) parts.push(`${state.alreadyCaptured} already captured`);
  if (state.notServed > 0) parts.push(`${state.notServed} not served by SwimCloud`);
  if (state.failed > 0) parts.push(`${state.failed} not saved`);
  return parts.join(' · ');
}

/**
 * Line 2 during the swimmer-times pass: `3 at a time, 400 ms apart · about 2
 * min left`.
 *
 * The pacing is on the panel rather than only in a doc comment, because this
 * pass behaves visibly differently from every other one — a coach watching the
 * Network tab should be able to see that the overlap is intended.
 *
 * The estimate is `remaining × staggerMs`, the pass's *rate floor*. Latency can
 * only make it slower, never faster, so this reads as an optimistic bound and
 * never as a finished pass that is still running.
 */
export function formatSwimmerTimesLine2(state: SwimCloudSwimmerTimesProgressState): string {
  const remaining = Math.max(0, state.total - state.alreadyCaptured - state.fetched);
  return `${state.concurrency} at a time, ${state.staggerMs} ms apart · ${formatEtaLabel(remaining, state.staggerMs)}`;
}

/* -------------------------------------------------------------------------- */
/* Pass 5: per-event results                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How the parsed swims lists turned into an event-page count, said out loud
 * before the pass starts.
 *
 * The number here is *much* smaller than the rows behind it, and a coach who is
 * not told why will read "42 events" against "1,240 swims" as a broken plan.
 * One event page holds every team's swimmers in that event, so a reference seen
 * a hundred times is still one page. Same shape as
 * {@link formatSwimmerTimesPlanLine}, and returns `''` when there is nothing to
 * explain.
 */
export function formatEventResultsPlanLine(plan: {
  /** The planned pages. Only its length is read, so a test need not build URLs. */
  readonly steps: readonly unknown[];
  readonly swimsSeen: number;
  readonly withoutEventRef: number;
  readonly duplicates: number;
  /** Steps that came from the meet's own event index. Absent on a swims-derived plan. */
  readonly fromEventIndex?: number;
}): string {
  // An event-first plan has no swims rows to explain, so every branch below is
  // empty and the coach would be shown nothing at all before a 3-minute pass.
  // Say where the list came from instead, and name the events the swims lists
  // would have missed, because "57 pages" against a 42-event program looks
  // wrong until you know the meet also ran time trials.
  const fromIndex = plan.fromEventIndex ?? 0;
  if (fromIndex > 0 && plan.swimsSeen === 0) {
    return `${plan.steps.length} event results pages, from the meet's own event index — every event it lists, diving and time trials included, not only the ones a team's swims list names.`;
  }

  const parts: string[] = [];
  if (fromIndex > 0) {
    parts.push(
      `${fromIndex} came from the meet's own event index, which names events no swims row does`,
    );
  }
  if (plan.withoutEventRef > 0) {
    parts.push(
      `${plan.withoutEventRef} ${plan.withoutEventRef === 1 ? 'swim carries' : 'swims carry'} no event link, so ${plan.withoutEventRef === 1 ? 'its round cannot' : 'their rounds cannot'} be resolved`,
    );
  }
  if (plan.duplicates > 0) {
    parts.push(`${plan.duplicates} swims share an event page already planned and are fetched once, not once per team`);
  }
  if (parts.length === 0) return '';
  return `${plan.steps.length} event results pages from ${plan.swimsSeen} swims: ${parts.join('; ')}.`;
}

/**
 * Line 1 during the event-results pass: `Event results: 12 of 42 fetched`.
 *
 * Reuses {@link SwimCloudSwimmerTimesProgressState} rather than cloning it: the
 * two pooled passes count exactly the same five things, and a second identical
 * type would be two definitions that agree only until one is edited. Line 2 is
 * {@link formatSwimmerTimesLine2}, which names no pass at all.
 */
export function formatEventResultsLine1(state: SwimCloudSwimmerTimesProgressState): string {
  const parts = [`Event results: ${state.fetched} of ${state.total} fetched`];
  if (state.alreadyCaptured > 0) parts.push(`${state.alreadyCaptured} already captured`);
  if (state.notServed > 0) parts.push(`${state.notServed} not served by SwimCloud`);
  if (state.failed > 0) parts.push(`${state.failed} not saved`);
  return parts.join(' · ');
}

export interface SwimCloudCrawlVolumeEstimate {
  readonly pages: number;
  readonly etaLabel: string;
}

/**
 * The pre-confirm volume estimate — same numbers as the design doc's
 * "Volume, stated plainly" table, computed from the real page counts known
 * after step 4 rather than a static guess.
 */
export function estimateCrawlVolume(pageCount: number, minDelayMs: number): SwimCloudCrawlVolumeEstimate {
  return { pages: pageCount, etaLabel: formatEtaLabel(pageCount, minDelayMs) };
}

/**
 * The sentence under the team checklist, before a single page is fetched.
 *
 * Four pages per team are known at this point and nothing else is: page 1 of
 * each gender's swims, and each gender's roster. Pages 2..N of a team's swims
 * are not known until page 1 is read, and the swimmer-times count is not known
 * until the rosters are read — so this is a **floor**, and it says so rather
 * than presenting a number a coach would reasonably read as the total.
 *
 * The alternative — quoting a confident single number computed from a team
 * count — is the version that gets a coach to click Start on what they think is
 * a four-minute job and then watch a twenty-minute one.
 */
export function formatCrawlVolumeFloorLine(teamCount: number, minDelayMs: number): string {
  const floor = estimateCrawlVolume(teamCount * 4, minDelayMs);
  return `${teamCount} teams · at least ${floor.pages} requests (page 1 of each team's swims and each team's roster, both genders), ${floor.etaLabel}. The rest is not knowable yet: extra swims pages appear once page 1 is read, and one page per rostered swimmer is added once the rosters are read.`;
}

/**
 * The same sentence, for a crawl the coach has narrowed to one job.
 *
 * Supersedes {@link formatCrawlVolumeFloorLine}, which is kept unchanged for
 * callers that have no scope to give. The difference is not cosmetic: a
 * meet-results crawl of a four-team meet plans neither of the two roster pages
 * per team nor any of the ~184 swimmer-times pages that follow them, and a line
 * still promising "one page per rostered swimmer" would be describing a crawl
 * that is not about to run. The estimate is the only place a coach sees the
 * cost of the choice before committing to it, so it has to move with the
 * choice.
 *
 * Still a **floor**, for exactly the reasons the older function documents, and
 * now per-scope: `meetEvent` and `swimmerTimes` contribute nothing to the
 * number because neither count exists until a swims list or a roster has been
 * parsed. What is unknown is named rather than guessed at.
 */
export function formatCrawlVolumeFloorLineForScope(
  teamCount: number,
  minDelayMs: number,
  scope: SwimCloudCrawlScope,
  knownEventCount = 0,
): string {
  // A meet that publishes its own event index turns the event pass from an
  // unknown into the one number this line can state exactly — and turns the
  // swims pass into nothing at all. Both halves matter: without the first the
  // estimate understates the crawl, and without the second it overstates it by
  // two pages per team, which is the saving event-first exists to deliver.
  const eventListKnown = knownEventCount > 0 && crawlScopePlansPass(scope, 'meetEvent');
  const perTeam = crawlScopeFloorPagesPerTeam(scope, { eventListAlreadyKnown: eventListKnown });
  const floor = estimateCrawlVolume(
    teamCount * perTeam + (eventListKnown ? knownEventCount : 0),
    minDelayMs,
  );

  const known: string[] = [];
  if (crawlScopePlansPass(scope, 'meetTeamSwims') && !eventListKnown) {
    known.push("page 1 of each team's swims");
  }
  if (eventListKnown) known.push(`all ${knownEventCount} of this meet's events`);
  if (crawlScopePlansPass(scope, 'teamRoster')) known.push("each team's roster");

  const unknown: string[] = [];
  if (crawlScopePlansPass(scope, 'meetTeamSwims') && !eventListKnown) {
    unknown.push('extra swims pages appear once page 1 is read');
  }
  if (crawlScopePlansPass(scope, 'meetEvent') && !eventListKnown) {
    unknown.push('one page per distinct event is added once the swims lists are read');
  }
  if (crawlScopePlansPass(scope, 'swimmerTimes')) {
    unknown.push('one page per rostered swimmer is added once the rosters are read');
  }

  const head =
    known.length === 0
      ? `${teamCount} teams · ${scope.label} · no structural pages to fetch up front`
      : `${teamCount} teams · ${scope.label} · at least ${floor.pages} requests (${known.join(' and ')}, both genders), ${floor.etaLabel}`;
  const tail =
    unknown.length === 0
      ? ' Nothing further is added to this plan.'
      : ` The rest is not knowable yet: ${unknown.join(', and ')}.`;

  const skipped = passesOutsideCrawlScope(scope);
  const skippedTail =
    skipped.length === 0 ? '' : ` Skipped by this scope: ${skipped.map(crawlPassLabel).join(', ')}.`;

  return `${head}.${tail}${skippedTail}`;
}

/** A pass named the way a coach would recognise it on the panel. */
export function crawlPassLabel(pass: SwimCloudCrawlPass): string {
  switch (pass) {
    case 'meetTeamSwims':
      return 'team swims at this meet';
    case 'meetEvent':
      return 'per-event round pages';
    case 'teamRoster':
      return 'team rosters';
    case 'swimmerTimes':
      return 'swimmer personal bests';
  }
}

/**
 * The one sentence that stays on the panel for the whole crawl: which job this
 * crawl is for, and which passes it therefore never asks SwimCloud for.
 *
 * Separate from {@link formatCrawlVolumeFloorLineForScope}, which is a
 * pre-flight estimate and disappears once fetching starts. This is the line a
 * coach reads an hour later, when the capture is done and holds no roster
 * pages, and has to be able to tell "the crawl never asked" from "this meet's
 * teams have no rosters". Naming the skipped passes is the whole content; a
 * scope that skips nothing says so rather than staying silent, because a blank
 * row is not a statement.
 */
export function formatCrawlScopeNote(scope: SwimCloudCrawlScope): string {
  const skipped = passesOutsideCrawlScope(scope);
  const declined = scopePassesNeedingRenderedDom(scope);

  const parts: string[] = [];
  if (skipped.length > 0) {
    parts.push(
      `not fetched by this crawl: ${skipped.map(crawlPassLabel).join(', ')}. ` +
        'The capture will hold none of those pages, because this crawl never asks for them.',
    );
  }
  // A pass the scope DID ask for, that a fetch cannot satisfy. Distinct from
  // "skipped", and the more important of the two to state: the coach chose it,
  // so silence here would read as a failed crawl rather than a known limit.
  if (declined.length > 0) {
    parts.push(
      `${declined.map(crawlPassLabel).join(', ')} cannot be fetched at all. ` +
        'That page builds its table in the browser, so a fetched copy contains no data. ' +
        'Capture those swimmers one at a time with the clipboard button instead.',
    );
  }
  if (parts.length === 0) {
    return `Scope: ${scope.label} — every pass is planned. Nothing is being skipped.`;
  }
  return `Scope: ${scope.label} — ${parts.join(' ')}`;
}
