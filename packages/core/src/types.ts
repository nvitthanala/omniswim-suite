import type { RaceConfig, RaceTag } from './lib/raceAnalysis';
import type { NcaaMeetFormat } from './lib/ncaaScoringRules';

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum Gender {
  MEN = 'Men',
  WOMEN = 'Women',
}

export enum ClassYear {
  FR = 'FR',
  SO = 'SO',
  JR = 'JR',
  SR = 'SR',
  HS = 'HS', // For recruits
}

/** Medley order; freestyle relay legs are all `free`. */
export type RelayLegStroke = 'back' | 'breast' | 'fly' | 'free';

export interface RelayMissingLeg {
  stroke: RelayLegStroke;
  legIndex: number;
  reason: 'vacant' | 'no_replacement' | 'stroke_mismatch';
}

export type RelaySplitSegment = {
  /** Segment length in yards (25 if detected, else 50/100/150/200). */
  yards: number;
  /** Segment split time (usually parenthesized HyTek value). */
  segmentTime: string;
  /** Optional cumulative time within the leg at this mark. */
  cumulativeLeg?: string;
};

export type RelayLegSplitDetail = {
  legIndex: number;
  stroke: RelayLegStroke;
  legDistanceYards: number;
  segments: RelaySplitSegment[];
  legTotal?: string;
};

export type RelayTeamSplitSummary = {
  /** Per-leg contribution times, index 0 = leadoff. */
  legTotals: (string | null)[];
  firstHalf?: string;
  secondHalf?: string;
  teamTotal: string;
};

export interface SwimmerResult {
  id: string;
  rank: number;
  name: string;
  classYear: ClassYear | string;
  team: string;
  time: string; // "1:45.08" or "20.45"
  points: number | string;
  event: string;
  gender?: Gender;
  isRecruit?: boolean;
  prelimsTime?: string;
  finalsTime?: string;
  roundSwam?: string;
  isRelay?: boolean;
  isExhibition?: boolean;
  isTimeTrial?: boolean;
  relayNames?: { name: string; year: string }[];
  /** 0-based leg index for this row when expanded from a relay (0..3). */
  relayLegIndex?: number;
  relayLegStroke?: RelayLegStroke;
  /** Parsed HyTek leg split (parenthesized segment); team time stays in `time` / `finalsTime`. */
  relayLegSplit?: string;
  relayTeamTime?: string;
  relayLegSplitDetail?: RelayLegSplitDetail;
  relayTeamSplits?: RelayTeamSplitSummary;
  relayMissingLeg?: RelayMissingLeg;
  /** True when this leg slot is open after senior/delete simulation (awaiting fill). */
  relayLegVacant?: boolean;
  /** HyTek place points from PDF Points column; overrides calculated scoring when set. */
  pdfPoints?: number;
  /** Row imported from a psych sheet PDF (seed time projection). */
  isPsychSheet?: boolean;
}

/** Swimmers removed from the workspace; excluded from individuals and treated as departed relay legs. */
export interface DeletedSwimmerRef {
  name: string;
  gender: Gender;
  /**
   * How the athlete was removed:
   *  - 'hidden'  (default): what-if only — source rows stay, projection drops them.
   *  - 'removed': permanent — their individual working rows were stripped from
   *    menResults/womenResults too, so they leave the baseline roster as well.
   * Absent is treated as 'hidden' for backward compatibility.
   */
  mode?: 'hidden' | 'removed';
}

export interface TeamScore {
  teamName: string;
  totalPoints: number;
  swimmers: SwimmerResult[];
  /** School primary (card border, legend swatch). */
  color: string;
  /** Stroke color for multi-team timeline lines (may differ when disambiguating). */
  lineColor?: string;
  /** Recharts dash pattern for timeline when multiple teams share similar colors. */
  strokeDasharray?: string;
}

