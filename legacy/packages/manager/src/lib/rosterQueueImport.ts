/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two halves of a SwimCloud roster import, extracted so exactly one
 * implementation of each exists.
 *
 * 1. **Seed a queue from a roster parse** — {@link seedRosterQueueFromAthletes}.
 * 2. **Convert one swimmer's times and check them off that queue** —
 *    {@link convertAndAccountSwimmerTimes} plus {@link markRosterQueueCaptured}.
 *
 * Both halves lived inline in `RosterImportWizard.tsx`'s
 * `handleClipboardTeamRoster` / `handleClipboardSwimmerTimes` until 2026-09-09,
 * when a second caller arrived: `SwimCloudCaptureRosterImportPanel.tsx` runs
 * the same two steps against an already-completed browser-extension capture,
 * once per athlete, in one action instead of one clipboard paste per swimmer.
 *
 * They were extracted rather than copied. This session has already found and
 * corrected the same duplication twice (two crawl-plan URL builders, two
 * capture-id derivations) and the lesson was identical each time: two copies
 * agree only by construction, and they stop agreeing the first time one of them
 * changes. The roster-queue matching rule below is exactly the kind of thing
 * that changes — it was rewritten once already, on 2026-09-09, for a real
 * name-order bug (see {@link rosterQueueEntryMatches}).
 *
 * Nothing here touches React state, `fetch`, or the clipboard. Every function
 * is a pure transform over parsed SwimCloud data, so both callers can be tested
 * against the same real fixtures.
 */

import type { Gender, HistoricalSwim } from '@omniswim/core/types';
import { canonicalSwimmerName, foldDiacritics, normalizeSwimmerName } from '@omniswim/core/lib/utils';
// Imported from the ./entities and ./parser subpaths, never the
// @omniswim/swimcloud package root — see `swimCloudImportBridge.ts`'s file
// header for why (the root re-exports Node-only fetcher/cache code this UI
// package must not pull into its bundle).
import type { SwimCloudAthlete } from '@omniswim/swimcloud/entities';
import type { SwimCloudRosterParse, SwimCloudSwimmerTimesParse } from '@omniswim/swimcloud/parser';
import { swimCloudSwimmerTimesToHistoricalSwims } from './swimCloudImportBridge';
import {
  diffSwimCloudPersonalBests,
  existingSwimCloudHistoryFor,
  type SwimCloudEventImprovement,
  type SwimCloudSwimmerImprovements,
} from './swimCloudImprovementDiff';

/* -------------------------------------------------------------------------- */
/* The queue                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One name from a captured team-roster page, tracked across a sequence of
 * subsequent swimmer-times captures.
 *
 * Why a checklist and not an automatic pull: a SwimCloud roster page carries
 * names and class years, never times, and Track A cannot auto-navigate to each
 * swimmer's page (that would be Track B). So the roster becomes something a
 * coach works through — either one "Copy for Omniswim" click per swimmer, or,
 * when the browser extension has already crawled the whole team,
 * `SwimCloudCaptureRosterImportPanel` checking every athlete off at once from
 * that capture. Both paths mark entries through {@link markRosterQueueCaptured}.
 */
export interface RosterQueueEntry {
  readonly swimCloudSwimmerId?: string;
  readonly name: string;
  readonly captured: boolean;
}

export interface RosterQueue {
  readonly teamLabel: string;
  readonly entries: readonly RosterQueueEntry[];
}

/**
 * Matches a captured swimmer-times page back to a roster-queue entry: id first
 * (exact), name as a fallback (a roster row with no profile link has no id to
 * match by).
 *
 * The name fallback folds through `canonicalSwimmerName`, not
 * `normalizeSwimmerName`. That matters as of 2026-09-09: the two pages spell
 * one swimmer two ways. A roster page prints display order (`'Katie Batts'`),
 * and `/swimmer/{id}/times/`'s `#swimmer-info` prints family name first
 * (`'Batts, Katie'`) — see `parseSwimmerTimesHtml`'s "One name, one source"
 * note on why neither is rewritten into the other at the parser. Comparing the
 * raw normalized forms would therefore never match across those two sources,
 * and this fallback would silently stop checking swimmers off the queue.
 * `canonicalSwimmerName` folds `"Last, First"` to `"first last"` and otherwise
 * behaves exactly as `normalizeSwimmerName`, so it cannot break a pair that
 * matched before.
 *
 * It is still only a fallback: a middle initial the roster page omits
 * (`'Paulk, River J'` against `'River Paulk'`) does not fold away, and nothing
 * here guesses past that. Every athlete on the real roster capture carries a
 * swimmer id, so the id branch above is what answers in practice.
 */
