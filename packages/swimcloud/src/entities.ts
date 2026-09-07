/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud source entities.
 *
 * Shape adapted from `plans/2026-09-06/02-data-model-and-scoring.md` §2, which in
 * turn adapts the W3C OpenTrack Community Group's Open Athletics Data Model
 * (Competition → UnitCompetition → Competitor → Performance → Result).
 *
 * Three rules from `CLAUDE.md` § "Data provenance" govern every type in this
 * file, and they are the reason several fields look more awkward than they
 * strictly need to:
 *
 * 1. **Unknown ≠ a default.** A course we could not determine is `'unknown'`,
 *    never silently `'SCY'`; a ruleset we could not determine is `'unknown'`,
 *    never silently `'NCAA'`. This mirrors the existing "unknown division ≠ D1"
 *    rule in `packages/core/src/data/teamDivisions.ts`.
 * 2. **Absent ≠ zero.** A competition value we do not hold is an omitted
 *    optional field, never `0` and never an interpolated estimate.
 * 3. **Unverified is labelled.** Nothing in this file has been checked against
 *    real SwimCloud markup — see {@link SwimCloudParseConfidence} in
 *    `./parser.ts`. Fields whose *existence* on a SwimCloud page is unverified
 *    carry an explicit "unverified" doc-comment; treat their absence as the
 *    expected case, not as a parse bug.
 *
 * These types describe **what a SwimCloud page says**. They deliberately do not
 * import from `@omniswim/core`: the domain layer must not learn where an
 * Entry/Result came from (`plans/2026-09-06/03-architecture.md` §1). Mapping
 * these into the core roster/scoring model is a separate, later step.
 */

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A SwimCloud numeric id, held as a **string of digits**.
 *
 * Deliberately not `number`. Ids are assigned roughly chronologically and are
 * already 8 digits (`10028935`); holding them as strings removes any question of
 * `Number.MAX_SAFE_INTEGER` truncation, of `parseInt` silently accepting
 * `"123abc"`, and of `0` being a legal-looking value. The URL classifier
 * validates the digit shape once (`/^[1-9][0-9]*$/`) so downstream code can
 * treat this as already-checked.
 */
export type SwimCloudNumericId = string;

/** A SwimCloud team id, from `/team/{id}/`. */
export type SwimCloudTeamId = SwimCloudNumericId;

/** A SwimCloud swimmer id, from `/swimmer/{id}/`. */
export type SwimCloudSwimmerId = SwimCloudNumericId;

/** A SwimCloud meet id, from `/results/{meetId}/`. */
export type SwimCloudMeetId = SwimCloudNumericId;

/**
 * A conference slug, from `/country/usa/college/conference/{slug}/` — readable,
 * not numeric (e.g. `nsisc`).
 */
export type SwimCloudConferenceSlug = string;

/* -------------------------------------------------------------------------- */
/* Small shared vocabularies                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Course type. Same three values `packages/core/src/types.ts` already uses for
 * `timeType`/`course`, so a later mapping step is a rename, not a translation.
 */
export type SwimCloudCourse = 'SCY' | 'SCM' | 'LCM';

/**
 * Course, or an explicit admission that we could not determine it.
 *
 * `'unknown'` exists because the word "Meter" in an event label is **ambiguous
 * between LCM and SCM**. A parser that resolved "200 Meter Freestyle" to either
 * one would be guessing at a competition fact, which is precisely what
 * `CLAUDE.md` forbids. "Yard" is unambiguous; "Meter" is not, and only a
 * meet-level course declaration can settle it.
 */
export type SwimCloudCourseOrUnknown = SwimCloudCourse | 'unknown';

/**
 * Gender of a *program*, matching the `Gender` enum values in
 * `packages/core/src/types.ts` (`'Men'` / `'Women'`) so the strings line up
 * without a translation table.
 */
export type SwimCloudGender = 'Men' | 'Women';

/** Gender of a program or event, or an explicit "not determined". */
export type SwimCloudGenderOrUnknown = SwimCloudGender | 'unknown';

/**
 * Stroke of a contested event. `'unknown'` is a real, expected value: an event
 * label we cannot map is reported as unknown rather than bucketed into the
 * nearest-looking stroke.
 */
export type SwimCloudStroke =
  | 'Freestyle'
  | 'Backstroke'
  | 'Breaststroke'
  | 'Butterfly'
  | 'Individual Medley'
  | 'Freestyle Relay'
  | 'Medley Relay'
  | 'Diving'
  | 'unknown';