export interface ScoringSettings {
  scoringPoints: number[];
  relayMultiplier: number;
  halfRateRelaySwimmer: boolean;
  maxIndividualScorersPerTeam: number;
  /** Max scoring relay entries per team within each relay event (not meet-wide). */
  maxRelaysScoringPerTeam: number;
  /** Places in the first final (e.g. 8) for A+B 16-deep tables; default half of scoringPoints length. */
  aFinalBracketSize?: number;
  /** Round/event substrings that earn no team points (case-insensitive). */
  unscoredRounds?: string[];
  /**
   * Last event number in the meet's scored program, from the HyTek
   * "Team Rankings - Through Event N" line (`OfficialTeamScores.eventThrough`).
   *
   * HyTek numbers post-meet extra sessions outside the program — time trials,
   * record attempts, exhibition swims — and excludes them from the published
   * team totals. Most carry "Time Trial" in the event name and are caught by
   * `unscoredRounds`, but the meet host is free to omit that suffix, and then
   * nothing in the label distinguishes an extra swim from a championship final.
   * The event number does. A row whose label parses to `Event N` with
   * `N > scoredEventNumberMax` earns no team points.
   *
   * Meet-scoped, not a conference rule: normally injected by `calculatePoints`
   * from `CalculatePointsOptions.scoredEventNumberMax`. Omit to score every
   * event, which is the behaviour when the meet publishes no boundary.
   */
  scoredEventNumberMax?: number;
  /** When `'meet'`, individual scorer cap applies across the full meet (chronological). Relay cap is always per relay event. */
  scorerCapScope?: 'meet' | 'event';
  /** Weight toward maxIndividualScorersPerTeam for diving events (e.g. 1/3 for NSISC). */
  diverScorerWeight?: number;
  /** Substrings matched against event name to detect diving (default: DIVING, DIVE). */
  diverEventPattern?: string[];
  /** Relays score only if every leg swimmer is in the meet individual scorer pool (legacy). */
  relayEligibleFromScorerPool?: boolean;
  /**
   * `points_pool` — scorers from individual points + optional relay pool rule.
   * `roster` — explicit roster table (auto rules + manual overrides); relays use roster only.
   */
  scorerEligibilityMode?: 'points_pool' | 'roster';
  /**
   * Use HyTek PDF Points column per row when present (short-circuit engine).
   * `auto` / omit: enable when enough rows have `pdfPoints` (uploads from meets with Points column).
   */
  usePdfPlacePoints?: boolean | 'auto';
  /** Auto-mark scorers from meet swims when using roster mode (conference presets set these). */
  scorerAutoRules?: ScorerAutoRules;
  /** Max individual (non-relay) events a swimmer may enter in the meet. */
  maxIndividualEntriesPerSwimmer?: number;
  /** Max relay events (distinct relay entries) a swimmer may swim. */
  maxRelayEntriesPerSwimmer?: number;
  /** Max total events (individual + relay combined) a swimmer may enter. When set, overrides separate limits. */
  maxTotalEntriesPerSwimmer?: number;

  /**
   * The relay place-value table, place 1 first — used instead of
   * `scoringPoints[place] * relayMultiplier`.
   *
   * `relayMultiplier` is exactly right for every championship field size: the
   * rulebook's relay table is precisely 2x its individual table at 6, 8, 12, 16,
   * 18 and 24 qualifiers. It cannot express a non-championship format at all.
   * NCAA Rule 7-1-1 scores a six-lane dual 9-4-3-2-1-0 for individuals and
   * **11-4-2-0** for relays; 11 is not twice 9. Rule 7-1-2 pairs 5-3-1-0 with
   * **7-0**. Rule 7-3 scores a relay meet 14-10-8-6-4-2. A scalar multiplier
   * turns each of those into a plausible, wrong team total.
   *
   * Absent (the default, and the shape of every preset saved before 2026-09-20)
   * keeps the multiplier path byte-for-byte. Present, it wins, and
   * `relayMultiplier` is not consulted. The table may be shorter than
   * `scoringPoints` — a relay placing past its end scores 0, which is how
   * 11-4-2-0 stops a fourth-place relay from scoring in a six-lane dual.
   *
   * Source: NCAA Rule 7, archived at `data/scoring_rules/sources/ncaascoring.pdf`.
   * Never hand-type one of these; generate it from `NCAA_FORMAT_RULESETS`.
   */
  relayPoints?: number[];

  /**
   * The diving place-value table, place 1 first — used instead of
   * `scoringPoints` for any event `diverEventPattern` matches.
   *
   * NCAA Rule 7-1-4 gives dual-meet diving its own three tables, chosen by how
   * many divers the teams field: 7-5-4-3-2-1 (a team with three or fewer),
   * 9-7-6-5-3-2-1 (four or five), 16-13-12-11-10-9-7-5-4-3-2-1 (both with six or
   * more). Those differ from the swimming table in the same meet, so a dual meet
   * needs two tables at once. Before this field the only diving-specific knob was
   * `diverScorerWeight`, which changes how much of the scorer pool a diver
   * consumes and nothing about what a dive is worth.
   *
   * Absent (the default) scores diving from `scoringPoints`, unchanged.
   *
   * Source: NCAA Rule 7-1-4. Generate it from `NCAA_FORMAT_RULESETS`.
   */
  divingPoints?: number[];