export function rosterQueueEntryMatches(
  entry: RosterQueueEntry,
  swimmerId: string | undefined,
  name: string | undefined,
): boolean {
  if (entry.swimCloudSwimmerId !== undefined && swimmerId !== undefined) {
    return entry.swimCloudSwimmerId === swimmerId;
  }
  if (name === undefined) return false;
  return foldDiacritics(canonicalSwimmerName(entry.name)) === foldDiacritics(canonicalSwimmerName(name));
}

/* -------------------------------------------------------------------------- */
/* Half one — seed a queue from a roster parse                                 */
/* -------------------------------------------------------------------------- */

export interface SeedRosterQueueOptions {
  /**
   * Every name already on this workspace's roster for the team and gender being
   * imported into — `rosterNamesForTeam(workspace, team, gender)`.
   *
   * Used only to split {@link RosterQueueSeed.newAthletes} out of the roster;
   * it never removes anybody from the queue. A swimmer already in the workspace
   * still needs their times captured, so they still get a checklist entry —
   * they are just not announced as a new arrival.
   */
  readonly existingRosterNames: readonly string[];
}

export interface RosterQueueSeed {
  /** Every athlete the roster page named, in page order, none captured yet. */
  readonly queue: RosterQueue;
  /** The subset whose name is not already on the workspace roster for this team and gender. */
  readonly newAthletes: readonly SwimCloudAthlete[];
  /** Every athlete the roster page named — `queue.entries.length`, named for readability at call sites. */
  readonly totalCount: number;
}

/**
 * Turn one roster parse's athletes into a fresh checklist, and say which of
 * them the workspace has not seen before.
 *
 * The "already here?" test is `foldDiacritics(normalizeSwimmerName(name))` on
 * both sides — the same key the clipboard path has used since this feature
 * shipped. It is deliberately *not* `canonicalSwimmerName`: this compares a
 * roster page's display-order name against the workspace's own display-order
 * names, so there is no `"Last, First"` form to fold, and widening the key here
 * would change which swimmers a coach is told are new.
 */
export function seedRosterQueueFromAthletes(
  teamLabel: string,
  athletes: readonly SwimCloudAthlete[],
  options: SeedRosterQueueOptions,
): RosterQueueSeed {
  const existingNames = new Set(
    options.existingRosterNames.map(name => foldDiacritics(normalizeSwimmerName(name))),
  );
  const newAthletes = athletes.filter(
    a => !existingNames.has(foldDiacritics(normalizeSwimmerName(a.name))),
  );

  return {
    queue: {
      teamLabel,
      entries: athletes.map(a => ({
        swimCloudSwimmerId: a.swimCloudSwimmerId,
        name: a.name,
        captured: false,
      })),
    },
    newAthletes,
    totalCount: athletes.length,
  };
}

/**
 * The sentence the clipboard path and the capture path both print after seeding
 * a queue. Kept next to the seeding function so the two paths cannot drift into
 * describing the same fact two different ways.
 */
export function describeNewAthletes(seed: RosterQueueSeed): string {
  const { newAthletes } = seed;
  if (newAthletes.length === 0) return 'all already in this workspace.';
  const shown = newAthletes
    .slice(0, 6)
    .map(a => a.name)
    .join(', ');
  return `${newAthletes.length} not yet in this workspace: ${shown}${
    newAthletes.length > 6 ? `, +${newAthletes.length - 6} more` : ''
  }.`;
}

/* -------------------------------------------------------------------------- */
/* Half two — convert one swimmer, and check them off                          */
/* -------------------------------------------------------------------------- */

/** What identifies the swimmer a times parse belongs to, for {@link markRosterQueueCaptured}. */
export interface RosterQueueMatchKey {
  readonly swimmerId?: string;
  readonly name?: string;
}

/**
 * Turn a reason-to-count tally into the lines a coach reads.
 *
 * One formatter, used by the single-swimmer path (which tallies one swimmer)
 * and by the bulk path (which tallies a whole roster into one line per reason
 * rather than printing the same sentence once per swimmer).
 */
