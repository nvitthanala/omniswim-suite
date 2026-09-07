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
import type { SwimCloudPersonalBest, SwimCloudSwimmerProfileParse } from '@omniswim/swimcloud/parser';

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