  /**
   * How many contestants from one team may take a scoring place in a single
   * event — NCAA Rule 7-1-1's "with only the best three contestants from each
   * team scoring" (7-1-2: two; 7-2: three; 7-1-4: three, four or six).
   *
   * This is **not** `maxIndividualScorersPerTeam`, which caps scorer *units* — a
   * pool of athletes a team may score with across the meet (NSISC's 18), spent
   * fractionally by divers via `diverScorerWeight`. That pool asks "how many
   * athletes may score at all"; this asks "how many of them may finish in the
   * places of one event". A meet can apply both, and a dual meet applies only
   * this one.
   *
   * Counts distinct athletes, in place order, per team, per event. Absent (the
   * default) means no cap and no behaviour change. What happens to the entries
   * behind an over-cap finisher is {@link ScoringSettings.overCapPlaceBehavior}.
   */
  maxIndividualScorersPerTeamPerEvent?: number;

  /**
   * `maxIndividualScorersPerTeamPerEvent` for events `diverEventPattern` matches,
   * when diving caps differently from swimming in the same meet.
   *
   * It does in every NCAA dual meet. Rule 7-1-1 scores three contestants per team
   * in a six-lane swimming event; Rule 7-1-4 scores three, four or six in the
   * diving event alongside it, chosen by how many divers the teams field. One
   * scalar cannot say both, and using the swimming cap for diving silently drops
   * a team's fourth through sixth divers.
   *
   * Pairs with {@link ScoringSettings.divingPoints} exactly as
   * `maxIndividualScorersPerTeamPerEvent` pairs with `scoringPoints`. Absent, the
   * swimming cap applies to diving too — which is right whenever the meet states
   * one cap, and is the behaviour of every preset that sets neither field.
   */
  divingMaxScorersPerTeamPerEvent?: number;

  /**
   * What an over-`maxIndividualScorersPerTeamPerEvent` finisher does to the
   * entries behind them.
   *
   * - `'holds-place'` (the default) — the over-cap contestant keeps the place
   *   they achieved and scores 0. Nobody moves up, and that place's points are
   *   lost from the meet.
   * - `'removed-from-consideration'` — the over-cap contestant is dropped before
   *   places are awarded, exactly as an exhibition swim is, so every contestant
   *   behind them in the same round advances one place.
   *
   * The rulebook does not settle this. Rule 7-1-1 says only "with only the best
   * three contestants from each team scoring". Rules 7-7-1 and 7-10-1 use the
   * phrase "removed from consideration", and say "all other competitors may
   * advance in position", precisely where they do intend re-ranking — and
   * Rule 7-1 does not use it. `holds-place` is therefore the literal reading and
   * the default, matching {@link NcaaScoringOptions.overCapBehavior} in
   * `ncaaScoringRules.ts`, which is this repo's transcribed source of truth.
   * Set `'removed-from-consideration'` deliberately, against a host's published
   * meet rules — do not leave it to chance, because the two readings give
   * different team totals whenever a team out-depths the field.
   *
   * Advancement never crosses a finals round: a consolation finisher cannot be
   * promoted into a place the championship final contested (Rule 7-6-8).
   */
  overCapPlaceBehavior?: 'holds-place' | 'removed-from-consideration';

  /**
   * The NCAA Rule 7 meet format this settings object was generated from.
   *
   * Provenance only — it records which `NCAA_FORMAT_RULESETS` entry produced
   * these numbers so a UI can name the rule and a reviewer can re-derive them.
   * The scoring engine never branches on it: two settings objects with identical
   * tables score identically whatever this says, and a hand-authored preset may
   * leave it absent. Conference presets (NSISC) are not NCAA formats and carry
   * no value here.
   */
  meetFormat?: NcaaMeetFormat;
}

export interface ScorerAutoRules {
  /** Final tiers that mark an athlete as a team scorer (default A + B). */
  abFinalTiers?: Array<'A' | 'B'>;
  /** Relay legs in those finals count as scorers. */
  includeRelayLegsInFinals?: boolean;
  /** Distance events only count when the swim is A/B final, not prelims-only. */
  distanceFinalRequired?: boolean;
  distanceEventPattern?: string[];
}

/** Manual override for team scorer roster (persisted on workspace). */
export interface ScorerRosterOverride {
  name: string;
  team: string;
  gender: Gender;
  isScorer: boolean;
}