export function formatSkipWarnings(skippedByReason: ReadonlyMap<string, number>): string[] {
  return [...skippedByReason.entries()].map(
    ([reason, count]) => `${count} row(s) skipped — ${reason.replace(/-/g, ' ')}.`,
  );
}

export interface SwimmerTimesAccounting {
  readonly ok: true;
  /** The importable individual swims, ready to accumulate into a preview. */
  readonly swims: readonly HistoricalSwim[];
  /** One de-duplicated line per skip reason, in the wording a coach reads. */
  readonly skipWarnings: readonly string[];
  /** The same tally `skipWarnings` was formatted from, so a caller importing many swimmers can aggregate before formatting. */
  readonly skippedByReason: ReadonlyMap<string, number>;
  /** Rows the converter refused — no readable time, or a relay leadoff split. */
  readonly skippedCount: number;
  /** How to find this swimmer on the roster queue. */
  readonly match: RosterQueueMatchKey;
  /** The name the page printed, verbatim — family name first. Absent when the page named nobody. */
  readonly name?: string;
  /**
   * Events this capture improved on what the workspace already stored for
   * this swimmer — see `swimCloudImprovementDiff.ts`. Empty when
   * `ConvertSwimmerTimesOptions.existingHistory` was not supplied, or when
   * nothing improved.
   */
  readonly improvements: readonly SwimCloudEventImprovement[];
}

export interface SwimmerTimesAccountingFailure {
  readonly ok: false;
  /**
   * Why nothing could be imported for this swimmer, in the wording a coach
   * reads. The clipboard path shows it as a toast; the bulk path records it as
   * one line of the import warnings and leaves the swimmer unchecked.
   */
  readonly message: string;
  readonly reason: 'missing-swimmer-name' | 'no-usable-times';
  readonly match: RosterQueueMatchKey;
}

export type SwimmerTimesAccountingResult = SwimmerTimesAccounting | SwimmerTimesAccountingFailure;

export interface ConvertSwimmerTimesOptions {
  /** The workspace team these swims are imported under. Never read from the page — a bests table names meets, not the swimmer's own team. */
  readonly team: string;
  /** The workspace gender these swims are imported under. Never inferred — `/swimmer/{id}/times/` states no gender for a swim. */
  readonly gender: Gender;
  /** When the capture was taken. Stamped on every imported swim. */
  readonly retrievedAt?: string;
  /**
   * The workspace's full stored history (`workspace.athleteHistory`), for the
   * "who improved" diff — see `swimCloudImprovementDiff.ts`. Additive: when
   * omitted, `SwimmerTimesAccounting.improvements` is always empty, exactly
   * the behavior before this option existed.
   */
  readonly existingHistory?: readonly HistoricalSwim[];
}

/**
 * Convert one `/swimmer/{id}/times/` parse into importable swims, and report
 * everything a caller needs to account for it: what was skipped and why, and
 * which roster-queue entry it belongs to.
 *
 * The match key comes from `parse.swimCloudSwimmerId`, which is the same id the
 * clipboard path used to pass separately: `parseSwimmerTimesHtml`'s
 * `options.swimmerId` outranks both the page's `#swimmer-info` block and the
 * capture URL (see that option's own doc comment), so when the clipboard path
 * supplies the URL's id, the parse carries that exact id back out. One source,
 * not two.
 *
 * A swimmer with no usable rows is a failure, not an empty success: "no times
 * imported" and "this page had nothing importable" are different answers, and
 * collapsing them is the silent-empty failure `CLAUDE.md` names as the top risk
 * here.
 */