/**
 * Class year, matching `ClassYear` in `packages/core/src/types.ts`, plus
 * `'unknown'` for a roster row that does not state one.
 */
export type SwimCloudClassYear = 'FR' | 'SO' | 'JR' | 'SR' | 'GR' | 'unknown';

/**
 * A swim time exactly as printed, e.g. `'1:56.47'` or `'52.10'`.
 *
 * Kept as a string on purpose. This repo already stores times as strings, and a
 * string cannot be accidentally averaged, defaulted to `0`, or interpolated. A
 * cell we could not parse as a time is **omitted**, with the raw token preserved
 * separately (see {@link SwimCloudResult.rawTimeToken}) — never coerced.
 */
export type SwimCloudTimeString = string;

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which access track produced a captured page.
 *
 * `plans/2026-09-06/01-legal-and-access-strategy.md` §4 makes the two live
 * tracks materially different in risk posture, so the track is recorded rather
 * than flattened away. `'synthetic-fixture'` is the only value any code in this
 * package has ever actually produced.
 */
export type SwimCloudCaptureTrack =
  /** Track A — the user's own browser, on a page they navigated to by hand. */
  | 'browser-extension'
  /** Track B — the local Playwright fetcher, on an explicit paste action. */
  | 'playwright'
  /** Hand-authored fixture. Never a real page. */
  | 'synthetic-fixture';

/**
 * Where a parsed page came from. One record per captured page, not per row —
 * duplicating it onto every athlete would invite the two copies to disagree.
 */
export interface SwimCloudProvenance {
  /** The URL the capture came from, verbatim as supplied by the caller. */
  readonly sourceUrl: string;
  /** ISO-8601 instant the page was captured. Supplied by the caller, not invented here. */
  readonly retrievedAt: string;
  /** Which access track captured it. */
  readonly track: SwimCloudCaptureTrack;
  /**
   * SHA-256 of the raw captured HTML, if the caller computed one.
   *
   * Optional because this package has no crypto dependency and does not compute
   * it. The archival discipline in `CLAUDE.md` (`data/cutlines/sources/`
   * `manifest.json` records `{url, sha256, retrievedAt}`) is the model for what
   * a real capture pipeline should store here.
   */
  readonly sha256?: string;
}

/* -------------------------------------------------------------------------- */
/* Conference                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which published rulebook's point tables a meet scores under.
 *
 * `'unknown'` is mandatory, not a convenience: `plans/2026-09-06/04-phasing.md`
 * Phase 4 requires that a meet whose ruleset cannot be determined "surface as
 * 'unknown ruleset,' never silently default to NCAA or NSISC".
 */
export type SwimCloudRuleset =
  | 'NCAA'
  | 'NAIA'
  | 'NFHS'
  | 'conference-custom'
  | 'unknown';

/**
 * A conference governing a set of {@link SwimCloudTeam}s.
 *
 * Source page: `/country/usa/college/conference/{slug}/`.
 */
export interface SwimCloudConference {
  /** From the URL path segment. */
  readonly slug: SwimCloudConferenceSlug;
  /** Display name as printed on the conference page heading. */
  readonly name?: string;
  /**
   * Country segment of the conference URL (`usa` in the documented pattern).
   * Optional because the short `/conference/{slug}/` form carries no country.
   */
  readonly country?: string;
  /** Level segment of the conference URL (`college` in the documented pattern). */
  readonly level?: string;
  /**
   * Scoring ruleset this conference's championship runs under.
   *
   * Absent means **not recorded**, which is a different fact from
   * `'unknown'` (recorded as undeterminable). Neither means NCAA.
   */
  readonly ruleset?: SwimCloudRuleset;
  /**
   * Member team ids, if the conference page listed them.
   *
   * An empty array means "the page listed a member table containing no teams";
   * `undefined` means "we never saw a member list". These are not the same
   * thing and must not be collapsed.
   */
  readonly teamIds?: readonly SwimCloudTeamId[];
}

/* -------------------------------------------------------------------------- */
/* Team                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether the school still fields the program. Mirrors `TeamProgramStatus` in
 * `packages/core/src/data/teamDivisions.ts`.
 */
export type SwimCloudProgramStatus = 'active' | 'discontinued' | 'unknown';