export interface ScoringPresetMeta {
  id: string;
  label: string;
  description?: string;
  /**
   * True for a preset the app ships and derives from `NCAA_FORMAT_RULESETS` (or
   * the hand-defined conference presets). Built-ins are immutable: the write
   * routes reject their ids rather than accepting an edit they would discard.
   * Absent is treated as false — a preset read off disk.
   */
  builtIn?: boolean;
  /** Rule citation the numbers came from, e.g. `'NCAA Rule 7-1-1'`. Absent for a user preset. */
  citation?: string;
  /** The `NCAA_FORMAT_RULESETS` key this was generated from. Absent for conference and user presets. */
  meetFormat?: NcaaMeetFormat;
  /**
   * True when the governing body publishes no point table for this format and the
   * user must supply one — NCAA Rule 7-4 leaves invitational tables to the host.
   * Such a preset carries **no** `scoringPoints`; fetching its settings fails
   * rather than handing back an invented default. See CLAUDE.md § Data provenance.
   */
  requiresHostPublishedTable?: boolean;
  /** Heading a picker can group by, e.g. `'NCAA dual meets'`. Presentation only. */
  group?: string;
  /**
   * Uppercased substrings that select this preset from a workspace's conference
   * name. Replaces the conference names that used to be hardcoded inside
   * `presetIdForConference`. See `conferencePresetBindings` in `scoringDefaults.ts`.
   */
  conferenceMatches?: string[];
}

/** HyTek official team totals from PDF Team Rankings pages. */
export interface OfficialTeamScores {
  eventThrough?: number;
  men: Record<string, number>;
  women: Record<string, number>;
}

/** Manual assignment for a vacant relay leg in what-if projection. */
export interface RelayLegOverride {
  relayEntryKey: string;
  legIndex: number;
  assigneeName?: string;
  recruitId?: string;
  classYear?: ClassYear | string;
  manualLegTime?: string;
  source?: 'manual' | 'drag' | 'autofill';
  /**
   * Ordered fallback swimmer names for this leg (roster-resolved), captured from a
   * scoring-theory parse (e.g. "Colton/Hunter/Alan" → primary Colton, alternates
   * [Hunter, Alan]). Additive/optional: legacy overrides omit it. Consumed by
   * suggestRelayAlternatePromotions (scoringTheory.ts) to auto-fill a leg whose
   * primary becomes unavailable.
   */
  alternates?: string[];
}

export interface LoadedMeetMeta {
  pdfFilename?: string;
  uploadedAt: number;
  conference?: string;
  meetLabel?: string;
  /** Optional tie to linked psych sheet upload timestamp. */
  linkedPsychUploadedAt?: number;
}

export interface LoadedPsychMeta {
  pdfFilename?: string;
  uploadedAt: number;
  format?: 'auto' | 'regular' | 'divided';
  linkedMeetUploadedAt?: number;
}

export interface PlannedSwimEntry {
  id: string;
  name: string;
  team: string;
  gender: Gender;
  classYear?: ClassYear | string;
  event: string;
  time: string;
  timeType?: 'SCY' | 'LCM' | 'SCM';
  source: 'manual' | 'swimcloud' | 'pdf' | 'optimizer';
  replacesResultId?: string;
  active?: boolean;
  projectedRank?: number;
  projectedRound?: string;
}

export type SwimCloudBadge =
  | 'none'
  | 'extracted'
  | 'user_input'
  | 'd1_a'
  | 'd1_b'
  | 'other';

export type NcaaDivision = 'D1' | 'D2' | 'D3' | 'NAIA';