export function convertAndAccountSwimmerTimes(
  parse: SwimCloudSwimmerTimesParse,
  options: ConvertSwimmerTimesOptions,
): SwimmerTimesAccountingResult {
  const match: RosterQueueMatchKey = {
    swimmerId: parse.swimCloudSwimmerId,
    name: parse.name,
  };

  const conversion = swimCloudSwimmerTimesToHistoricalSwims(parse, {
    team: options.team.trim(),
    gender: options.gender,
    ...(options.retrievedAt === undefined ? {} : { retrievedAt: options.retrievedAt }),
  });
  if (!conversion.ok) {
    return { ok: false, message: conversion.message, reason: 'missing-swimmer-name', match };
  }
  if (conversion.swims.length === 0) {
    return {
      ok: false,
      message: `No usable individual-event times found on that page (${conversion.skipped.length} row(s) skipped — no readable time, or a relay leadoff split rather than an individual swim).`,
      reason: 'no-usable-times',
      match,
    };
  }

  const skippedByReason = new Map<string, number>();
  for (const row of conversion.skipped) {
    skippedByReason.set(row.reason, (skippedByReason.get(row.reason) ?? 0) + 1);
  }

  const improvements =
    options.existingHistory !== undefined && parse.name !== undefined
      ? diffSwimCloudPersonalBests(
          existingSwimCloudHistoryFor(options.existingHistory, parse.name, options.team.trim(), options.gender),
          conversion.swims,
        )
      : [];

  return {
    ok: true,
    swims: conversion.swims,
    skipWarnings: formatSkipWarnings(skippedByReason),
    skippedByReason,
    skippedCount: conversion.skipped.length,
    match,
    improvements,
    ...(parse.name === undefined ? {} : { name: parse.name }),
  };
}

/**
 * Check one swimmer off the queue.
 *
 * Marks at most one entry, the first that {@link rosterQueueEntryMatches}
 * accepts — a roster can legitimately hold two swimmers whose names fold
 * together, and checking both off from one capture would claim times for a
 * swimmer nothing was captured for.
 *
 * `matchedNew` is false when the entry was already captured, so a caller can
 * tell "this is progress" from "this swimmer was captured twice".
 */
export function markRosterQueueCaptured(
  queue: RosterQueue,
  match: RosterQueueMatchKey,
): { readonly queue: RosterQueue; readonly matchedNew: boolean } {
  let matched = false;
  let matchedNew = false;
  const entries = queue.entries.map(entry => {
    if (!matched && rosterQueueEntryMatches(entry, match.swimmerId, match.name)) {
      matched = true;
      matchedNew = !entry.captured;
      return { ...entry, captured: true };
    }
    return entry;
  });
  return { queue: { ...queue, entries }, matchedNew };
}

/* -------------------------------------------------------------------------- */
/* Both halves together — a whole roster out of one completed capture          */
/* -------------------------------------------------------------------------- */

/**
 * One roster athlete beside the swimmer-times page this capture holds for them,
 * or nothing when the crawl never fetched that swimmer.
 */
export interface RosterTimesPairing {
  readonly entry: RosterQueueEntry;
  /** Absent when no stored swimmer-times page matches this athlete — a real, expected state, not an error. */
  readonly parse?: SwimCloudSwimmerTimesParse;
}

/**
 * Pair every roster athlete with the swimmer-times page belonging to them,
 * using {@link rosterQueueEntryMatches} — id first, folded name second.
 *
 * **Each times page is consumed at most once.** Two athletes whose names fold
 * together (and who carry no profile link to separate them) must not both
 * receive the same swimmer's times: that would import one swimmer's swims under
 * two names. The second athlete stays unpaired, which is the honest answer —
 * the capture holds nothing for them.
 *
 * This is the single pairing rule. The panel's "N of M athletes have captured
 * times" line and the import that follows it both read it, so the number a
 * coach sees before committing is the number they get.
 */
export function pairRosterWithSwimmerTimes(
  entries: readonly RosterQueueEntry[],
  swimmerTimes: readonly SwimCloudSwimmerTimesParse[],
): RosterTimesPairing[] {
  const consumed = new Set<number>();
  return entries.map(entry => {
    const index = swimmerTimes.findIndex(
      (parse, i) => !consumed.has(i) && rosterQueueEntryMatches(entry, parse.swimCloudSwimmerId, parse.name),
    );
    if (index === -1) return { entry };
    consumed.add(index);
    return { entry, parse: swimmerTimes[index] };
  });
}

/** What a capture actually covers of one roster — counted, never estimated. */
export interface RosterCaptureCoverage {
  readonly rosterAthleteCount: number;
  /** Athletes this capture holds a swimmer-times page for. */
  readonly withCapturedTimes: number;
  /** Athletes it does not — they stay on the queue for a manual "Copy for Omniswim" capture. */
  readonly withoutCapturedTimes: number;
}

/**
 * How much of a roster a capture covers, computed the same way the import will.
 *
 * Shown before the coach commits. It counts pages that exist; it never claims a
 * page exists because the crawl planned one, and it never rounds a partial
 * crawl up to "the whole team" — the same honest-completeness discipline
 * `SwimCloudCapturePicker.describeCompleteness` applies to a capture as a whole.
 */