/**
 * One program — **one school, one gender**.
 *
 * This is the repo's `sponsoredGenders` rule expressed in the type system rather
 * than as a runtime check. A SwimCloud `/team/{id}/` page is a *school's* page;
 * its roster is filtered by a `gender` query parameter. UWF fields women's
 * swimming & diving and no men's program, so "the UWF team" is not a thing that
 * exists — the women's program does, and the men's does not. Consequently a
 * single {@link swimCloudTeamId} yields **two** `SwimCloudTeam` records at most,
 * and possibly one.
 *
 * Never synthesize the opposite-gender record from a page you only saw one
 * gender of. An unsighted program is absent, not `status: 'active'`.
 */
export interface SwimCloudTeam {
  /**
   * The team id from `/team/{id}/`. Shared by both genders of the same school —
   * it is **not** a unique key for this record.
   */
  readonly swimCloudTeamId: SwimCloudTeamId;
  /**
   * The gender this record is the program for. Required: there is no
   * gender-neutral team record, by design.
   */
  readonly gender: SwimCloudGender;
  /** School/program name as printed on the team page heading. */
  readonly name: string;
  /** Conference slug, if the team page named a conference. */
  readonly conferenceSlug?: SwimCloudConferenceSlug;
  /**
   * Division/affiliation label exactly as printed (e.g. `'NCAA Division II'`).
   *
   * Deliberately a free string rather than the core `NcaaDivision` enum: mapping
   * a printed label onto a division is a judgement call that belongs in the core
   * resolver (`teamDivisions.ts`), which already refuses to guess. Copying a
   * scraped label straight into an enum is how a D2 team gets scored against D1.
   */
  readonly divisionLabel?: string;
  /**
   * Program lifecycle. Defaults to nothing — an unstated status is `'unknown'`
   * only when the caller records it as such, never inferred from the mere
   * existence of a page (SwimCloud keeps pages for discontinued programs).
   */
  readonly status?: SwimCloudProgramStatus;
  /**
   * Season label the record describes, `YYYY-YYYY` (matching
   * `TeamSeasonLabel` in core). Rosters are season-scoped; a roster without a
   * season is not a roster for "now".
   */
  readonly season?: string;
}

/* -------------------------------------------------------------------------- */
/* Athlete                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One athlete, as SwimCloud presents them.
 *
 * Feeds the existing alias/name-variant flow (`suggestAliasCandidates` in
 * `packages/core`) as just another candidate row — this package deliberately
 * defines no second aliasing mechanism
 * (`plans/2026-09-06/02-data-model-and-scoring.md` §2).
 */
export interface SwimCloudAthlete {
  /**
   * From the `/swimmer/{id}/` link on the row.
   *
   * Optional: a roster row that is plain text with no profile link still names a
   * real athlete. Absence means "no profile link on this page", not "no such
   * swimmer".
   */
  readonly swimCloudSwimmerId?: SwimCloudSwimmerId;
  /** Name exactly as printed. No normalization, no re-ordering of name parts. */
  readonly name: string;
  /** Owning program, when the capture was a team-scoped page. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /** Team name as printed, for captures where only the label was available. */
  readonly teamName?: string;
  /** Class year as printed, mapped to the core vocabulary; `'unknown'` when unmapped. */
  readonly classYear?: SwimCloudClassYear;
  /**
   * Gender. On a roster capture this comes from the roster's own gender filter,
   * not from the athlete's name — never infer gender from a name.
   */
  readonly gender?: SwimCloudGenderOrUnknown;
  /**
   * Season label the roster row belongs to, `YYYY-YYYY`.
   *
   * A roster is a season snapshot; an athlete row without one cannot be assumed
   * current.
   */
  readonly season?: string;
  /**
   * Hometown string as printed.
   *
   * **Unverified** — SwimCloud may not expose this on every roster layout; do
   * not assume presence.
   */
  readonly hometown?: string;
}

/* -------------------------------------------------------------------------- */
/* Meet, Session, Event, Heat                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Meet format, which is the axis that selects the NCAA point table
 * (`plans/2026-09-06/02-data-model-and-scoring.md` §3).
 *
 * **Compatibility note**: a parallel workstream is adding a `MeetFormat`-shaped
 * ruleset/format type to `packages/core` for NCAA scoring. This union is
 * deliberately declared locally and **not** imported from core, so this package
 * stays free of a domain dependency. When core's type lands, these member names
 * should be reconciled with it (ideally by making core's the canonical type and
 * this one a documented mapping) rather than left to drift into two vocabularies
 * that silently disagree about what `'tri'` means.
 *
 * `'unknown'` is required for the same reason as {@link SwimCloudRuleset}: an
 * undetermined format must not fall through to the dual-meet table.
 */
