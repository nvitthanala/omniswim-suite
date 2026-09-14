/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Converts `@omniswim/swimcloud`'s `SwimCloudMeetResultsParse` into this
 * app's own `SwimmerResult[]` shape — the same shape `/api/parse-pdf`
 * produces — so a SwimCloud meet-results capture can become a "loaded meet"
 * in Matrix (`OpsModule.tsx`'s `handleFileUpload`) exactly like a PDF upload
 * does, feeding the same live scoring pipeline.
 *
 * Lives here, in `packages/matrix`, not `packages/core` or `packages/swimcloud`
 * — same reasoning as `packages/manager/src/lib/swimCloudImportBridge.ts`:
 * `packages/core` shouldn't need to know SwimCloud exists, and
 * `packages/swimcloud` shouldn't need to know this app's `SwimmerResult`
 * shape exists. This module is the one place allowed to know both.
 *
 * ## Points: trusted here, unlike the Manager-side bridge
 *
 * `HistoricalSwim` (the Manager-side bridge's target) has no points field at
 * all, so that bridge never had to decide whether to trust SwimCloud's
 * printed points. `SwimmerResult` does have one, twice over: `points` (what
 * gets displayed/summed) and `pdfPoints` (a source's own points, which — when
 * present and `usePdfPlacePoints` is on — *overrides* whatever the app would
 * otherwise compute from rank and a point table;
 * `packages/core/src/lib/scoringDefaults.ts`). The user confirmed directly
 * (2026-09-07) that SwimCloud's printed points are trustworthy, so this
 * bridge populates `pdfPoints` from `SwimCloudResult.points` and expects its
 * caller to turn `usePdfPlacePoints` on — the exact same trust mechanism a
 * PDF upload already uses, not a new one invented for SwimCloud.
 *
 * ## Rank, for a row with no place
 *
 * `SwimmerResult.rank` is a required `number`. `packages/core`'s own
 * `calculatePoints` already defends against a messy rank with
 * `parseRankInt(a.rank) ?? 9999` — sorts-last, never scores. This bridge
 * uses that same sentinel explicitly for a DQ/no-show/exhibition row with no
 * real place, rather than inventing a different convention.
 *
 * ## Time, for a non-finishing row
 *
 * Mirrors `backend/pdf_parser.py`'s own convention exactly: the marker
 * (`DQ`, `NS`, `SCR`, …) goes directly into the `time` field, verbatim — not
 * a separate flag column the rest of the app doesn't expect.
 *
 * ## Relays are included here — unlike the Manager-side bridge, which excludes them
 *
 * `HistoricalSwim` has no concept of a relay leg's split being a *different
 * kind of fact* from an individual swim, so the Manager bridge excludes relay
 * events outright (a leg's split isn't a valid individual time). `SwimmerResult`
 * is not that shape — it already has first-class relay fields (`isRelay`,
 * `relayNames`, `relayLegSplit`, …) because a loaded meet is expected to
 * contain relays. So here, a relay event becomes one `SwimmerResult` row per
 * relay (team-level: name is the team, time/points/rank are the relay's own),
 * with `relayNames` populated from its legs when SwimCloud published them.
 *
 * ## Rounds: where a swim's prelims-or-finals actually comes from
 *
 * A SwimCloud team-swims list has **no round or session column**, so for a
 * while this bridge could not set `SwimmerResult.roundSwam` at all — and a row
 * with no round classifies as tier `'UNK'`, which `packages/core` scores
 * exactly like a real final. A swimmer who made finals was therefore scored
 * twice; a swimmer who only swam prelims was scored once, as a finalist.
 *
 * The fix is not cleverness at this layer. It is a second page:
 * `/results/{meetId}/event/{n}/` prints every round of one event as its own
 * `<caption>`-labelled table, and its A/B Final tables carry the real meet
 * `Score`. Supply those parses through
 * {@link SwimCloudTeamMeetSwimsImportOptions.eventResults} and a swim's round,
 * rank, exhibition flag and meet points all come from the page that states
 * them. Supply nothing and every one of those stays absent — never inferred.
 * See `plans/2026-09-10/01-SWIMCLOUD-SCORING-CORRECTNESS.md`.
 */

import { Gender } from '@omniswim/core/types';
import type { SwimmerResult, Workspace } from '@omniswim/core/types';
import { buildScoringPatchForParsedPdf, presetIdForConference } from '@omniswim/core/lib/scoringDefaults';
import { meetCopyFromParsed } from '@omniswim/core/lib/meetSource';
import type { SwimCloudEvent } from '@omniswim/swimcloud/entities';
import type {
  SwimCloudMeetEventResultsParse,
  SwimCloudMeetResultsParse,
  SwimCloudTeamMeetSwim,
  SwimCloudTeamMeetSwimsParse,
} from '@omniswim/swimcloud/parser';

export type SwimCloudMeetImportSkipReason =
  /** The event's gender could not be determined from its heading — never guessed which side of the meet it belongs to. */
  | 'unknown-gender'
  /** No team name was captured for this entry at all. */
  | 'no-team-name'
  /** An individual entry has no athlete name (a relay's own "name" is its team, not an individual — see the file header). */
  | 'no-athlete-name'
  /**
   * The row is a relay leadoff split, which is not an individual swim.
   *
   * SwimCloud lists a leadoff leg as a row that looks exactly like an
   * individual swim of the same event. It carries a real time, but it is one
   * leg of a relay, it never places, and scoring or ranking it as an individual
   * entry would invent a swim that did not happen. See
   * `SwimCloudResultFlags.relayLeadoff`.
   */
  | 'relay-leadoff'
  /**
   * The same athlete has more than one swim of this event on this page, and
   * nothing on the page says which is which round.
   *
   * The team-swims list has no round/session column — see
   * `SwimCloudTeamMeetSwim`'s doc comment in `@omniswim/swimcloud/parser`. In a
   * meet with a preliminaries-and-finals format, a swimmer who advances lists
   * both swims as ordinary rows, each with its own (per-round, not per-event)
   * "Place". A real capture measured six such groups (13 of 30 swims, one group of
   * three) on one page — 43% of it — so this is common, not an edge case.
   *
   * Only one of the two swims counts for team score (Rule 7-6-3/7-6-4: places
   * are never merged or re-ranked across rounds), and the page does not name
   * which one. Guessing — by time, by place, or by which swim id is larger —
   * would be exactly the kind of invented fact `CLAUDE.md`'s provenance rules
   * forbid for competition data, so this bridge picks neither: every swim in
   * the group is excluded from `men`/`women` and reported here instead, naming
   * both swims so a coach can resolve it by hand from the event's own results
   * page (`/results/{meetId}/event/{n}/`, which SwimCloud does label
   * "Preliminaries"/"Finals").
   *
   * ## This is now the fallback, not the answer
   *
   * As of 2026-09-10 this bridge can read that per-event page —
   * `parseMeetEventResultsHtml` — and a duplicate whose swims appear on a
   * captured event page is **resolved**, not excluded: each row gets its real
   * `roundSwam` and, for a finals row, its real meet `Score`. See
   * {@link SwimCloudTeamMeetSwimsImportOptions.eventResults}.
   *
   * A swim still lands here when the event page for it was not captured, did
   * not parse, or carried no round caption. That is deliberate and is not a
   * regression: the absence of the data is the reason, and guessing a round in
   * its place would be the same invented fact it always was.
   */
  | 'ambiguous-round-duplicate';

export interface SwimCloudMeetImportSkip {
  readonly reason: SwimCloudMeetImportSkipReason;
  readonly eventLabel: string;
  readonly subject?: string;
  /**
   * Extra, reason-specific detail beyond `eventLabel`/`subject`. Only
   * `'ambiguous-round-duplicate'` sets this today, naming the swim (time and
   * SwimCloud swim id) this particular skip entry refers to, so a coach
   * reading the skip list can find the swim on the event's own results page.
   */
  readonly detail?: string;
}

export interface SwimCloudMeetImportResult {
  readonly men: readonly SwimmerResult[];
  readonly women: readonly SwimmerResult[];
  readonly skipped: readonly SwimCloudMeetImportSkip[];
}

/** Matches `parseRankInt(...) ?? 9999`'s existing fallback in `packages/core/src/lib/utils.ts` — the app's own scoring code already treats this as "unrankable, sorts last, never scores." Not a new convention. */
const UNRANKED_SENTINEL = 9999;

function mapGender(g: SwimCloudEvent['gender']): Gender | undefined {
  if (g === 'Men') return Gender.MEN;
  if (g === 'Women') return Gender.WOMEN;
  return undefined;
}

/** `backend/pdf_parser.py`'s own convention: a non-finishing marker lives directly in the time field, verbatim. `'NT'` (No Time) is HyTek's own marker for a row with neither a time nor a recognized marker — a defensive default, not expected to actually fire for a row that reached this point. */
function timeOrMarker(finalTime: string | undefined, rawTimeToken: string | undefined): string {
  return finalTime ?? rawTimeToken ?? 'NT';
}

export function swimCloudMeetResultsToSwimmerResults(parse: SwimCloudMeetResultsParse): SwimCloudMeetImportResult {
  const men: SwimmerResult[] = [];
  const women: SwimmerResult[] = [];
  const skipped: SwimCloudMeetImportSkip[] = [];

  for (const parsedEvent of parse.events) {
    const gender = mapGender(parsedEvent.event.gender);
    if (gender === undefined) {
      skipped.push({ reason: 'unknown-gender', eventLabel: parsedEvent.event.label });
      continue;
    }
    const bucket = gender === Gender.MEN ? men : women;
    const isRelay = parsedEvent.event.kind === 'relay';

    for (const entry of parsedEvent.entries) {
      const result = parsedEvent.results.find(r => r.entryId === entry.entryId);
      const time = timeOrMarker(result?.finalTime, result?.rawTimeToken);
      const rank = result?.place ?? UNRANKED_SENTINEL;
      const points = result?.points ?? 0;

      if (isRelay) {
        const relay = parsedEvent.relays.find(r => r.relayId === entry.relayId);
        const teamName = relay?.teamName ?? entry.teamName;
        if (teamName === undefined) {
          skipped.push({ reason: 'no-team-name', eventLabel: parsedEvent.event.label });
          continue;
        }
        bucket.push({
          id: entry.entryId,
          rank,
          name: teamName,
          classYear: 'unknown',
          team: teamName,
          time,
          points,
          event: parsedEvent.event.label,
          gender,
          isRelay: true,
          ...(relay !== undefined && relay.legs.length > 0
            ? { relayNames: relay.legs.map(leg => ({ name: leg.athleteName ?? '', year: '' })) }
            : {}),
          ...(result?.flags?.exhibition === true ? { isExhibition: true } : {}),
          ...(result?.points !== undefined ? { pdfPoints: result.points } : {}),
        });
      } else {
        const name = entry.athleteName;
        if (name === undefined) {
          skipped.push({ reason: 'no-athlete-name', eventLabel: parsedEvent.event.label });
          continue;
        }
        const team = entry.teamName;
        if (team === undefined) {
          skipped.push({ reason: 'no-team-name', eventLabel: parsedEvent.event.label, subject: name });
          continue;
        }
        bucket.push({
          id: entry.entryId,
          rank,
          name,
          classYear: 'unknown',
          team,
          time,
          points,
          event: parsedEvent.event.label,
          gender,
          ...(result?.flags?.exhibition === true ? { isExhibition: true } : {}),
          ...(result?.points !== undefined ? { pdfPoints: result.points } : {}),
        });
      }
    }
  }

  return { men, women, skipped };
}

/* ========================================================================== */
/* Team-in-meet swims list (the real-capture-verified path)                    */
/* ========================================================================== */

/**
 * How to treat SwimCloud's `Pts` column.
 *
 * ## Why this is not simply "trust the points, the user said so"
 *
 * The 2026-09-07 decision recorded in this file's header — that SwimCloud's
 * printed points are trustworthy — was made about a *points column*, before
 * anyone had seen a real page. The 2026-09-08 capture shows the column it names
 * is not the meet score:
 *
 * - The meet-root results card prints **both** on one row: `Score` 20 and
 *   `Pts` 846, for a first-place 1000 Free.
 * - On the full swims list every `Pts` value sits between 692 and 767 and
 *   descends monotonically — the list is sorted by it. Meet points for thirty
 *   swims would run 20, 17, 16, …
 * - Henderson State scored **1056** at that meet, printed twice (the team's
 *   `Points scored` splash-stat and the meet standings). One page of `Pts`
 *   already sums past 21,000.
 *
 * `Pts` is SwimCloud's power index — a rating of how fast a swim is. It is a
 * real, useful number and this bridge carries it through. It is not what
 * `SwimmerResult.pdfPoints` means, and putting it there would make the workspace
 * report a team score roughly twenty times the real one.
 *
 * So the default is `'meet-score-column'`: `pdfPoints` is set only from a real
 * `Score` column, and a page without one (the swims list has none) yields rows
 * whose points the app computes from place and the meet's point table, exactly
 * as it would for any other source that did not publish points. That is the
 * existing, correct fallback — not a new mechanism.
 *
 * `'swimcloud-points'` is offered because the trust decision belongs to the
 * caller, not to this module, and a user who has looked at the evidence above
 * and still wants the index in the points field can say so in one word.
 */
export type SwimCloudPointsTrust =
  /** Default. `pdfPoints` comes from a `Score` column, or is left unset. */
  | 'meet-score-column'
  /** `pdfPoints` comes from the `Pts` power index. See this type's doc comment before choosing it. */
  | 'swimcloud-points';

export interface SwimCloudTeamMeetSwimsImportOptions {
  /** See {@link SwimCloudPointsTrust}. Defaults to `'meet-score-column'`. */
  readonly pointsTrust?: SwimCloudPointsTrust;
  /**
   * Per-event results pages (`/results/{meetId}/event/{n}/`) from the same
   * capture, parsed by `parseMeetEventResultsHtml`.
   *
   * **This is what turns "excluded as ambiguous" into "scored as the round it
   * actually was".** The team-swims list carries no round column; this page
   * type does, one `<caption>`-labelled table per round, plus the real meet
   * `Score` on its A/B Final tables. See
   * {@link buildSwimCloudEventRoundIndex} for the join, and
   * {@link SwimCloudResolvedRound} for what a resolved swim inherits.
   *
   * Omitted or empty means "this capture holds no event page", and the
   * converter behaves exactly as it did before this option existed: a
   * same-swimmer/same-event duplicate is excluded whole, and a lone swim is
   * converted with no `roundSwam`. Nothing degrades when the data is absent,
   * and nothing is guessed to fill the gap.
   */
  readonly eventResults?: readonly SwimCloudMeetEventResultsParse[];
}

/* ---- Resolving a swim's round from its event's own results page ------------ */

/**
 * What one swim's own event-results page says about it, beyond what the
 * team-swims list could.
 *
 * Every field here comes from the round-labelled table the swim was printed
 * in — the page's own statement, not a reconciliation of two sources.
 */
export interface SwimCloudResolvedRound {
  /**
   * The round's caption, verbatim: `'A Final'`, `'B Final'`, `'C Final'`,
   * `'Preliminaries'`.
   *
   * Goes straight into `SwimmerResult.roundSwam`, where
   * `packages/core`'s `classifyRoundTier` reads it — `'A Final'` → `'A'`,
   * `'Preliminaries'` → `'PRE'`, and so on. No mapping happens in between,
   * because `classifyRoundTier` already understands this exact vocabulary and
   * a second copy of it here could only ever drift from the first.
   */
  readonly roundSwam: string;
  /**
   * The swim's **real meet points**, from the round table's `Score` column.
   *
   * Absent for a round whose table carried the `Pts` power index instead
   * (C Final and Preliminaries on the real capture — rounds that do not score
   * at this meet). Absent means "this round published no meet points", never
   * "it scored zero": with this absent the app computes points from rank and
   * the meet's point table, exactly as it does for any other unpublished
   * source.
   */
  readonly meetScore?: number;
  /** The swim's placement **within its round**, from the event page's rank cell. Absent for an exhibition swim, which the page prints no ordinal for. */
  readonly place?: number;
  /**
   * The swim was marked exhibition on the event page.
   *
   * The team-swims list has no exhibition marker of any kind, so this is
   * information that page simply could not carry — and an exhibition swim
   * imported as a scoring one is a wrong team score, not a cosmetic slip.
   */
  readonly exhibition: boolean;
  /** The `/event/{n}/` page this came from. Carried so a caller can say which capture answered. */
  readonly eventRef: string;
}

/**
 * Swim id → what its event's results page says, ready for
 * {@link swimCloudTeamMeetSwimsToSwimmerResults} to look up.
 *
 * ## The join is on SwimCloud's swim id, and only on it
 *
 * Both pages key a swim as `{meetId}:swim:{swimCloudSwimId}` — the parser
 * builds that same `swimKey` on both sides precisely so this lookup is one map
 * read. The id is SwimCloud's own identity for the swim, so the join is exact:
 * Avery Henke's `171560737` is her A Final on the event page and her second
 * `100 Y Breast` row on the swims list, with no normalization in between.
 *
 * **Name + team + time is deliberately not offered as a fallback.** It reads
 * like a safe second option and is not: a swimmer who goes the same time in
 * prelims and finals — which happens, and is exactly the swimmer whose rows are
 * hardest to tell apart — would match both rounds equally, and the tie would be
 * broken by map order. That is a coin flip deciding whether a swim scores. A
 * swim with no id on one side or the other stays unresolved and falls back to
 * the existing exclusion, which is a visible gap rather than a silent guess.
 *
 * First entry wins on a repeated id. A swim id names one swim on one page, so a
 * genuine conflict cannot arise; a repeat means the same page was parsed twice
 * (a re-capture), and both entries say the same thing.
 */
export type SwimCloudEventRoundIndex = ReadonlyMap<string, SwimCloudResolvedRound>;

/**
 * Build the swim-id lookup from every parsed per-event page in a capture.
 *
 * Exported because a caller holding the parses (the capture picker, a test, a
 * future UI that wants to show "resolved from event 26") may want the index
 * itself rather than only its effect on the converted rows.
 *
 * A round with no caption contributes nothing: `roundSwam` is the whole point
 * of the index, and an entry with an empty round would resolve a swim to
 * "unknown tier", which `packages/core` scores as a full final — the exact bug
 * this whole path exists to fix. Those swims stay unresolved and keep the
 * exclusion fallback.
 */
export function buildSwimCloudEventRoundIndex(
  parses: readonly SwimCloudMeetEventResultsParse[],
): SwimCloudEventRoundIndex {
  const index = new Map<string, SwimCloudResolvedRound>();
  for (const parse of parses) {
    for (const round of parse.rounds) {
      if (round.round === undefined) continue;
      for (const swim of round.swims) {
        if (swim.swimCloudSwimId === undefined) continue;
        if (index.has(swim.swimKey)) continue;
        index.set(swim.swimKey, {
          roundSwam: round.round,
          ...(swim.meetScore === undefined ? {} : { meetScore: swim.meetScore }),
          ...(swim.result.place === undefined ? {} : { place: swim.result.place }),
          exhibition: swim.exhibition,
          eventRef: parse.eventRef,
        });
      }
    }
  }
  return index;
}

/**
 * The `SwimmerResult.id` a swim becomes.
 *
 * This is the parser's `swimKey` unchanged, and that is deliberate: it is
 * derived from SwimCloud's own per-swim id, so the same swim captured twice —
 * page 1 re-captured, or the team-landing summary and then the full list — keeps
 * one id and merges instead of duplicating. `OpsModule`'s accumulating import
 * dedupes on exactly this.
 */
export function swimCloudSwimResultId(swim: SwimCloudTeamMeetSwim): string {
  return swim.swimKey;
}

/**
 * The points a converted row carries.
 *
 * `resolved` is the swim's own event-results page, when one was captured. Its
 * `Score` is the **only** real per-swim meet points in this pipeline — the
 * swims list has no such column at all — so it wins over the swims-list row,
 * which has nothing to offer here. It does not override a
 * `'swimcloud-points'` caller: that option is a caller saying "put the power
 * index in the points field", and quietly substituting a different number for
 * it would be answering a question the caller did not ask.
 */
function pointsFor(
  swim: SwimCloudTeamMeetSwim,
  trust: SwimCloudPointsTrust,
  resolved?: SwimCloudResolvedRound,
): { points: number; pdfPoints?: number } {
  const value =
    trust === 'swimcloud-points' ? swim.result.points : (resolved?.meetScore ?? swim.meetScore);
  if (value === undefined) {
    // Zero here is `SwimmerResult.points`'s "nothing to display yet" state, not
    // a claim that the swim scored nothing: with `pdfPoints` absent, the app
    // computes the real value from rank and the point table.
    return { points: 0 };
  }
  return { points: value, pdfPoints: value };
}

/**
 * Group key for "same athlete, same event" on one swims-list page — the
 * granularity {@link SwimCloudMeetImportSkipReason}'s `'ambiguous-round-duplicate'`
 * detects duplicates at.
 *
 * Grouped by event label, not `SwimCloudEvent.eventId`. A real capture shows
 * prelims and finals of one labeled event sometimes sharing one `event/{n}/`
 * id (two swims both linking `event/26/`) and sometimes not (Oskar Cebula's
 * 100 Y Breast: two swims under `event/26/`, one under `event/100/`, all
 * three the same labeled event). SwimCloud's numeric event id tracks a
 * results page, not a round, so it under-counts duplicates if trusted alone.
 * The label is the one thing every swim of one individual event shares
 * regardless of how many result pages it got split across.
 *
 * Team name is part of the key so an unattached/unknown athlete name never
 * accidentally collides with a real one across teams; a relay leadoff is
 * never a member of this grouping (its own skip reason takes it out first).
 */
function sameSwimmerEventKey(swim: SwimCloudTeamMeetSwim): string {
  return `${swim.entry.athleteName ?? ''} ${swim.entry.teamName ?? ''} ${swim.event.label}`;
}

/**
 * One line identifying a single swim for the `detail` field of an
 * `'ambiguous-round-duplicate'` skip — enough to find the swim on SwimCloud
 * without re-deriving it from `SwimmerResult`, which drops the swim id.
 */
function swimDetailLine(swim: SwimCloudTeamMeetSwim): string {
  const time = swim.result.finalTime ?? swim.result.rawTimeToken ?? 'no time';
  const place = swim.result.place === undefined ? 'unplaced' : `place ${swim.result.place}`;
  const id = swim.swimCloudSwimId ?? 'no swim id';
  return `${time} (${place}, swim ${id})`;
}

/**
 * Every {@link sameSwimmerEventKey} that names more than one non-leadoff swim
 * on this page — see `'ambiguous-round-duplicate'`'s doc comment for why a
 * duplicate is never resolved by a guess.
 */
function ambiguousRoundDuplicateKeys(swims: readonly SwimCloudTeamMeetSwim[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const swim of swims) {
    if (swim.relayLeadoff) continue;
    const key = sameSwimmerEventKey(swim);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

/**
 * Convert a swims-list capture into this app's `SwimmerResult[]`.
 *
 * The counterpart of {@link swimCloudMeetResultsToSwimmerResults} for the page
 * shape SwimCloud actually serves. Both are exported; this is the one a meet
 * import should call.
 *
 * Three differences from the older converter, each forced by the real markup:
 *
 * 1. **Relay leadoff splits are excluded.** They look like individual swims and
 *    are not. Each is reported as a `'relay-leadoff'` skip rather than dropped
 *    in silence.
 * 2. **`pdfPoints` does not come from the `Pts` column** by default. See
 *    {@link SwimCloudPointsTrust} for the measurements behind that.
 * 3. **Ids are SwimCloud swim ids**, so repeat captures merge. See
 *    {@link swimCloudSwimResultId}.
 * 4. **A swimmer with more than one swim of the same event is excluded
 *    entirely**, both swims reported as `'ambiguous-round-duplicate'` skips —
 *    *unless* the event's own results page was captured. See point 5.
 *
 * Relays themselves are absent from this page type entirely, so — unlike the
 * older converter — this one builds no relay rows. It is not that relays are
 * excluded; the page does not carry them.
 *
 * ## 5. Round resolution, when the event pages are supplied
 *
 * Pass {@link SwimCloudTeamMeetSwimsImportOptions.eventResults} and every swim
 * whose SwimCloud swim id appears on one of those pages inherits, from the
 * round-labelled table it was printed in:
 *
 * - `roundSwam` — the caption verbatim, which `packages/core`'s
 *   `classifyRoundTier` reads directly.
 * - `rank` — that round's placement, which is the only sense in which the
 *   swims list's `Place` was ever a real number.
 * - `isExhibition` — a fact the swims list cannot carry at all.
 * - `points`/`pdfPoints` — the real meet `Score`, for a round whose table
 *   published one (A and B Final on the real capture).
 *
 * **This applies to every matched swim, not only to a duplicate pair**, and
 * that is deliberate. A swimmer who swam prelims and *missed* finals appears
 * exactly once on the swims list, so the duplicate detector never sees them —
 * and with no `roundSwam` at all, `classifyRoundTier` returns `'UNK'`, which
 * `canScoreAthlete` scores the same as a real final. Resolving that lone row to
 * `'Preliminaries'` is the same bug fixed for the shape that never looked like
 * a bug. It costs nothing when no event page was captured, because then nothing
 * matches and every row behaves exactly as before.
 *
 * A swim that matches nothing — no event page for its event, a page that did
 * not parse, a round with no caption, a row with no swim id on either side —
 * keeps the old behaviour exactly: excluded if it is part of a duplicate group,
 * converted round-less if it is not. Nothing is guessed to close the gap.
 */
export function swimCloudTeamMeetSwimsToSwimmerResults(
  parse: SwimCloudTeamMeetSwimsParse,
  options: SwimCloudTeamMeetSwimsImportOptions = {},
): SwimCloudMeetImportResult {
  const trust = options.pointsTrust ?? 'meet-score-column';
  const men: SwimmerResult[] = [];
  const women: SwimmerResult[] = [];
  const skipped: SwimCloudMeetImportSkip[] = [];
  const ambiguousKeys = ambiguousRoundDuplicateKeys(parse.swims);
  const rounds = buildSwimCloudEventRoundIndex(options.eventResults ?? []);

  for (const swim of parse.swims) {
    const eventLabel = swim.event.label;

    if (swim.relayLeadoff) {
      skipped.push({
        reason: 'relay-leadoff',
        eventLabel,
        ...(swim.entry.athleteName === undefined ? {} : { subject: swim.entry.athleteName }),
      });
      continue;
    }

    // Looked up before the duplicate test, because a resolved swim is no longer
    // ambiguous: the event page named its round, so the reason to exclude it is
    // gone. An unresolved member of a duplicate group still falls through to
    // the exclusion below — resolving one of a pair does not license guessing
    // at the other.
    const resolved = rounds.get(swim.swimKey);

    if (resolved === undefined && ambiguousKeys.has(sameSwimmerEventKey(swim))) {
      skipped.push({
        reason: 'ambiguous-round-duplicate',
        eventLabel,
        detail: swimDetailLine(swim),
        ...(swim.entry.athleteName === undefined ? {} : { subject: swim.entry.athleteName }),
      });
      continue;
    }

    // The page is gender-filtered as a whole, so an event's gender is the
    // page's. When the page never said, the swim is skipped rather than
    // assigned to a side of the meet by guess.
    const gender = mapGender(swim.event.gender);
    if (gender === undefined) {
      skipped.push({
        reason: 'unknown-gender',
        eventLabel,
        ...(swim.entry.athleteName === undefined ? {} : { subject: swim.entry.athleteName }),
      });
      continue;
    }

    const name = swim.entry.athleteName;
    if (name === undefined) {
      skipped.push({ reason: 'no-athlete-name', eventLabel });
      continue;
    }

    const team = swim.entry.teamName;
    if (team === undefined) {
      skipped.push({ reason: 'no-team-name', eventLabel, subject: name });
      continue;
    }

    const { points, pdfPoints } = pointsFor(swim, trust, resolved);
    // The event page's rank is the round's placement, read off the same table
    // the round caption came from. The swims list's `Place` is the same number
    // arrived at without knowing which round it belonged to, so when both
    // exist they agree — and when they cannot both exist (an exhibition swim,
    // which the event page prints no ordinal for) the event page is the one
    // that knows why.
    const rank = resolved === undefined ? swim.result.place : resolved.place;
    const isExhibition = resolved?.exhibition === true || swim.result.flags?.exhibition === true;

    (gender === Gender.MEN ? men : women).push({
      id: swimCloudSwimResultId(swim),
      rank: rank ?? UNRANKED_SENTINEL,
      name,
      classYear: 'unknown',
      team,
      time: timeOrMarker(swim.result.finalTime, swim.result.rawTimeToken),
      points,
      event: eventLabel,
      gender,
      ...(resolved === undefined ? {} : { roundSwam: resolved.roundSwam }),
      ...(isExhibition ? { isExhibition: true } : {}),
      ...(pdfPoints === undefined ? {} : { pdfPoints }),
    });
  }

  return { men, women, skipped };
}

/**
 * Merge freshly captured rows into rows already loaded, newest capture winning.
 *
 * A complete team's results are `pages × genders` captures — the real meet ran
 * to 8 pages per gender — so the import has to accumulate rather than replace.
 * Dedupe is by `SwimmerResult.id`, which for a SwimCloud row is its SwimCloud
 * swim id, so re-capturing a page updates its rows instead of doubling them.
 *
 * Existing rows keep their position; genuinely new rows are appended. Rows from
 * another source (a PDF upload, a planned entry) pass through untouched — their
 * ids are of another shape and cannot collide.
 */
export function mergeSwimCloudResults(
  existing: readonly SwimmerResult[],
  incoming: readonly SwimmerResult[],
): SwimmerResult[] {
  const byId = new Map(incoming.map((row) => [row.id, row]));
  const merged = existing.map((row) => byId.get(row.id) ?? row);
  const seen = new Set(existing.map((row) => row.id));
  for (const row of incoming) {
    if (!seen.has(row.id)) {
      merged.push(row);
    }
  }
  return merged;
}

/* ========================================================================== */
/* The shared "apply a SwimCloud capture to the workspace" core                */
/* ========================================================================== */

/**
 * Asked only when a genuinely different meet is about to replace what's
 * loaded and the workspace has saved recruits that would otherwise be lost.
 * Matches `OpsModule.tsx`'s original `resolveKeepRecruits` exactly — same
 * copy, same `OK = Keep` / `Cancel = Discard` convention — so the clipboard
 * path's behavior does not change by one word.
 */
function defaultResolveKeepRecruits(existingRecruits: readonly unknown[]): boolean {
  if (existingRecruits.length === 0) return true;
  return window.confirm(
    `${existingRecruits.length} recruit(s) saved in this workspace.\n\nOK = Keep recruits\nCancel = Discard recruits`
  );
}

export interface ApplySwimCloudRowsOptions extends SwimCloudTeamMeetSwimsImportOptions {
  /**
   * Overrides {@link defaultResolveKeepRecruits}. Exists so a non-browser
   * caller — a test, or a future non-`confirm` UI — never has to touch
   * `window`. The clipboard path and the capture picker both leave this
   * unset and get the original `window.confirm` behavior.
   */
  readonly resolveKeepRecruits?: (existingRecruits: readonly unknown[]) => boolean;
}

export interface ApplySwimCloudRowsResult {
  /** Rows newly converted from the `parses` passed to *this* call (deduped among themselves) — not the workspace's new total. */
  readonly appliedRowCount: number;
  /** Rows in the meet after this call, matching what `handleSwimCloudImport` called `allRows.length`. */
  readonly totalRowCount: number;
  readonly skipped: readonly SwimCloudMeetImportSkip[];
  readonly meetName: string | undefined;
  /** `presetIdForConference(workspace.conference)` — the caller's cue to update its own "suggested preset" UI state. */
  readonly presetHint: string | null;
  /** Whether this call folded into the meet already loaded (by the `${meetId}:` id-prefix test) rather than replacing it. */
  readonly isSameMeet: boolean;
}

/**
 * The shared core of a SwimCloud meet import, extracted from
 * `OpsModule.tsx`'s `handleSwimCloudImport` so the clipboard path and the
 * capture-picker path (`SwimCloudCapturePicker.tsx`) run identical logic
 * after a page (or a whole capture's worth of pages) has been parsed. See
 * `handleSwimCloudImport`'s own doc comment for the "why it accumulates" and
 * "which page to capture" background this function inherits unchanged.
 *
 * `parses` may be one page — the clipboard path always passes exactly one —
 * or many, when a picker imports a whole capture in one go. Every page is
 * folded together with {@link mergeSwimCloudResults} and applied as a single
 * `onUpdate` call: a 66-page capture must fire one workspace update, not 66.
 *
 * Produces the identical `onUpdate` patch `handleSwimCloudImport` always has
 * for the single-page case — same field order does not matter, but every key
 * and value does, because existing tests for that path assert the shape
 * exactly.
 */
export async function applySwimCloudRows(
  parses: readonly SwimCloudTeamMeetSwimsParse[],
  workspace: Workspace,
  onUpdate: (patch: Partial<Workspace>) => void | Promise<void>,
  options: ApplySwimCloudRowsOptions = {},
): Promise<ApplySwimCloudRowsResult> {
  const loadedMen = workspace.menResults ?? [];
  const loadedWomen = workspace.womenResults ?? [];

  if (parses.length === 0) {
    return {
      appliedRowCount: 0,
      totalRowCount: loadedMen.length + loadedWomen.length,
      skipped: [],
      meetName: undefined,
      presetHint: null,
      isSameMeet: false,
    };
  }

  // Every page of the capture is converted against the *same* event-page set:
  // one event page covers every team and both genders, so it belongs to the
  // capture, not to any one swims-list page.
  const converted = parses.map(p =>
    swimCloudTeamMeetSwimsToSwimmerResults(p, {
      pointsTrust: options.pointsTrust,
      ...(options.eventResults === undefined ? {} : { eventResults: options.eventResults }),
    }),
  );
  const skipped = converted.flatMap(c => c.skipped);
  const accMen = converted.reduce<SwimmerResult[]>((acc, c) => mergeSwimCloudResults(acc, c.men), []);
  const accWomen = converted.reduce<SwimmerResult[]>((acc, c) => mergeSwimCloudResults(acc, c.women), []);
  const meetName = parses[0].meetName;

  if (accMen.length === 0 && accWomen.length === 0) {
    // Nothing usable came out of this capture. Mirrors the original
    // `handleSwimCloudImport` early return: no workspace update, no scoring
    // recompute — the caller reports the skip count and stops.
    return {
      appliedRowCount: 0,
      totalRowCount: loadedMen.length + loadedWomen.length,
      skipped,
      meetName,
      presetHint: null,
      isSameMeet: false,
    };
  }

  // Same meet as what's already loaded? Then add to it. The test is the row
  // ids' meet-id prefix alone (not the full `:swim:` key), so a row that fell
  // back to a composite key still counts as the same meet — see
  // `handleSwimCloudImport`'s doc comment. All pages of one capture share one
  // `swimCloudMeetId`, so the first parse speaks for all of them.
  const meetPrefix = `${parses[0].swimCloudMeetId}:`;
  const isSameMeet = [...loadedMen, ...loadedWomen].some(row => row.id.startsWith(meetPrefix));

  const mergedMen = isSameMeet ? mergeSwimCloudResults(loadedMen, accMen) : accMen;
  const mergedWomen = isSameMeet ? mergeSwimCloudResults(loadedWomen, accWomen) : accWomen;
  const allRows = [...mergedMen, ...mergedWomen];

  // Conference isn't re-detected here — a SwimCloud results capture doesn't
  // name it machine-readably, unlike a PDF's own text — so this trusts
  // whatever `workspace.conference` already holds.
  const conference = workspace.conference;
  const presetHint = presetIdForConference(conference);

  // Shared with `handleFileUpload` (the PDF path) — same inputs, same trust
  // decision, so this reuses that function rather than keeping a second copy
  // of its logic.
  const scoringPatch = buildScoringPatchForParsedPdf(workspace.scoringSettings, conference, presetHint, allRows);

  // Only a fresh meet clears the workspace's own edits and asks about
  // recruits. Adding another page (or another whole capture) of the meet
  // already loaded must not throw away deletions, roster overrides or relay
  // overrides the user has made since.
  const existingRecruits = workspace.recruits ?? [];
  const resolveKeep = options.resolveKeepRecruits ?? defaultResolveKeepRecruits;
  const resetPatch = isSameMeet
    ? {}
    : {
        deletedSwimmers: [],
        scorerRosterOverrides: [],
        relayLegOverrides: [],
        recruits: resolveKeep(existingRecruits) ? existingRecruits : [],
      };

  await onUpdate({
    ...meetCopyFromParsed(mergedMen, mergedWomen),
    ...resetPatch,
    loadedMeet: {
      // pdfFilename doubles, across this app, as the general "what's loaded"
      // display string — WorkspaceSidebar, LoadMeetHereCard, RosterSourceStep,
      // and this view's own "Meet results" panel all read it directly and
      // none of them fall back to meetLabel, so a SwimCloud import with no PDF
      // filename would otherwise show "No meet loaded" everywhere despite
      // having genuinely succeeded. meetLabel is still set too, for the one
      // caller (workspace-naming) that already prefers it.
      pdfFilename: `${meetName ?? 'SwimCloud meet'} (via SwimCloud)`,
      uploadedAt: Date.now(),
      conference,
      meetLabel: meetName,
    },
    ...(conference ? { conference } : {}),
    ...(scoringPatch ? { scoringSettings: scoringPatch } : {}),
  });

  return {
    appliedRowCount: accMen.length + accWomen.length,
    totalRowCount: allRows.length,
    skipped,
    meetName,
    presetHint,
    isSameMeet,
  };
}