export function rosterCaptureCoverage(
  athletes: readonly SwimCloudAthlete[],
  swimmerTimes: readonly SwimCloudSwimmerTimesParse[],
): RosterCaptureCoverage {
  const entries: RosterQueueEntry[] = athletes.map(a => ({
    swimCloudSwimmerId: a.swimCloudSwimmerId,
    name: a.name,
    captured: false,
  }));
  const paired = pairRosterWithSwimmerTimes(entries, swimmerTimes).filter(p => p.parse !== undefined).length;
  return {
    rosterAthleteCount: athletes.length,
    withCapturedTimes: paired,
    withoutCapturedTimes: athletes.length - paired,
  };
}

/**
 * Everything `RosterImportWizard` needs to apply one bulk roster import, in one
 * object.
 *
 * The panel that builds this owns no workspace state — the same division of
 * labour `SwimCloudCapturePicker` keeps with `OpsModule`: the panel computes,
 * the wizard sets its own state. The first three fields are exactly the three
 * the clipboard path produces across one roster capture plus N swimmer captures
 * (`setRosterQueue`, `setPreview`, `setWarnings`), computed in one pass instead.
 */
export interface SwimCloudCaptureRosterImport {
  /** For `setRosterQueue` — every roster athlete, those with captured times already checked off. */
  readonly rosterQueue: RosterQueue;
  /** For `setPreview` — every matched swimmer's importable swims, in roster order. */
  readonly swims: readonly HistoricalSwim[];
  /** For `setWarnings` — gender mismatch first, then per-swimmer refusals, then the roster-wide skip tally. */
  readonly warnings: readonly string[];
  /** The team name the roster page printed, falling back to the team the wizard is importing under. */
  readonly teamLabel: string;
  readonly coverage: RosterCaptureCoverage;
  /** Athletes whose times converted to at least one swim. Never larger than `coverage.withCapturedTimes`. */
  readonly importedSwimmerCount: number;
  /** Roster athletes whose name is not already on this workspace's roster for this team and gender. */
  readonly newAthleteCount: number;
  /** True when the roster page states a gender this wizard is not scoped to. See {@link buildRosterImportFromCapture}. */
  readonly genderMismatch: boolean;
  /** One line for the success toast. */
  readonly summary: string;
  /**
   * Every swimmer this capture improved on, against what the workspace
   * already stored for them — empty when `BuildRosterImportOptions.existingHistory`
   * was not supplied, or when nothing improved. See `swimCloudImprovementDiff.ts`.
   */
  readonly improvements: readonly SwimCloudSwimmerImprovements[];
  /** `improvements.reduce((n, s) => n + s.improvements.length, 0)` — kept alongside so a caller doesn't recompute it. */
  readonly improvedEventCount: number;
}

export interface BuildRosterImportOptions {
  /** The roster page this import is built from — its own parse, straight from the capture. */
  readonly roster: SwimCloudRosterParse;
  /** Every swimmer-times page the same capture holds. A page belonging to another team simply never pairs. */
  readonly swimmerTimes: readonly SwimCloudSwimmerTimesParse[];
  /** The workspace team being imported into. */
  readonly team: string;
  /** The workspace gender being imported into. */
  readonly gender: Gender;
  /** `rosterNamesForTeam(workspace, team, gender)` — see {@link SeedRosterQueueOptions.existingRosterNames}. */
  readonly existingRosterNames: readonly string[];
  /**
   * The workspace's full stored history (`workspace.athleteHistory`), for the
   * "who improved" diff. Additive: when omitted, `improvements` is always
   * empty, exactly the behavior before this option existed.
   */
  readonly existingHistory?: readonly HistoricalSwim[];
}

/**
 * Run both halves over a whole roster: seed the queue once, then convert and
 * check off every athlete the capture holds times for.
 *
 * ## Gender
 *
 * The roster page states its own gender and `parseTeamRosterHtml` reads it from
 * the printed heading; this wizard states the gender its workspace is scoped
 * to. Neither overrules the other silently. The swims are recorded under the
 * **wizard's** gender, because that is what
 * `swimCloudSwimmerTimesToHistoricalSwims` documents its `gender` option to
 * mean, and because a `/swimmer/{id}/times/` page states no gender per swim to
 * contradict it — but a disagreement becomes the first warning and sets
 * {@link SwimCloudCaptureRosterImport.genderMismatch}, so the panel can say so
 * before the coach commits. That is the treatment `parseTeamRosterHtml` already
 * gives a caller-supplied gender it disagrees with: report it, never resolve it
 * quietly.
 *
 * ## Nothing is invented for an athlete the crawl missed
 *
 * An athlete with no matching swimmer-times page keeps `captured: false` and
 * contributes no swims — exactly the state the manual clipboard path leaves
 * them in. The existing "Capture next swimmer" button is still how they get
 * filled in.
 */
