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
  SwimCloudSwimmerProfileParse,
} from '@omniswim/swimcloud/parser';

export interface SwimCloudPersonalBestsToHistoricalSwimsOptions {
  readonly team: string;
  readonly gender: Gender;
  /** Used for a row whose own `meetName` is absent. Never fabricated if this is also omitted. */
  readonly meetLabelFallback?: string;
}

export type SwimCloudImportSkipReason =
  /** The row's time cell wasn't a well-formed time; HistoricalSwim.time is required and this converter never invents one. */
  'no-time';

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