export type SwimCloudMeetFormat =
  | 'dual'
  | 'tri'
  | 'quad'
  | 'relay-only'
  | 'invitational'
  | 'championship'
  | 'unknown';

/**
 * A meet — an occasion at a venue over a date range.
 *
 * Source page: `/results/{meetId}/`.
 */
export interface SwimCloudMeet {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** Meet name as printed. */
  readonly name: string;
  /**
   * Format. Captured at import time on purpose: §3 of the data-model plan is
   * explicit that this selects the point table and "must be captured at import
   * time, not guessed downstream".
   */
  readonly format: SwimCloudMeetFormat;
  /** Governing rulebook, or `'unknown'`. Never defaulted to `'NCAA'`. */
  readonly ruleset: SwimCloudRuleset;
  /**
   * Course the meet was swum in, or `'unknown'`.
   *
   * This is the only thing that can disambiguate a "Meter" event label into LCM
   * vs SCM. When it is `'unknown'`, every metric event under it stays
   * `'unknown'` too — the ambiguity propagates rather than being resolved by
   * assumption.
   */
  readonly course: SwimCloudCourseOrUnknown;
  /** Start date as printed, ISO-8601 `YYYY-MM-DD` when the page gave a parseable one. */
  readonly startDate?: string;
  /** End date as printed, ISO-8601 `YYYY-MM-DD`. Absent for a single-day meet that printed one date. */
  readonly endDate?: string;
  /** Venue/host as printed. */
  readonly venue?: string;
  /**
   * Number of competition lanes.
   *
   * **Unverified** — SwimCloud results pages are not known to publish lane
   * count; do not assume presence. It matters because NCAA Rule 7 uses a
   * different individual table at 6+ lanes (9-4-3-2-1) than at ≤5 lanes
   * (5-3-1), so an absent lane count must block table selection rather than
   * default to the 6+ table.
   */
  readonly laneCount?: number;
  /** Team ids that competed, when the page listed them. */
  readonly teamIds?: readonly SwimCloudTeamId[];
}

/**
 * Which pool of a championship a session belongs to.
 *
 * The distinction is load-bearing, not cosmetic: under NCAA Rule 7 places 1–6
 * score from the championship final **only** and 7–12 from the consolation final
 * **only**, and the two are never merged by time. Collapsing these into one
 * "finals" bucket is exactly the silently-wrong-number failure this repo's
 * provenance rules exist to prevent.
 */
export type SwimCloudSessionKind =
  | 'prelims'
  | 'championship-final'
  | 'consolation-final'
  | 'timed-final'
  | 'diving'
  | 'unknown';

/** A sub-occasion of a meet (prelims/finals, day 1/2). */
export interface SwimCloudSession {
  /** Stable within a meet; the capture supplies it (page ordinal is acceptable). */
  readonly sessionId: string;
  readonly swimCloudMeetId: SwimCloudMeetId;
  readonly kind: SwimCloudSessionKind;
  /** Session name as printed, e.g. `'Day 2 Finals'`. */
  readonly name?: string;
  /** Day ordinal within the meet, when printed. */
  readonly day?: number;
  /** ISO-8601 `YYYY-MM-DD`, when printed. */
  readonly date?: string;
}

/** Whether an event is contested by one athlete or by a relay unit. */
export type SwimCloudEventKind = 'individual' | 'relay';

/** One contested race within a session. */
export interface SwimCloudEvent {
  /** Stable within a meet; the capture supplies it. */
  readonly eventId: string;
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** Owning session, when the capture identified one. */
  readonly sessionId?: string;
  /**
   * The `{n}` segment of `/results/{meetId}/event/{n}/`, or the event number
   * printed in the heading.
   *
   * **Unverified** whether SwimCloud's `{n}` is the meet's printed event number
   * or an internal event id — see `plans/2026-09-06/04-phasing.md` open
   * question 2. Held as a string so the two cannot be conflated by arithmetic.
   */
  readonly eventRef?: string;
  /** Event label exactly as printed, e.g. `'Women 200 Yard Freestyle Relay'`. */
  readonly label: string;
  readonly kind: SwimCloudEventKind;
  /**
   * Course, as its own field.
   *
   * §1 of the data-model plan is explicit that course "needs to be a first-class
   * field on Event, not inferred from event name alone" — a 2024-era scraper fix
   * found SwimCloud appending an `L`/`S`/`Y` course suffix to event ids in
   * swimmer time histories precisely because the label alone is insufficient.
   */
  readonly course: SwimCloudCourseOrUnknown;
  readonly gender: SwimCloudGenderOrUnknown;
  /** Distance in the course's own unit. Absent when the label had no parseable distance. */
  readonly distance?: number;
  readonly stroke: SwimCloudStroke;
}