export function buildRosterImportFromCapture(
  options: BuildRosterImportOptions,
): SwimCloudCaptureRosterImport {
  const { roster, swimmerTimes, team, gender, existingRosterNames, existingHistory } = options;
  const trimmedTeam = team.trim();
  const teamLabel = roster.teamName ?? trimmedTeam;

  const seed = seedRosterQueueFromAthletes(teamLabel, roster.athletes, { existingRosterNames });

  const genderMismatch = roster.gender !== undefined && (roster.gender as string) !== (gender as string);
  const warnings: string[] = [];
  if (genderMismatch) {
    warnings.push(
      `This capture's roster is ${roster.gender}; this importer is scoped to ${gender}. Every swim below is recorded as ${gender}.`,
    );
  }

  const pairings = pairRosterWithSwimmerTimes(seed.queue.entries, swimmerTimes);

  let queue = seed.queue;
  const swims: HistoricalSwim[] = [];
  const refusals: string[] = [];
  const skippedByReason = new Map<string, number>();
  const swimmerImprovements: SwimCloudSwimmerImprovements[] = [];
  let importedSwimmerCount = 0;

  for (const { entry, parse } of pairings) {
    if (parse === undefined) continue;
    // The times JSON (`parseSwimmerFastestTimesJson`) names no swimmer. When
    // the pairing was an id match, the roster row's name is the same swimmer's
    // name from a page the same capture holds -- an id join, not a guess.
    const named =
      parse.name === undefined &&
      entry.swimCloudSwimmerId !== undefined &&
      entry.swimCloudSwimmerId === parse.swimCloudSwimmerId
        ? { ...parse, name: entry.name }
        : parse;
    const accounted = convertAndAccountSwimmerTimes(named, { team: trimmedTeam, gender });
    if (!accounted.ok) {
      // Graceful degradation, one swimmer at a time: a page that converted to
      // nothing leaves that athlete unchecked and says why, rather than taking
      // the whole roster import down with it.
      refusals.push(`${entry.name}: ${accounted.message}`);
      continue;
    }
    swims.push(...accounted.swims);
    for (const [reason, count] of accounted.skippedByReason) {
      skippedByReason.set(reason, (skippedByReason.get(reason) ?? 0) + count);
    }
    queue = markRosterQueueCaptured(queue, accounted.match).queue;
    importedSwimmerCount += 1;

    if (existingHistory !== undefined) {
      // The roster page's own name — never `accounted`'s, which may carry
      // the times page's family-first order — since it is guaranteed present
      // and is exactly the name `existingRosterNames`/the workspace roster
      // already spells this swimmer with.
      const priorSwims = existingSwimCloudHistoryFor(existingHistory, entry.name, trimmedTeam, gender);
      const improvements = diffSwimCloudPersonalBests(priorSwims, accounted.swims);
      if (improvements.length > 0) {
        swimmerImprovements.push({ name: entry.name, improvements });
      }
    }
  }

  warnings.push(...refusals, ...formatSkipWarnings(skippedByReason));

  const coverage = rosterCaptureCoverage(roster.athletes, swimmerTimes);
  const stillManual = coverage.rosterAthleteCount - importedSwimmerCount;
  const summary = [
    `${teamLabel}: imported ${swims.length} swim(s) for ${importedSwimmerCount} of ${coverage.rosterAthleteCount} roster swimmer(s).`,
    stillManual > 0 ? `${stillManual} still need a "Copy for Omniswim" capture from their Times tab.` : undefined,
    describeNewAthletes(seed),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  return {
    rosterQueue: queue,
    swims,
    warnings,
    teamLabel,
    coverage,
    importedSwimmerCount,
    newAthleteCount: seed.newAthletes.length,
    genderMismatch,
    summary,
    improvements: swimmerImprovements,
    improvedEventCount: swimmerImprovements.reduce((n, s) => n + s.improvements.length, 0),
  };
}