export interface HistoricalSwim {
  /**
   * Stable id. Optional and additive: rows imported before this field existed
   * (paste/OCR/CSV) carry no id and are still read normally; the swim editor
   * (lib/swimEditor.ts) assigns one to rows it creates so they can be referenced
   * for edit/remove. Nothing keys dedup/scoring on it.
   */
  id?: string;
  name: string;
  team: string;
  gender: Gender;
  event: string;
  time: string;
  timeType?: 'SCY' | 'LCM' | 'SCM';
  date?: string;
  meetLabel?: string;
  /** 'swimcloud' — a personal best converted from packages/swimcloud's parseSwimmerProfileHtml output, either access track. */
  source: 'pdf' | 'paste' | 'ocr' | 'csv' | 'manual' | 'swimcloud';
  classYear?: string;
  swimcloudBadge?: SwimCloudBadge;
  computedCut?: 'A' | 'B' | null;
  /**
   * The time was taken out of a longer swim's splits, not swum as a race of
   * this distance.
   *
   * SwimCloud marks these `X` / `title="Extracted"`. Avery Henke's "50 Breast
   * SCY 25.16" and "100 Breast SCY 54.09" share one swim id: the 25.16 is the
   * first half of the 100, never a 50 Breast he stood up and swam.
   *
   * **Not a personal best**, so it is kept out of
   * {@link AthleteEventProfile.bestByEvent} and never cut-tagged, ranked or
   * planned as an entry. It is kept, tagged, in
   * {@link AthleteEventProfile.extractedByEvent}, where it stands in for a
   * relay leg when the swimmer has no standalone time at that distance —
   * a real measured half of a race is a far better estimate of a relay split
   * than nothing.
   *
   * A relay **leadoff** is the opposite case and carries no flag: it starts
   * from the blocks and finishes to the hand, so it is the individual swim and
   * is imported as one.
   */
  isExtractedSplit?: boolean;
}

export interface AthleteEventProfile {
  name: string;
  team: string;
  gender: Gender;
  bestByEvent: Record<string, { time: string; timeSec: number; source: string }>;
  /**
   * Times taken out of a longer swim's splits, keyed like
   * {@link bestByEvent} and deliberately kept apart from it.
   *
   * These are placeholders, not bests. They fill a relay leg the swimmer has
   * no standalone time for — see `findCalculatedSplit` — and are excluded from
   * every place a best is treated as a real result: rankings, cut tags,
   * entry planning. See {@link HistoricalSwim.isExtractedSplit}.
   */
  extractedByEvent: Record<string, { time: string; timeSec: number; source: string }>;
  primaryEvents: string[];
  relayEvents: string[];
  /**
   * How good each swim is relative to the published standard for that event —
   * `swimSeconds / standardSeconds`, so lower is better and 1.0 is exactly on the
   * mark. This is what `primaryEvents` is ordered by. Absent for events with no
   * published standard; see {@link AthleteEventProfile.unrankedEvents}.
   */
  qualityByEvent?: Record<string, number>;
  /**
   * Events held but not rankable: no published standard for this division, or the
   * team's division is unknown. Listed rather than silently ordered last as though
   * the athlete were weak in them — absent is not the same as bad.
   */
  unrankedEvents?: string[];
  /** Division the ranking was computed against. `null` when the team is unmapped. */
  rankingDivision?: NcaaDivision | null;
  /** Published tier the ratios were measured against, one tier for the whole profile. */
  rankingTier?: 'A' | 'B' | null;
}

export interface Workspace {
  id: string;
  name: string;
  menResults: SwimmerResult[];
  womenResults: SwimmerResult[];
  /**
   * Frozen PDF meet copy used for baseline scoring.
   * When absent, baseline falls back to menResults/womenResults (legacy workspaces).
   */
  sourceMenResults?: SwimmerResult[];
  sourceWomenResults?: SwimmerResult[];
  recruits: Recruit[];
  createdAt: number;
  scoringSettings?: ScoringSettings;
  /** Conference detected from PDF (e.g. NSISC). */
  conference?: string;
  deletedSwimmers?: DeletedSwimmerRef[];
  /** Manual scorer flags; auto rules fill the rest unless overridden. */
  scorerRosterOverrides?: ScorerRosterOverride[];
  /** Official meet team totals parsed from PDF Team Rankings block. */
  officialTeamScores?: OfficialTeamScores;
  /** What-if relay leg fills keyed by relayEntryKey + legIndex. */
  relayLegOverrides?: RelayLegOverride[];
  /** Metadata for the PDF currently loaded in this workspace. */
  loadedMeet?: LoadedMeetMeta;
  /** Psych sheet results (individual entries only; no relay lineups). */
  psychMenResults?: SwimmerResult[];
  psychWomenResults?: SwimmerResult[];
  loadedPsych?: LoadedPsychMeta;
  /** What-if meet entry plans (overlay or plan sheet). */
  meetEntryPlans?: PlannedSwimEntry[];
  entryPlanMode?: 'overlay' | 'plan_sheet';
  /**
   * Matrix scoring view. `merged` (default when absent) remaps imported/planned/
   * recruit rows onto the loaded meet's real event groups so they compete inside
   * the PDF field. `pdf_only` scores the loaded meet alone (plans + recruits are
   * excluded; deletions, relay overrides and other PDF-native adjustments still
   * apply).
   */
  scoringView?: 'merged' | 'pdf_only';
  activeEntryIds?: string[];
  /** Supplemental swims from paste/OCR/CSV imports. */
  athleteHistory?: HistoricalSwim[];
  raceAnalyses?: Array<{ id: string; swimmerName: string; video: { fileName: string; duration: number; width: number; height: number; fps?: number }; config: RaceConfig; tags: RaceTag[]; createdAt: number; updatedAt: number }>;
  historySources?: { type: string; label: string; importedAt: number }[];
  /**
   * Confirmed athlete name-identity links: each row declares that `aliasName`
   * and `canonicalName` are the same human (e.g. "Stevie Balistreri" ==
   * "Steven Balistreri"). Used by buildAliasResolver to unify duplicate athletes
   * across import spellings. No hardcoded nickname tables — links are created by
   * the user (or accepted import suggestions).
   */
  athleteAliases?: AthleteAliasLink[];
}

