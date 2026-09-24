/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Converts `@omniswim/swimcloud`'s `SwimCloudSwimmerProfileParse` into this
 * app's own `HistoricalSwim[]` shape, so a SwimCloud personal-bests capture
 * can flow through the exact same preview/alias/merge pipeline
 * (`historyImportRoster.ts`, `RosterImportWizard`, `AthleteHistoryImportPanel`)
 * as a pasted or CSV-imported one.
 *
 * Lives here, in `packages/manager`, rather than in `packages/core` or
 * `packages/swimcloud` — deliberately. `packages/core` shouldn't need to know
 * SwimCloud exists (`plans/2026-09-06/03-architecture.md` §1: "the domain
 * layer never learns which access track — or which source — produced an
 * Entry/Result"), and `packages/swimcloud` shouldn't need to know this app's
 * `HistoricalSwim` shape exists (it's meant to be reusable if this suite's
 * roster model ever changes). This module is the one place that's allowed to
 * know about both.
 *
 * ## Why this is a converter, not just a re-shape
 *
 * `HistoricalSwim.time` is a required field; `SwimCloudPersonalBest.time` is
 * optional (absent whenever the source cell wasn't a well-formed time — see
 * `parseSwimmerProfileHtml`'s file header). A personal best with no time
 * cannot become a `HistoricalSwim` without inventing one, so it's skipped and
 * reported in `skipped`, never silently dropped or fabricated
 * (`CLAUDE.md` § Data provenance, rules 2–3). `HistoricalSwim.timeType` is
 * optional, so a personal best whose course is `'unknown'` still converts —
 * course/quality logic elsewhere in this app already treats a missing
 * `timeType` as a real, handled state, not an error.
 */

import { Gender } from '@omniswim/core/types';
import type { HistoricalSwim } from '@omniswim/core/types';
// Imported from the ./parser subpath, not the @omniswim/swimcloud package
// root, on purpose: the root re-exports cache.ts/fetcher.ts/playwrightFetcher.ts,
// which pull in node:fs/promises and playwright-core — fine in the desktop
// app's Node-hosted backend, not something this UI package should drag into
// a browser/webview bundle just to reach two pure types. ./parser has none of
// that (see packages/swimcloud/src/parser.ts's own file header: string/regex
// only, no DOM, no Node).
import type {
  SwimCloudMeetResultsParse,
  SwimCloudParsedEvent,
  SwimCloudPersonalBest,
  SwimCloudPersonalBestSwim,
  SwimCloudSwimmerProfileParse,
  SwimCloudSwimmerTimesParse,
  SwimCloudTeamMeetSwimsParse,
} from '@omniswim/swimcloud/parser';

export interface SwimCloudPersonalBestsToHistoricalSwimsOptions {
  readonly team: string;
  readonly gender: Gender;
  /** Used for a row whose own `meetName` is absent. Never fabricated if this is also omitted. */
  readonly meetLabelFallback?: string;
}

export type SwimCloudImportSkipReason =
  /** The row's time cell wasn't a well-formed time; HistoricalSwim.time is required and this converter never invents one. */
  | 'no-time'
  /**
   * A personal best labeled as a relay (stroke `'Freestyle Relay'` /
   * `'Medley Relay'`). Excluded for the same reason
   * `swimCloudMeetResultsToHistoricalSwims` excludes relay events entirely
   * — found by inspection (2026-09-07) of this exact converter's own
   * output, which had been importing a swimmer's relay-leg time as though
   * it were their personal best for that individual event distance. A
   * relay split runs under different starting conditions (a flying start
   * on every leg but the first) and is not a valid individual time; SwimCloud's
   * personal-bests table apparently lists it anyway, so this converter has
   * to filter it back out.
   */
  | 'relay-event';

export interface SwimCloudImportSkippedRow {
  readonly personalBest: SwimCloudPersonalBest;
  readonly reason: SwimCloudImportSkipReason;
}

export type SwimCloudPersonalBestsConversionResult =
  | {
      readonly ok: true;
      readonly swims: readonly HistoricalSwim[];
      readonly skipped: readonly SwimCloudImportSkippedRow[];
    }
  | {
      readonly ok: false;
      readonly reason: 'missing-swimmer-name';
      readonly message: string;
    };

/**
 * `parse.name` comes from the swimmer page's own heading
 * (`parseSwimmerProfileHtml`) and is optional there because a page could
 * theoretically lack one. This converter refuses to invent a placeholder
 * name (e.g. `"SwimCloud swimmer 3646504"`) rather than risk it leaking into
 * this app's alias-suggestion system, which matches on names — a synthetic
 * name is exactly the kind of thing that system exists to catch as a
 * near-duplicate of nothing.
 *
 * @deprecated Since 2026-09-09. Its source parser, `parseSwimmerProfileHtml`,
 * is `Synthetic-fixture-only` and models a personal-bests table (bare event
 * label plus a course *column*) that real captures prove SwimCloud does not
 * serve. No longer called from `RosterImportWizard.tsx` — see
 * {@link swimCloudSwimmerTimesToHistoricalSwims} below, which replaced it at
 * that call site. Kept for one round, same convention as
 * {@link swimCloudMeetResultsToHistoricalSwims}.
 */
export function swimCloudPersonalBestsToHistoricalSwims(
  parse: SwimCloudSwimmerProfileParse,
  options: SwimCloudPersonalBestsToHistoricalSwimsOptions,
): SwimCloudPersonalBestsConversionResult {
  if (parse.name === undefined || parse.name.trim().length === 0) {
    return {
      ok: false,
      reason: 'missing-swimmer-name',
      message:
        'The captured SwimCloud page has no swimmer name (parseSwimmerProfileHtml found no page heading). Refusing to import under a placeholder name.',
    };
  }

  const swims: HistoricalSwim[] = [];
  const skipped: SwimCloudImportSkippedRow[] = [];

  for (const personalBest of parse.personalBests) {
    if (personalBest.stroke === 'Freestyle Relay' || personalBest.stroke === 'Medley Relay') {
      skipped.push({ personalBest, reason: 'relay-event' });
      continue;
    }
    if (personalBest.time === undefined) {
      skipped.push({ personalBest, reason: 'no-time' });
      continue;
    }

    const meetLabel = personalBest.meetName ?? options.meetLabelFallback;

    swims.push({
      name: parse.name,
      team: options.team,
      gender: options.gender,
      event: personalBest.label,
      time: personalBest.time,
      ...(personalBest.course === 'unknown' ? {} : { timeType: personalBest.course }),
      ...(personalBest.date === undefined ? {} : { date: personalBest.date }),
      ...(meetLabel === undefined ? {} : { meetLabel }),
      source: 'swimcloud',
    });
  }

  return { ok: true, swims, skipped };
}

/**
 * Whether a row's chips mark it as taken out of a longer swim's splits.
 *
 * Matched on the tooltip, never on the visible `X`. The same letter is the
 * Hy-Tek exhibition marker elsewhere in this codebase, and the two mean
 * entirely different things -- see `SwimCloudSwimmerTimesTag`.
 */
function isExtractedSplit(personalBest: { readonly tags: readonly { readonly title?: string }[] }): boolean {
  return personalBest.tags.some(tag => tag.title === 'Extracted');
}

/**
 * Whether a row's chips mark its time as altitude-adjusted: `A` /
 * `title="Altitude Adjusted"`, seen live on swimmer 1401610's 400 Free LCM.
 *
 * Matched on the tooltip, never on the visible `A` -- the same rule as
 * {@link isExtractedSplit}. The time on such a row is the adjusted one; the
 * swum time is not in the response. See HistoricalSwim.isAltitudeAdjusted.
 */
function isAltitudeAdjusted(personalBest: { readonly tags: readonly { readonly title?: string }[] }): boolean {
  return personalBest.tags.some(tag => tag.title === 'Altitude Adjusted');
}

/**
 * Whether a row's chips mark its time as typed in rather than swum at a meet:
 * `U` / `title="User Inputted"`, seen live on swimmers 2352628 and 1401610.
 * Matched on the tooltip, never the letter. See HistoricalSwim.isUserInputted.
 */
function isUserInputted(personalBest: { readonly tags: readonly { readonly title?: string }[] }): boolean {
  return personalBest.tags.some(tag => tag.title === 'User Inputted');
}

/* -------------------------------------------------------------------------- */
/* Meet results — bulk import                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A meet-results capture is the one SwimCloud source that gives many
 * swimmers' real times in a single page copy — everyone on a team who swam
 * that meet, not one swimmer at a time. That's the whole reason this
 * converter exists alongside {@link swimCloudPersonalBestsToHistoricalSwims}.
 */
export interface SwimCloudMeetResultsToHistoricalSwimsOptions {
  /** Matched against each entry's `teamName`, trimmed and case-insensitive — see the file header on why entries carry a name, not just a `swimCloudTeamId`. */
  readonly team: string;
  /** Only events whose SwimCloud gender matches are imported — a meet page mixes both. */
  readonly gender: Gender;
  /** Used when `parse.meetName` itself is absent. Never fabricated if this is also omitted. */
  readonly meetLabelFallback?: string;
}

export type SwimCloudMeetImportSkipReason =
  /**
   * Relay events are excluded entirely, not skipped per missing-time — a
   * relay split is swum under different starting conditions (a flying start
   * for every leg but the first) and is not a valid individual time for that
   * distance. Converting one into a HistoricalSwim row would misrepresent a
   * swimmer's actual ability at that event, which is exactly the kind of
   * fabrication `CLAUDE.md`'s data-provenance rules exist to prevent — this
   * isn't a "some day" TODO, it's a permanent exclusion.
   */
  | 'relay-event'
  /** The event's gender could not be determined from its heading (see `parser.ts`'s `unmapped-gender` warning) — never guessed. */
  | 'unknown-gender'
  /** The event's gender is the one the page contested, but not the one requested. */
  | 'other-gender'
  /** The entry's team name didn't match the requested team. */
  | 'other-team'
  /** The entry has no team name at all to compare (e.g. the results table had no Team column). */
  | 'no-team-name'
  /** The row's time cell wasn't a well-formed time — DQ, no-show, scratch, a diving score, or an unrecognized token all land here, since all of them leave `finalTime` absent. */
  | 'no-time'
  /** Defensive: the entry has no athlete name at all. Shouldn't occur in practice — `parser.ts` skips a row with an empty subject cell before an entry is ever created for it — but this converter refuses to invent one (`swimCloudPersonalBestsToHistoricalSwims`'s file header explains why a fabricated name is worse than a skipped row) rather than assume it can't happen. */
  | 'no-name';

export interface SwimCloudMeetResultSkip {
  readonly reason: SwimCloudMeetImportSkipReason;
  readonly eventLabel: string;
  /** Absent for a relay-event skip, which has no single athlete. */
  readonly athleteName?: string;
}

export interface SwimCloudMeetResultsConversion {
  readonly swims: readonly HistoricalSwim[];
  readonly skipped: readonly SwimCloudMeetResultSkip[];
}

/**
 * Converts one meet-results capture into every importable individual swim
 * for one team and one gender. Always succeeds (there's no data-absence
 * failure mode analogous to `swimCloudPersonalBestsToHistoricalSwims`'s
 * missing-swimmer-name case — a meet has a name-per-row, not one name for
 * the whole capture) — everything that can't convert lands in `skipped`
 * with a specific reason instead.
 *
 * @deprecated Since 2026-09-08. Its source parser, `parseMeetResultsHtml`,
 * targets a page shape proven not to exist on SwimCloud. No longer called
 * from `RosterImportWizard.tsx` — see `swimCloudTeamMeetSwimsToHistoricalSwims`
 * below, which replaced it at that call site. Kept for one round per
 * `plans/2026-09-08/04-parsers-and-fixtures.md`'s "Retired" section.
 */
export function swimCloudMeetResultsToHistoricalSwims(
  parse: SwimCloudMeetResultsParse,
  options: SwimCloudMeetResultsToHistoricalSwimsOptions,
): SwimCloudMeetResultsConversion {
  const swims: HistoricalSwim[] = [];
  const skipped: SwimCloudMeetResultSkip[] = [];
  const requestedTeam = options.team.trim().toLowerCase();
  const meetLabel = parse.meetName ?? options.meetLabelFallback;

  const skip = (event: SwimCloudParsedEvent, reason: SwimCloudMeetImportSkipReason, athleteName?: string) => {
    skipped.push({ reason, eventLabel: event.event.label, ...(athleteName === undefined ? {} : { athleteName }) });
  };

  for (const event of parse.events) {
    if (event.event.kind === 'relay') {
      event.entries.forEach(() => skip(event, 'relay-event'));
      continue;
    }
    if (event.event.gender === 'unknown') {
      for (const entry of event.entries) {
        skip(event, 'unknown-gender', entry.athleteName);
      }
      continue;
    }
    if (event.event.gender !== options.gender) {
      for (const entry of event.entries) {
        skip(event, 'other-gender', entry.athleteName);
      }
      continue;
    }

    for (const entry of event.entries) {
      if (entry.teamName === undefined) {
        skip(event, 'no-team-name', entry.athleteName);
        continue;
      }
      if (entry.teamName.trim().toLowerCase() !== requestedTeam) {
        skip(event, 'other-team', entry.athleteName);
        continue;
      }

      const result = event.results.find((r) => r.entryId === entry.entryId);
      if (result?.finalTime === undefined) {
        skip(event, 'no-time', entry.athleteName);
        continue;
      }
      if (entry.athleteName === undefined) {
        skip(event, 'no-name');
        continue;
      }

      swims.push({
        name: entry.athleteName,
        team: options.team,
        gender: options.gender,
        event: event.event.label,
        time: result.finalTime,
        ...(event.event.course === 'unknown' ? {} : { timeType: event.event.course }),
        ...(meetLabel === undefined ? {} : { meetLabel }),
        source: 'swimcloud',
      });
    }
  }

  return { swims, skipped };
}

/* -------------------------------------------------------------------------- */
/* Team meet-swims — bulk import against the page shape that actually exists  */
/* -------------------------------------------------------------------------- */

export interface SwimCloudTeamMeetSwimsToHistoricalSwimsOptions {
  /** Checked against `parse.teamName`, trimmed and case-insensitive — a mismatch means the coach captured the wrong team's page. */
  readonly team: string;
  /** Checked against `parse.gender` — a mismatch means the coach captured the wrong gender's page. */
  readonly gender: Gender;
  /** Used when `parse.meetName` itself is absent. Never fabricated if this is also omitted. */
  readonly meetLabelFallback?: string;
}

export interface SwimCloudTeamMeetSwimsConversion {
  readonly swims: readonly HistoricalSwim[];
  readonly skipped: readonly SwimCloudMeetResultSkip[];
}

/**
 * Converts one team-swims-list capture — `parseTeamMeetSwimsHtml`,
 * `real-capture-verified`, the page shape that actually exists on SwimCloud
 * — into every importable individual swim for one team and one gender.
 *
 * Replaces `swimCloudMeetResultsToHistoricalSwims` at this app's one bulk
 * meet-import call site (`RosterImportWizard.tsx`'s `handleClipboardMeetResults`,
 * 2026-09-08). That converter's source parser, `parseMeetResultsHtml`,
 * targets an `"Event {n} {Gender} {Distance} {Unit} {Stroke}"` heading shape
 * a real capture proved does not exist on SwimCloud — see
 * `packages/swimcloud/src/parser.ts`'s file header and
 * `plans/2026-09-08/04-parsers-and-fixtures.md`'s "Retired" section. Kept
 * (not deleted) alongside this one, per that section's step 2: still
 * exercised by the synthetic fixtures, `@deprecated`, one round from removal.
 *
 * Unlike the old converter's source page, this one is already scoped to one
 * team and one gender by the URL it was captured from
 * (`/results/{meetId}/team/{teamId}/swims/?gender=`) — so there is no
 * per-row team/gender filtering to do, only a page-level check that the
 * capture actually matches what the coach selected before pasting (a wrong
 * team or gender here means "captured the wrong page", not "some rows don't
 * belong" — the whole page is one team, one gender, or it says `'unknown'`
 * and nothing can be checked). What's left, per row: exclude relay-leadoff
 * splits — `SwimCloudResultFlags.relayLeadoff`'s own doc comment explains
 * why a leadoff is not an individual swim — and exclude a row with no time.
 */
export function swimCloudTeamMeetSwimsToHistoricalSwims(
  parse: SwimCloudTeamMeetSwimsParse,
  options: SwimCloudTeamMeetSwimsToHistoricalSwimsOptions,
): SwimCloudTeamMeetSwimsConversion {
  const swims: HistoricalSwim[] = [];
  const skipped: SwimCloudMeetResultSkip[] = [];
  const requestedTeam = options.team.trim().toLowerCase();
  const meetLabel = parse.meetName ?? options.meetLabelFallback;

  const genderMismatch = parse.gender !== 'unknown' && (parse.gender as string) !== (options.gender as string);
  // Substring, not exact equality, in either direction — checked against a
  // real capture (2026-09-08): SwimCloud prints the full institutional name
  // ("Henderson State University"), not the short form a coach's own
  // roster-plan workspace uses ("Henderson State"). An exact match here
  // would make this option unusable for the realistic case; both directions
  // are checked so either the short or the full name, typed either way,
  // matches.
  const printedTeam = parse.teamName?.trim().toLowerCase();
  const teamMismatch =
    printedTeam !== undefined && !printedTeam.includes(requestedTeam) && !requestedTeam.includes(printedTeam);

  for (const swim of parse.swims) {
    const eventLabel = swim.event.label;
    const athleteName = swim.entry.athleteName;
    const skip = (reason: SwimCloudMeetImportSkipReason) =>
      skipped.push({ reason, eventLabel, ...(athleteName === undefined ? {} : { athleteName }) });

    // Kept, not skipped. See the leadoff note in
    // `swimCloudPersonalBestsToHistoricalSwims`: a leadoff starts from the
    // blocks and finishes to the hand, so it is the individual event. This
    // page labels it as one too -- Avery Henke's leadoff row reads "50 Y Back
    // 22.53", the same swim the times page lists under "50 Back SCY".
    if (genderMismatch) {
      skip('other-gender');
      continue;
    }
    if (teamMismatch) {
      skip('other-team');
      continue;
    }
    if (swim.result.finalTime === undefined) {
      skip('no-time');
      continue;
    }
    if (athleteName === undefined) {
      skipped.push({ reason: 'no-name', eventLabel });
      continue;
    }

    swims.push({
      name: athleteName,
      team: options.team,
      gender: options.gender,
      event: eventLabel,
      time: swim.result.finalTime,
      ...(swim.event.course === 'unknown' ? {} : { timeType: swim.event.course }),
      ...(meetLabel === undefined ? {} : { meetLabel }),
      source: 'swimcloud',
    });
  }

  return { swims, skipped };
}

/* -------------------------------------------------------------------------- */
/* Swimmer times — personal bests off the page shape that actually exists      */
/* -------------------------------------------------------------------------- */

export interface SwimCloudSwimmerTimesToHistoricalSwimsOptions {
  /** The workspace team these swims are being imported under. Never read from the page — a bests table names meets, not the swimmer's own team. */
  readonly team: string;
  /** The workspace gender these swims are being imported under. Never inferred — see `parseSwimmerTimesHtml`'s note on why `#swimmer-info`'s one-letter `gender` code is not read. */
  readonly gender: Gender;
  /** Used for a row whose own `meetName` is absent. Never fabricated if this is also omitted. */
  readonly meetLabelFallback?: string;
}

export type SwimCloudSwimmerTimesSkipReason =
  /** The row's time cell wasn't a well-formed time; `HistoricalSwim.time` is required and this converter never invents one. */
  | 'no-time'
  /**
   * The row is a relay leadoff split, flagged by the page's own `R` chip
   * (`title="Leadoff"`).
   *
   * Named for what it is, rather than reusing the meet converters'
   * `'relay-event'`: this table lists one row per event and never lists a relay
   * as an event, so the only relay-shaped row it can produce is a leadoff. The
   * reason string reaches a coach verbatim in the import warnings, and "relay
   * leadoff" says which row was dropped where "relay event" would not.
   *
   * Detected from {@link SwimCloudPersonalBestSwim.relayLeadoff} — a real
   * boolean the parser read from a real chip — not by string-matching a stroke
   * name, which is what the deprecated
   * {@link swimCloudPersonalBestsToHistoricalSwims} had to do against a table
   * shape that does not exist.
   */
  | 'relay-leadoff';

export interface SwimCloudSwimmerTimesSkippedRow {
  readonly personalBest: SwimCloudPersonalBestSwim;
  readonly reason: SwimCloudSwimmerTimesSkipReason;
}

export type SwimCloudSwimmerTimesConversionResult =
  | {
      readonly ok: true;
      readonly swims: readonly HistoricalSwim[];
      readonly skipped: readonly SwimCloudSwimmerTimesSkippedRow[];
    }
  | {
      readonly ok: false;
      readonly reason: 'missing-swimmer-name';
      readonly message: string;
    };

/**
 * Converts one `/swimmer/{id}/times/` capture — `parseSwimmerTimesHtml`,
 * `real-capture-verified`, the page shape that actually exists on SwimCloud —
 * into that swimmer's importable personal bests.
 *
 * Replaces {@link swimCloudPersonalBestsToHistoricalSwims} at this app's one
 * per-swimmer import call site (`RosterImportWizard.tsx`, 2026-09-09). That
 * converter's source parser, `parseSwimmerProfileHtml`, is
 * `Synthetic-fixture-only` and reads a course *column* off a bare `/swimmer/{id}/`
 * page. Real captures settled both halves of that: the base page carries a
 * narrower "Latest Results" panel for one meet, not a bests list, and the real
 * bests table (on `/times/`) publishes no course column at all — the course is
 * a suffix of the printed event label. Kept (not deleted) alongside this one,
 * same one-round convention as the `parseMeetResultsHtml` retirement
 * (`plans/2026-09-08/WORKLOG-02-phase0b-retire-parseMeetResultsHtml-call-site.md`).
 *
 * ## Relay leadoffs are excluded, and the page says so itself
 *
 * The old converter had to infer "this is a relay leg" by string-matching a
 * stroke name (`'Freestyle Relay'` / `'Medley Relay'`). This one reads
 * {@link SwimCloudPersonalBestSwim.relayLeadoff}, which the parser sets from a
 * chip whose tooltip literally reads `Leadoff` — a fact the page published,
 * not a guess about a label. The real capture carries exactly one such row
 * (50 Back SCY), so this branch is exercised by real data rather than by a
 * synthetic case.
 *
 * ## `name` is used verbatim, in the order the page prints it
 *
 * `parse.name` is `'Paulk, River J'` — family name first, from `#swimmer-info`
 * — and this converter passes it through unchanged, exactly as
 * {@link swimCloudPersonalBestsToHistoricalSwims} passes its own parser's name
 * through unchanged. Reordering it here would mean deciding by heuristic which
 * token is the family name, which is the guess `parseSwimmerTimesHtml`'s "One
 * name, one source" note refuses to make, and this converter is not the place
 * to overrule it.
 *
 * **Known consequence, stated plainly:** the other converter in this file,
 * {@link swimCloudTeamMeetSwimsToHistoricalSwims}, takes its name from a meet
 * results row, which prints display order (`'Colin Candebat'`). So the two
 * SwimCloud-sourced converters here now emit **different name orders**, and the
 * same swimmer imported through both paths produces two rows whose
 * `normalizeSwimmerName` keys differ — `historyImportRoster.ts` keys on that,
 * not on `canonicalSwimmerName`, so the merge does not fold them on its own.
 * This app's alias system is what closes the gap: `athleteAliases.ts` keys on
 * `canonicalSwimmerName`, which folds `"Last, First"` into `"first last"`, so
 * `suggestAliasCandidates` surfaces the pair for a coach to link. That is the
 * designed answer to two sources spelling one swimmer two ways, and it is a
 * suggestion a human confirms — not a silent rename either converter performs.
 */
export function swimCloudSwimmerTimesToHistoricalSwims(
  parse: SwimCloudSwimmerTimesParse,
  options: SwimCloudSwimmerTimesToHistoricalSwimsOptions,
): SwimCloudSwimmerTimesConversionResult {
  if (parse.name === undefined || parse.name.trim().length === 0) {
    return {
      ok: false,
      reason: 'missing-swimmer-name',
      message:
        "The captured SwimCloud page has no swimmer name (parseSwimmerTimesHtml found no readable #swimmer-info block). Refusing to import under a placeholder name.",
    };
  }

  const swims: HistoricalSwim[] = [];
  const skipped: SwimCloudSwimmerTimesSkippedRow[] = [];

  for (const personalBest of parse.personalBests) {
    // A relay leadoff is imported as a real individual swim. **Changed
    // 2026-09-22 on the user's ruling**, and the reasoning is the rules: a
    // leadoff starts from the blocks, not a flying takeover, and finishes to
    // the hand. It is the individual event, swum inside a relay. Avery Henke's
    // 22.53 leadoff is his 50 Back.
    //
    // This is NOT the same question as whether a leadoff scores as an
    // individual entry at the meet it was swum in -- it does not, and
    // `swimCloudMeetImportBridge` still excludes it there. That bridge is
    // about one meet's placings; this one is about what a swimmer has done.
    const meetLabel = personalBest.meetName ?? options.meetLabelFallback;

    // A dive is kept with its judged score in `time`, exactly as the meet data
    // stores one (`data/meets.json`: "1 mtr Diving", "503.95"). The diving label
    // is what keeps it out of best-time ranking (`canonicalMeetEventLabel`) and
    // cut tagging (`cutlineTags`), which both refuse a diving event outright.
    if (personalBest.stroke === 'Diving' && personalBest.divingScore !== undefined) {
      swims.push({
        name: parse.name,
        team: options.team,
        gender: options.gender,
        event: personalBest.eventLabel,
        time: personalBest.divingScore,
        ...(personalBest.date === undefined ? {} : { date: personalBest.date }),
        ...(meetLabel === undefined ? {} : { meetLabel }),
        source: 'swimcloud',
      });
      continue;
    }

    if (personalBest.time === undefined) {
      skipped.push({ personalBest, reason: 'no-time' });
      continue;
    }

    swims.push({
      name: parse.name,
      team: options.team,
      gender: options.gender,
      // Carries the course as a suffix (`'50 Free SCY'`) because this page
      // publishes no course column — see SwimCloudPersonalBestSwim.eventLabel.
      event: personalBest.eventLabel,
      time: personalBest.time,
      ...(personalBest.course === 'unknown' ? {} : { timeType: personalBest.course }),
      // Verbatim, e.g. `'Mar 1, 2025'`. Never reformatted or reparsed — see
      // SwimCloudPersonalBestSwim.date on why this string is a per-swim date in
      // the page's own format and not something to normalize on the way past.
      ...(personalBest.date === undefined ? {} : { date: personalBest.date }),
      ...(meetLabel === undefined ? {} : { meetLabel }),
      // A time SwimCloud took out of a longer swim's splits, marked `X` /
      // `title="Extracted"`. Kept, because it is the only 50 many swimmers
      // have and it estimates a relay leg well -- but flagged, because it is
      // not a race at this distance and must never be ranked, cut-tagged or
      // entered. See HistoricalSwim.isExtractedSplit.
      ...(isExtractedSplit(personalBest) ? { isExtractedSplit: true } : {}),
      // An altitude-adjusted time, kept exactly as published. It is still a
      // best (the NCAA enters the adjusted time) and is never adjusted again.
      // See HistoricalSwim.isAltitudeAdjusted.
      ...(isAltitudeAdjusted(personalBest) ? { isAltitudeAdjusted: true as const } : {}),
      // A self-reported time. Imported and kept, never a best. See
      // HistoricalSwim.isUserInputted.
      ...(isUserInputted(personalBest) ? { isUserInputted: true as const } : {}),
      source: 'swimcloud',
    });
  }

  return { ok: true, swims, skipped };
}
