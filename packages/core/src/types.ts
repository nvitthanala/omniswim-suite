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
  name: string;
  team: string;
  gender: Gender;
  event: string;
  time: string;
  timeType?: 'SCY' | 'LCM' | 'SCM';
  date?: string;
  meetLabel?: string;
  source: 'pdf' | 'paste' | 'ocr' | 'csv' | 'manual';
  classYear?: string;
  swimcloudBadge?: SwimCloudBadge;
  computedCut?: 'A' | 'B' | null;
}

export interface AthleteEventProfile {
  name: string;
  team: string;
  gender: Gender;
  bestByEvent: Record<string, { time: string; timeSec: number; source: string }>;
  primaryEvents: string[];
  relayEvents: string[];
}

export interface Workspace {
  id: string;
  name: string;
  menResults: SwimmerResult[];
  womenResults: SwimmerResult[];
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
  activeEntryIds?: string[];
  /** Supplemental swims from paste/OCR/CSV imports. */
  athleteHistory?: HistoricalSwim[];
  historySources?: { type: string; label: string; importedAt: number }[];
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
