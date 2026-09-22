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
import type {
  SwimCloudClassYear,
  SwimCloudEvent,
  SwimCloudTeamId,
} from '@omniswim/swimcloud/entities';
import type {
  SwimCloudMeetEventResultsParse,
  SwimCloudMeetEventSwim,
  SwimCloudMeetResultsParse,
  SwimCloudRosterParse,
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
  | 'ambiguous-round-duplicate'
  /**
   * An event page's round table carried no `<caption>`, so the round it
   * holds is unnamed.
   *
   * Only {@link swimCloudEventResultsToSwimmerResults} produces this. The
   * rows are real swims and are deliberately not converted, because a row
   * with no round imports as an unknown tier, which `packages/core` scores
   * as a full final — so an unnamed preliminaries heat would score as an A
   * final. Same rule, and the same reason, as
   * {@link buildSwimCloudEventRoundIndex} skipping such a round.
   */
  | 'missing-round-caption';

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


/* ---- Class year, joined from the rosters in the same capture -------------- */

/**
 * Why a swim's class year is \`'unknown'\`.
 *
 * Absent when the class year is actually known. Every value here is a
 * statement about what the capture holds, never about the swimmer — a coach
 * reading "unknown" needs to know whether to go looking for a roster or accept
 * that none exists.
 */
export type SwimCloudClassYearGap =
  /** No roster page for this swimmer's team and gender is in the capture. Crawl one, or the team published none. */
  | 'no-roster-captured'
  /** A roster for the team was read, but it lists nobody with this swimmer's SwimCloud id. */
  | 'not-on-the-roster'
  /** The roster lists the swimmer and prints no class year for them — a dash, or a blank cell. */
  | 'roster-prints-no-class-year'
  /** The swim carries no SwimCloud swimmer id, so there is nothing to join on. A relay row never has one. */
  | 'no-swimmer-id-to-join-on';

/** One roster row's class year, keyed by swimmer id in {@link SwimCloudClassYearIndex}. */
export interface SwimCloudRosterClassYear {
  /** As printed and mapped by the roster parser. \`'unknown'\` when the cell held no year. */
  readonly classYear: SwimCloudClassYear;
  /** The roster this came from, so a caller can say which page answered. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  readonly teamName?: string;
  /** The roster's season label. A roster is a season snapshot, so this is what the year is true *of*. */
  readonly season?: string;
}

/**
 * SwimCloud swimmer id → what a roster page in this capture says about their
 * class year.
 *
 * ## The join is on the swimmer id, and only on it
 *
 * Both a roster row and an event-page results row carry
 * \`swimCloudSwimmerId\`, so this is an exact id join in the same sense
 * {@link SwimCloudEventRoundIndex} is. That matters more here than it looks:
 * matching a roster to a results row **by name** is precisely the failure this
 * repo has already been bitten by. \`INVARIANTS\` item 6 and the 2026-07-19
 * aliasing round exist because "Alan Gonzalez" and "Alan Alejan Gonzalez
 * Mujica" are one swimmer, and a name join would have to decide that. The id
 * decides it for us, or does not decide it at all.
 *
 * **No name fallback is offered**, for the same reason no name fallback is
 * offered for the round index. A wrong class year is not a cosmetic error: it
 * moves a swimmer between eligibility years in a coach's planning view.
 *
 * First entry wins on a repeated id. A swimmer appearing on two rosters in one
 * capture is a real possibility — a transfer, or the same roster captured
 * twice — and a later roster does not get to overwrite an earlier one silently.
 */
export type SwimCloudClassYearIndex = ReadonlyMap<string, SwimCloudRosterClassYear>;

/**
 * {@link SwimCloudClassYearIndex} plus what the capture is able to answer at
 * all, so "unknown" can say which kind of unknown it is.
 */
export interface SwimCloudClassYearCoverage {
  readonly index: SwimCloudClassYearIndex;
  /**
   * \`{teamId}:{gender}\` for every roster page that parsed, whether or not it
   * listed anybody.
   *
   * This is what separates "this team published no roster" from "we never
   * fetched it" from "we fetched it and the swimmer is not on it". A roster
   * that parsed and listed nobody — UWF's men, a program that does not exist —
   * is still recorded here, because the capture *did* answer the question. The
   * answer was no.
   */
  readonly rostersRead: readonly string[];
  /** Team ids any roster in the capture covered, in first-seen order. */
  readonly teamsWithRosters: readonly string[];
}

/**
 * Build the class-year lookup from every parsed roster page in a capture.
 *
 * A roster row with no swimmer id contributes nothing: there would be no way to
 * join it, and adding it under its name would re-introduce exactly the name
 * matching this index exists to avoid.
 */
export function buildSwimCloudClassYearIndex(
  rosters: readonly SwimCloudRosterParse[],
): SwimCloudClassYearCoverage {
  const index = new Map<string, SwimCloudRosterClassYear>();
  const rostersRead: string[] = [];
  const teamsWithRosters: string[] = [];

  for (const roster of rosters) {
    const teamId = roster.swimCloudTeamId;
    if (teamId !== undefined) {
      const key = `${teamId}:${roster.gender ?? 'unknown'}`;
      if (!rostersRead.includes(key)) rostersRead.push(key);
      if (!teamsWithRosters.includes(teamId)) teamsWithRosters.push(teamId);
    }

    for (const athlete of roster.athletes) {
      const swimmerId = athlete.swimCloudSwimmerId;
      if (swimmerId === undefined) continue;
      if (index.has(swimmerId)) continue;
      index.set(swimmerId, {
        classYear: athlete.classYear ?? 'unknown',
        ...(roster.swimCloudTeamId === undefined ? {} : { swimCloudTeamId: roster.swimCloudTeamId }),
        ...(roster.teamName === undefined ? {} : { teamName: roster.teamName }),
        ...(roster.season === undefined ? {} : { season: roster.season }),
      });
    }
  }

  return { index, rostersRead, teamsWithRosters };
}

/** An empty coverage — a capture with no roster pages answers nothing about class year. */
const NO_CLASS_YEAR_COVERAGE: SwimCloudClassYearCoverage = {
  index: new Map(),
  rostersRead: [],
  teamsWithRosters: [],
};

/** What {@link resolveClassYear} concluded, and why. */
interface ResolvedClassYear {
  readonly classYear: SwimCloudClassYear;
  /** Absent when {@link classYear} is a real year. */
  readonly gap?: SwimCloudClassYearGap;
}

/**
 * One swim's class year, or the named reason there isn't one.
 *
 * Never defaults. `CLAUDE.md`'s provenance rules are explicit that an unmapped
 * value surfaces as unknown rather than quietly taking a plausible one, and a
 * class year is a competition-adjacent fact a coach plans against.
 */
function resolveClassYear(
  swimmerId: string | undefined,
  teamId: string | undefined,
  coverage: SwimCloudClassYearCoverage,
): ResolvedClassYear {
  if (swimmerId === undefined) {
    return { classYear: 'unknown', gap: 'no-swimmer-id-to-join-on' };
  }
  const found = coverage.index.get(swimmerId);
  if (found !== undefined) {
    return found.classYear === 'unknown'
      ? { classYear: 'unknown', gap: 'roster-prints-no-class-year' }
      : { classYear: found.classYear };
  }
  // The swimmer is not in the index. Which of the two remaining reasons it is
  // depends on whether this capture read their team's roster at all — the
  // difference between "fetch one" and "there is nothing to fetch".
  const teamCovered = teamId !== undefined && coverage.teamsWithRosters.includes(teamId);
  return {
    classYear: 'unknown',
    gap: teamCovered ? 'not-on-the-roster' : 'no-roster-captured',
  };
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


/* ---- Team names for relay rows, from the capture's own individual rows ---- */

/**
 * SwimCloud team id → the team's name as an individual results row prints it.
 *
 * ## Why a relay row needs this
 *
 * A relay event's results table has no Team column at all: its header is one
 * `<th colspan=2>Name</th>`, and the entry's name cell reads "Henderson State
 * (A)" while linking `/results/{meetId}/team/58/`. So a relay row knows its
 * team *id* but never prints the team's plain name.
 *
 * `"Henderson State (A)"` must not become the team, because team scoring groups
 * rows by that string: the A and B relays would score as two different
 * programs, and neither would join the individual swims of the same team.
 *
 * Stripping the ` (A)` suffix would work on this capture and is still not what
 * this does. The suffix is a relay entry letter by convention, not by anything
 * the page states, and a team whose real name ends in a parenthesised letter
 * would be quietly renamed. The name is instead taken from where the page does
 * state it plainly — an individual event's Team column, for the same team id —
 * so the join is on SwimCloud's own id and the name is SwimCloud's own text.
 *
 * ## What it cannot answer
 *
 * A capture holding only relay events has no individual row to learn from, and
 * this index is then empty for those teams. Their rows are skipped with
 * `'no-team-name'` rather than scored under a designator-bearing name. An
 * event-first crawl fetches every event, so the individual pages are present
 * in practice; this stays honest when they are not.
 *
 * First entry wins. One team id has one name, so a repeat agrees.
 */
export type SwimCloudTeamNameIndex = ReadonlyMap<string, string>;

/**
 * Build the team-id-to-name lookup from every parsed per-event page in a
 * capture.
 *
 * Only rows that print both an id and a name contribute, which in practice
 * means individual events. A relay row contributes its id to nothing, because
 * the name it carries is the designator-bearing entry label this index exists
 * to avoid using.
 */
export function buildSwimCloudTeamNameIndex(
  parses: readonly SwimCloudMeetEventResultsParse[],
): SwimCloudTeamNameIndex {
  const index = new Map<string, string>();
  for (const parse of parses) {
    if (parse.event.kind === 'relay') continue;
    for (const round of parse.rounds) {
      for (const swim of round.swims) {
        const teamId = swim.entry.swimCloudTeamId;
        const teamName = swim.entry.teamName;
        if (teamId === undefined || teamName === undefined || teamName.length === 0) continue;
        if (index.has(teamId)) continue;
        index.set(teamId, teamName);
      }
    }
  }
  return index;
}

/* ---- Event-first: a per-event page converted directly -------------------- */

export interface SwimCloudEventResultsImportOptions {
  /** See {@link SwimCloudPointsTrust}. Defaults to `'meet-score-column'`. */
  readonly pointsTrust?: SwimCloudPointsTrust;
  /**
   * Roster pages from the same capture, for the class-year join. See
   * {@link buildSwimCloudClassYearIndex}.
   *
   * Omitted means no roster was captured, and every row's class year is
   * `'unknown'` with the reason `'no-roster-captured'` — never a default.
   */
  readonly rosters?: readonly SwimCloudRosterParse[];
  /**
   * Team names by SwimCloud team id, from
   * {@link buildSwimCloudTeamNameIndex} over every event page in the capture.
   *
   * Needed only by relay rows, whose table has no Team column. Omitted means a
   * relay row has no team name available and is skipped with
   * `'no-team-name'` — never scored under its "(A)"-bearing entry label.
   */
  readonly teamNames?: SwimCloudTeamNameIndex;
}

/** {@link swimCloudEventResultsToSwimmerResults}'s result, plus the class-year gaps it hit. */
export interface SwimCloudEventResultsImportResult extends SwimCloudMeetImportResult {
  /**
   * How many converted rows carry each kind of class-year gap.
   *
   * Reported rather than logged, so a UI can say "42 swimmers have no class
   * year because no roster for their team is in this capture" instead of
   * showing a column of blanks with no explanation. An empty object means every
   * converted row's class year is known.
   */
  readonly classYearGaps: Readonly<Partial<Record<SwimCloudClassYearGap, number>>>;
}

/**
 * One `/results/{meetId}/event/{n}/` page → scoreable rows, directly.
 *
 * ## Why this exists alongside the swims-list converter
 *
 * {@link swimCloudTeamMeetSwimsToSwimmerResults} makes the per-team swims list
 * the source of rows and uses event pages only to resolve their rounds. That
 * inverted the reliable order. The event page is strictly the better source:
 *
 * | | swims list | event page |
 * | --- | --- | --- |
 * | round | absent | the table's own `<caption>` |
 * | real meet points | absent | the `Score` column on A/B finals |
 * | exhibition | absent | marked in the rank cell |
 * | relay legs | absent | names, swimmer ids and splits |
 * | diving events | **cannot appear** | one page each |
 * | pages for meet 356467 | 42, naming 51 events | 57, naming all 57 |
 *
 * A diver has no swims, so four diving events of that meet could never be
 * imported from swims lists at any page count. That is not a refinement; it is
 * scoring events missing from a team total, with nothing in the total to show
 * it.
 *
 * ## Duplicates are not a problem here
 *
 * The swims-list converter has to exclude a swimmer's prelims and finals rows
 * as `'ambiguous-round-duplicate'` when no event page resolves them, because
 * that page has no round column. This converter never needs that reason: every
 * row arrives already inside its round's captioned table. A round with no
 * caption is skipped rather than converted, for the same reason
 * {@link buildSwimCloudEventRoundIndex} skips one — an uncaptioned round would
 * import as an unknown tier, which `packages/core` scores as a full final.
 *
 * ## Ids match the swims path on purpose
 *
 * A row's id is `swim.swimKey`, which both parsers derive from SwimCloud's own
 * swim id. So the same swim converted from an event page and from a swims list
 * is one row, and {@link mergeSwimCloudResults} folds them instead of
 * double-counting. That is what lets a capture holding both kinds import
 * safely, and it is why this can be added without retiring the other path.
 */
export function swimCloudEventResultsToSwimmerResults(
  parse: SwimCloudMeetEventResultsParse,
  options: SwimCloudEventResultsImportOptions = {},
): SwimCloudEventResultsImportResult {
  const trust = options.pointsTrust ?? 'meet-score-column';
  const coverage =
    options.rosters === undefined
      ? NO_CLASS_YEAR_COVERAGE
      : buildSwimCloudClassYearIndex(options.rosters);
  const men: SwimmerResult[] = [];
  const women: SwimmerResult[] = [];
  const skipped: SwimCloudMeetImportSkip[] = [];
  const classYearGaps: Partial<Record<SwimCloudClassYearGap, number>> = {};

  const eventLabel = parse.event.label;
  const isRelay = parse.event.kind === 'relay';

  // The page states its own gender on its gender dropdown's active item, and
  // that is a statement about every row on it — so it is read once here rather
  // than per row. When the page never said (a "Mixed" event, which the parser
  // records as unknown rather than mapping it to a side), every row is skipped
  // with a reason instead of being assigned to a side of the meet by guess.
  const gender = mapGender(parse.gender);

  for (const round of parse.rounds) {
    if (round.round === undefined) {
      for (const swim of round.swims) {
        skipped.push({
          reason: 'missing-round-caption',
          eventLabel,
          ...(swim.entry.athleteName === undefined ? {} : { subject: swim.entry.athleteName }),
        });
      }
      continue;
    }

    for (const swim of round.swims) {
      if (swim.relayLeadoff) {
        skipped.push({
          reason: 'relay-leadoff',
          eventLabel,
          ...(swim.entry.athleteName === undefined ? {} : { subject: swim.entry.athleteName }),
        });
        continue;
      }

      if (gender === undefined) {
        skipped.push({
          reason: 'unknown-gender',
          eventLabel,
          ...(swim.entry.athleteName === undefined ? {} : { subject: swim.entry.athleteName }),
        });
        continue;
      }

      // A relay row's "name" is its team, which is that row's real subject —
      // see the file header. An individual row with no name is a parse gap.
      const name = swim.entry.athleteName;
      if (name === undefined) {
        skipped.push({ reason: 'no-athlete-name', eventLabel });
        continue;
      }

      // A relay table prints no team name, only a team link, so the plain name
      // comes from the id index — see {@link buildSwimCloudTeamNameIndex} for
      // why the entry label "Henderson State (A)" is not used as the team.
      const team =
        swim.entry.teamName ??
        (swim.entry.swimCloudTeamId === undefined
          ? undefined
          : options.teamNames?.get(swim.entry.swimCloudTeamId));
      if (team === undefined) {
        skipped.push({ reason: 'no-team-name', eventLabel, subject: name });
        continue;
      }

      const { points, pdfPoints } = eventPointsFor(swim, trust);
      const resolvedYear = resolveClassYear(
        swim.entry.swimCloudSwimmerId,
        swim.entry.swimCloudTeamId,
        coverage,
      );
      if (resolvedYear.gap !== undefined) {
        classYearGaps[resolvedYear.gap] = (classYearGaps[resolvedYear.gap] ?? 0) + 1;
      }

      const legs = swim.relayLegs ?? [];

      (gender === Gender.MEN ? men : women).push({
        id: swim.swimKey,
        // An exhibition row prints no ordinal, so it has no place. The sentinel
        // is the same one the swims path uses for an unranked row.
        rank: swim.result.place ?? UNRANKED_SENTINEL,
        name,
        classYear: resolvedYear.classYear,
        team,
        time: timeOrMarker(swim.result.finalTime, swim.result.rawTimeToken),
        points,
        event: eventLabel,
        gender,
        roundSwam: round.round,
        ...(isRelay ? { isRelay: true } : {}),
        ...(legs.length === 0
          ? {}
          : {
              // The year is left empty rather than joined. A leg names a
              // swimmer and a split; filling a class year here would put a
              // second, separately-sourced year on the same page as the
              // individual rows' one, and the two could disagree. Worth doing
              // deliberately, not as a side effect of this converter.
              relayNames: legs.map((leg) => ({ name: leg.athleteName ?? '', year: '' })),
            }),
        ...(swim.exhibition ? { isExhibition: true } : {}),
        ...(pdfPoints === undefined ? {} : { pdfPoints }),
      });
    }
  }

  return { men, women, skipped, classYearGaps };
}

/**
 * {@link pointsFor} for an event-page row.
 *
 * Separate from {@link pointsFor} because that one takes a swims-list swim plus
 * an optional resolved round, and here the swim *is* the resolved round: its
 * `meetScore` came off the very table whose caption named the round. There are
 * no two sources to reconcile, so there is no second argument.
 */
function eventPointsFor(
  swim: SwimCloudMeetEventSwim,
  trust: SwimCloudPointsTrust,
): { points: number; pdfPoints?: number } {
  const value = trust === 'swimcloud-points' ? swim.result.points : swim.meetScore;
  if (value === undefined) {
    // Zero is `SwimmerResult.points`'s "nothing to display yet", not a claim
    // that the swim scored nothing — with `pdfPoints` absent the app computes
    // the real value from rank and the meet's point table. C finals and
    // preliminaries land here, which is correct: those rounds publish the `Pts`
    // power index, not meet points.
    return { points: 0 };
  }
  return { points: value, pdfPoints: value };
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
   * Roster pages from the same capture, for the class-year join — see
   * {@link buildSwimCloudClassYearIndex}.
   *
   * Omitted means the capture holds no roster, and every row converted from an
   * event page reports `'no-roster-captured'` rather than taking a default.
   */
  readonly rosters?: readonly SwimCloudRosterParse[];
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

  const eventParses = options.eventResults ?? [];
  // An event-first capture holds NO swims pages: the crawl stops fetching them
  // once the meet's own event index has named every event. Returning early on
  // `parses.length === 0` would then import nothing from a complete capture,
  // so the gate is "neither source has anything", not "no swims pages".
  if (parses.length === 0 && eventParses.length === 0) {
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
  // Converted directly, not merely consulted for round labels. An event page
  // carries the round, the real meet score, the exhibition marker and the relay
  // legs, none of which a swims row has — and it is the only page a diving
  // event appears on at all.
  // Built across the whole capture, not per page: a relay event's page has no
  // individual row to learn a team name from, so it must be told by the
  // individual events' pages.
  const teamNames = buildSwimCloudTeamNameIndex(eventParses);
  const convertedEvents = eventParses.map(p =>
    swimCloudEventResultsToSwimmerResults(p, {
      pointsTrust: options.pointsTrust,
      teamNames,
      ...(options.rosters === undefined ? {} : { rosters: options.rosters }),
    }),
  );
  const skipped = [...converted.flatMap(c => c.skipped), ...convertedEvents.flatMap(c => c.skipped)];

  // Swims-derived rows first, then event-derived over them. Both sides key a
  // row by SwimCloud's own swim id, so a swim present in both is ONE row — and
  // the event-page version is the one that wins, because it is the version that
  // knows which round it was and what it really scored.
  const accMen = [...converted, ...convertedEvents].reduce<SwimmerResult[]>(
    (acc, c) => mergeSwimCloudResults(acc, c.men),
    [],
  );
  const accWomen = [...converted, ...convertedEvents].reduce<SwimmerResult[]>(
    (acc, c) => mergeSwimCloudResults(acc, c.women),
    [],
  );
  const meetName = parses[0]?.meetName ?? eventParses[0]?.meetName;

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
  // `swimCloudMeetId`, so the first parse speaks for all of them — read from
  // whichever source this capture has, since an event-first capture has no
  // swims pages at all and `parses[0]` would not exist.
  const meetId = parses[0]?.swimCloudMeetId ?? eventParses[0]?.swimCloudMeetId;
  if (meetId === undefined) {
    // Unreachable through the gate above, which already returned when both
    // sources were empty. Thrown rather than defaulted because a wrong meet
    // prefix silently merges two different meets' rows into one scoreboard.
    throw new Error(
      'applySwimCloudRows: rows were converted but neither a swims page nor an event page named a meet id.',
    );
  }
  const meetPrefix = `${meetId}:`;
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