/**
 * A physical race within an event.
 *
 * **Unverified as a whole** — SwimCloud's own results view is not known to
 * expose heat/lane structure. This entity exists because raw Hy-Tek /
 * Meet-Manager ingestion is heat-and-lane based
 * (`plans/2026-09-06/02-data-model-and-scoring.md` §2), so the model should not
 * have to change shape if that path is ever added. Do not assume any SwimCloud
 * capture will populate it.
 */
export interface SwimCloudHeat {
  readonly heatId: string;
  readonly eventId: string;
  /** Heat number within the event. */
  readonly number?: number;
}

/* -------------------------------------------------------------------------- */
/* Entry, Result, Relay                                                        */
/* -------------------------------------------------------------------------- */

/**
 * An athlete's or relay unit's registration in an event, **pre-result**.
 *
 * Corresponds to `.cl2`-style Meet-Manager entry data if that ingestion path is
 * ever added.
 */
export interface SwimCloudEntry {
  readonly entryId: string;
  readonly eventId: string;
  /** Set for an individual entry. Mutually exclusive with {@link relayId}. */
  readonly swimCloudSwimmerId?: SwimCloudSwimmerId;
  /**
   * Athlete name exactly as printed, individual entries only. Absent for a
   * relay entry (a relay has no single athlete — see
   * {@link SwimCloudRelay.legs} for its athletes) and, same as
   * {@link swimCloudSwimmerId}, absent when the row's subject cell was
   * empty (already reported as `unparsed-row` and the entry skipped
   * entirely in that case — so in practice this is present whenever the
   * entry itself is).
   */
  readonly athleteName?: string;
  /** Set for a relay entry. Mutually exclusive with {@link swimCloudSwimmerId}. */
  readonly relayId?: string;
  /** Entering team. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /**
   * Team name exactly as printed on the row, e.g. `'Henderson State'`.
   *
   * Distinct from {@link swimCloudTeamId}: a caller filtering a meet-results
   * capture down to "just my team" has a plain-text team name typed by a
   * coach, not a SwimCloud numeric id — this is what makes that filter
   * possible without a separate id-to-name lookup table this package
   * deliberately doesn't maintain (`03-architecture.md` §1: no persistence
   * layer here). Mirrors {@link SwimCloudRelay.teamName}.
   */
  readonly teamName?: string;
  /** Seed time as printed. Absent for an unseeded/`NT` entry — never `0`, never `'99:99.99'`. */
  readonly seedTime?: SwimCloudTimeString;
  /** Heat assignment. **Unverified** — see {@link SwimCloudHeat}. */
  readonly heatId?: string;
  /** Lane assignment. **Unverified** — SwimCloud may not expose this; do not assume presence. */
  readonly lane?: number;
}

/**
 * Non-scoring states a swim can be in.
 *
 * These are deliberately separate booleans rather than one enum because NCAA
 * Rule 7 treats them differently and they can co-occur: a DQ scores nothing and
 * does **not** bump the places below it (points are lost from the meet, not
 * redistributed); an exhibition swim is removed *before* deciding who scores, so
 * an exhibition 2nd place does not consume a scoring slot; and a no-show
 * (scores nothing at all) is a different state from a coach-initiated forfeit
 * (scores 11-0), which is why `noShow` and `forfeit` are not one flag.
 */
export interface SwimCloudResultFlags {
  readonly disqualified?: boolean;
  readonly exhibition?: boolean;
  readonly scratched?: boolean;
  readonly noShow?: boolean;
  readonly forfeit?: boolean;
}