/** Who created an alias link: a human decision, or the auto-linker heuristic. */
export type AliasLinkOrigin = 'user' | 'auto';

/**
 * Evidence strength that justified an automatic link.
 *  - `conclusive` — the two spellings are identical after folding case, whitespace,
 *    punctuation and diacritics ("Oliver Pozvai" == "Olivér Pózvai").
 *  - `strong`     — a recognized name-variant relation PLUS at least one exact
 *    individual-event time shared across sources (relay times are never used).
 *  - `moderate`   — a recognized name-variant relation with an identical surname,
 *    where exactly one side competed and the other exists only in imported data.
 */
export type AliasEvidenceTier = 'conclusive' | 'strong' | 'moderate';

/** Which rule fired to produce an automatic link (audit trail). */
export type AliasAutoRule =
  | 'identical_after_folding'
  | 'name_variant_time_corroborated'
  | 'name_variant_import_only';

/** One exact time shared by both spellings, in the same individual event and course. */
export interface AliasTimeMatch {
  /** Normalized individual program event ("50 freestyle"). Relays never appear here. */
  event: string;
  /** The shared clock string as displayed ("20.59"). */
  time: string;
  course: 'SCY' | 'LCM' | 'SCM';
}

/**
 * Why a link exists. Present on auto-created links (and optionally on user links).
 * Absent ⇒ the link predates provenance tracking and is treated as `origin: 'user'`.
 */
export interface AliasLinkProvenance {
  origin: AliasLinkOrigin;
  /** Which auto rule fired. Absent for user links. */
  rule?: AliasAutoRule;
  tier?: AliasEvidenceTier;
  /** Name-relation score in [0,1] that the decision was made at. */
  score?: number;
  /** Human-readable justification, safe to render in an audit panel. */
  reason?: string;
  /** Exact individual-event time corroboration used (empty/absent = none). */
  timeMatches?: AliasTimeMatch[];
  /** Which side of the link was seen in competed meet results. */
  competedSide?: 'canonical' | 'alias' | 'neither';
  decidedAt?: string;
  /** Why the row was turned into a suppression tombstone. */
  suppressedReason?: 'user_unlink' | 'user_reject';
  suppressedAt?: string;
  note?: string;
}

/**
 * A confirmed link declaring two name spellings are the same athlete.
 * `aliasName` resolves to `canonicalName`. Scope: always gender-specific;
 * team-scoped when `team` is set (team-scoped links take precedence over global).
 *
 * Rows with `status: 'suppressed'` are TOMBSTONES, not links: they resolve
 * nothing, and they permanently block the auto-linker from re-proposing that
 * pair. Tombstones live in the same `athleteAliases` array (and therefore the
 * same `athlete_aliases` persistence table) so a user's "unlink" survives a
 * reload and a re-import without any schema change.
 */
export interface AthleteAliasLink {
  id: string;
  gender: Gender;
  team?: string;
  canonicalName: string;
  aliasName: string;
  source: 'manual' | 'import';
  createdAt?: string;
  /** Absent ⇒ `'active'`. See the tombstone note above. */
  status?: 'active' | 'suppressed';
  /** Audit trail: which rule/evidence produced this row. */
  provenance?: AliasLinkProvenance;
}

export interface Recruit {
  id: string;
  name: string;
  team: string;
  event: string;
  time: string;
  gender: Gender;
  classYear: ClassYear;
  timeType: 'SCY' | 'LCM' | 'SCM';
}

export interface ConversionFactors {
  [event: string]: {
    men_lcm: number;
    women_lcm: number;
    both_scm: number;
  };
}