/**
 * The post-meet outcome for an entry.
 *
 * **On `points`, this type's own history is worth knowing.** Phase 1's plan
 * doc (`02-data-model-and-scoring.md` §2) and this file originally banned a
 * points field outright: "points are derived from place, DQ status,
 * exhibition flag, ties, resolved point table... never stored as an
 * authoritative import value" — the same discipline `CLAUDE.md` applies to
 * `cutlines.ts`, on the working assumption that a scraped points column
 * couldn't be trusted. That assumption was overridden 2026-09-07 on the
 * user's direct, first-hand confirmation that SwimCloud's printed points
 * *are* trustworthy — new information, not a discipline violation: this repo
 * already had exactly this escape hatch for HyTek PDFs
 * (`SwimmerResult.pdfPoints` / `usePdfPlacePoints` in `packages/core`), for
 * the identical reason (a specific source's own points, once confirmed
 * trustworthy, beat a table the app would otherwise have to guess the meet's
 * format to reconstruct). `{@link points}` is this parser's side of that same
 * exception, captured the same way every other field in this type is —
 * verbatim, warned-about when unparseable, never fabricated — and it is
 * still the *caller's* decision whether to actually trust it for scoring,
 * exactly as `usePdfPlacePoints` is a caller decision for a PDF import, not
 * something this package decides on a caller's behalf.
 */
export interface SwimCloudResult {
  readonly resultId: string;
  readonly entryId: string;
  readonly eventId: string;
  /**
   * Finish place. Absent for a DQ/scratch/exhibition row, or for any row whose
   * place cell did not hold a positive integer. Absent is never `0`.
   */
  readonly place?: number;
  /**
   * Points exactly as printed in a Points column, when the page has one and
   * the cell held a non-negative number. See this type's own doc comment for
   * why this field exists at all. Absent when there's no Points column, the
   * cell was blank, or it didn't parse — never `0` for "didn't parse."
   */
  readonly points?: number;
  /** The Points cell's raw contents, kept verbatim whenever {@link points} could not be populated from it. */
  readonly rawPointsToken?: string;
  /**
   * Final time as printed. Absent when the time cell held a non-time marker
   * (`DQ`, `NS`, `SCR`, …) or anything unrecognized.
   */
  readonly finalTime?: SwimCloudTimeString;
  /**
   * The raw contents of the time cell, kept verbatim whenever
   * {@link finalTime} could not be populated.
   *
   * This is what makes an unparseable cell auditable instead of invisible: the
   * token survives so a human can see what SwimCloud actually printed, without
   * any code being tempted to coerce it into a number.
   */
  readonly rawTimeToken?: string;
  readonly flags?: SwimCloudResultFlags;
  /**
   * Reaction time. **Unverified** — SwimCloud may not expose this; do not assume
   * presence.
   */
  readonly reactionTime?: string;
  /** Owning session, when the capture identified one. */
  readonly sessionId?: string;
}

/**
 * One leg of a relay.
 *
 * Per the OpenTrack nested-sub-race pattern the plan adapts, a leg is a small
 * performance record rather than a position in a text blob.
 */
export interface SwimCloudRelayLeg {
  /** Leg order, 1-based, as swum. */
  readonly order: number;
  /** The athlete's SwimCloud id, when the page linked a profile. */
  readonly swimCloudSwimmerId?: SwimCloudSwimmerId;
  /** Leg swimmer's name as printed. */
  readonly athleteName?: string;
  /**
   * Split for this leg.
   *
   * **Unverified — SwimCloud may not expose this; do not assume presence.**
   * Whether SwimCloud's results pages publish relay leg splits at all is an
   * open question (`plans/2026-09-06/04-phasing.md` open question 4). If they do
   * not, this field stays absent permanently rather than being reconstructed by
   * subtracting cumulative times, which would be fabrication.
   */
  readonly splitTime?: SwimCloudTimeString;
}

/**
 * A team's relay unit for one event.
 *
 * Not a fifth top-level swimmer table: this is a team-level entry/result whose
 * leg list is an ordered `(athlete, splitTime?)` collection.
 */
export interface SwimCloudRelay {
  readonly relayId: string;
  readonly eventId: string;
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /** Team name as printed on the relay row, e.g. `'Henderson State'`. */
  readonly teamName?: string;
  /**
   * Relay designator as printed, e.g. `'A'`, `'B'`.
   *
   * Kept because NCAA relay scoring caps how many relays per team score, so
   * which unit a row is matters. Absent when the page printed none — do not
   * default an unlabelled relay to `'A'`.
   */
  readonly designator?: string;
  /**
   * Legs in swum order.
   *
   * An **empty array** means "the page showed a relay with no legs listed",
   * which is the expected case if SwimCloud does not publish legs at all. It is
   * a different fact from `undefined` ("we never looked for legs on this
   * capture") — do not collapse the two.
   */
  readonly legs: readonly SwimCloudRelayLeg[];
}
