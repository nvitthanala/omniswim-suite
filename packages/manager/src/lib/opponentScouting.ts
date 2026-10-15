/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: scout one opponent team against the coach's own lineup. Pure functions. No React, no fetch,
 * no storage, no clock.
 *
 * ## What it compares
 *
 * Two sets of individual swim rows for ONE gender:
 *
 * - **ours**: the coach's lineup as the app already scores it (`ScoringBundle.allScored` for the
 *   selected team): meet swims, seeds and planned entries.
 * - **theirs**: the opponent's measured best times, as `buildTheoreticalMeetSeeds` makes them
 *   (`SwimmerResult` rows, one per swimmer and event, all-time best in SCY).
 *
 * ## No new scoring math
 *
 * Places and points come from the engine. The two sides are ranked in each event by time (standard
 * competition ranking, a shared place only on an exact tie, the rule `buildTheoreticalMeetWorkspace`
 * uses), banded A, B and C Final by the settings' own bracket, and scored by `calculatePoints`. That is
 * the call that builds the Standings of a theoretical meet. This file holds no point table and no scorer
 * cap of its own. The meet-wide scorer pool is the engine's.
 *
 * ## The per-team cap
 *
 * When the scoring rules state a per-team cap per event (`maxIndividualScorersPerTeamPerEvent`, three in
 * an NCAA dual meet), each side is cut to its fastest swimmers up to that cap BEFORE places are set. A
 * swimmer past the cap does not race for a place in a dual meet. Left in, a fourth opponent swimmer would
 * hold a place and score nothing ahead of ours. Swimmers cut this way are listed in `cappedOut`, never
 * dropped silently.
 *
 * ## Definitions
 *
 * - **Leader.** The side with the faster best entry in the event. Compared in whole hundredths of a second,
 *   so float noise cannot make a tie into a win. An exact tie is its own bucket.
 * - **Margin.** The gap between the two best entries, in seconds.
 * - **Swap.** Our best entry and their best entry trade times, and the whole meet is scored again by the
 *   same engine call. `ourChange` and `theirChange` are the change in each team's total. A meet-wide scorer
 *   pool can move points in other events too, so the totals are compared, not just this event.
 * - **Swing event.** An event where two entries of opposite teams finish next to each other, at least one
 *   of them in a scoring place, and trading their times changes which team leads the event's points. The
 *   event is scored again by the same engine call for each such pair. Swing events are ranked by the
 *   smallest such gap as a percent of the slower time. No threshold is used. A swing event is NOT a
 *   claim that the meet result would flip.
 *
 * ## Absent is not empty
 *
 * An event where one side has no time is listed in `noTime` with the side that is missing. It is left out of
 * wins, losses, ties, swing events and both totals. Nothing is invented to fill the side.
 *
 * ## Not scouted, and why
 *
 * Relays (the other team's relay time would be a sum of four individual bests that no team swam),
 * diving (scored in points, not time, and a crawled page holds no dive time), events with no recognised
 * individual name, and swims that are not a plain yards swim (exhibition, time trial, converted estimate,
 * non-SCY label, no valid time). Each is listed with its reason.
 */

import { Gender } from '@omniswim/core/types';
import type { ScoringSettings, SwimmerResult } from '@omniswim/core/types';
import { canonicalMeetEventLabel } from '@omniswim/core/lib/athleteHistory';
import { swimEventIdentity } from '@omniswim/core/lib/bestTimeEligibility';
import { courseOfRecordFromEventLabel } from '@omniswim/core/lib/cutlineEventNames';
import { resolveTeamDivision } from '@omniswim/core/data/teamDivisions';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import {
  calculatePoints,
  convertTimeToSeconds,
  isDivingEvent,
  isRelayResult,
  isScoringSwimTime,
  normalizeSwimmerName,
} from '@omniswim/core/lib/utils';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ScoutErrorCode =
  /** The scoring settings carry `usePdfPlacePoints: true`. Every theoretical row would score 0. */
  | 'pdf-points-settings'
  /** Our team and the opponent are one team. */
  | 'same-team'
  /** A team name is empty, or the gender is not Men or Women. */
  | 'invalid-input'
  /** A row's own gender contradicts the gender asked for. */
  | 'gender-mismatch'
  /** The scoring settings have no place table, so no place can score. */
  | 'no-place-table';

export class ScoutError extends Error {
  readonly code: ScoutErrorCode;
  constructor(code: ScoutErrorCode, message: string) {
    super(message);
    this.name = 'ScoutError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Input and output                                                            */
/* -------------------------------------------------------------------------- */

export interface ScoutInput {
  readonly gender: Gender;
  /** The coach's team, exactly as the rows carry it. */
  readonly ourTeam: string;
  /** The opponent, exactly as its seed rows carry it. */
  readonly opponentTeam: string;
  /** Individual rows. Rows of other teams are ignored. Relay rows are counted, never compared. */
  readonly ourRows: readonly SwimmerResult[];
  /** Individual seed rows of the opponent. Rows of other teams are ignored. */
  readonly theirRows: readonly SwimmerResult[];
  /**
   * The scoring rules. Must not carry `usePdfPlacePoints: true`. For a dual meet pass the dual preset's
   * settings (`resolveScoringChoice`), so its per-team scorer cap applies.
   */
  readonly settings: ScoringSettings;
  /** Passed to the engine as `conferenceForMerge`. Pass only the conference of a resolved preset choice. */
  readonly conference?: string;
  /**
   * Row ids of OUR side to leave out because the time is not a recorded swim (a time typed by hand).
   * Each is listed in `leftOut` with reason `caller_excluded`.
   */
  readonly excludeOurRowIds?: ReadonlySet<string>;
  /**
   * Row ids of OUR side whose time has no recorded origin (a recruit row with no `source`). They may be
   * a recorded swim or a typed one, so they are left out and listed with reason `unknown_source`.
   */
  readonly unknownSourceOurRowIds?: ReadonlySet<string>;
  /**
   * Opponent seeds the entry limit left out (`OpponentSeeds.entryCapped`). Only used to tell "no time"
   * from "has a time, but the entry limit left the event out" in `noTime`.
   */
  readonly theirEntryCapped?: readonly ScoutCappedSeed[];
}

/** One opponent seed that exists but was not entered because of the entry limit. A measured time. */
export interface ScoutCappedSeed {
  readonly swimmer: string;
  /** Event label as recorded (`'100 Free SCY'`). */
  readonly event: string;
  readonly time: string;
}

export type ScoutSide = 'ours' | 'theirs';

export type ScoutLeader = 'ours' | 'theirs' | 'tie';

export interface ScoutEntry {
  readonly swimmer: string;
  /** The time as the row carries it. */
  readonly time: string;
  readonly seconds: number;
  /** Place among both teams' entries in the event (1 is fastest; a tie shares a place). */
  readonly place: number;
  /** Points the engine gave this entry. 0 means the entry took a place that scores nothing. */
  readonly points: number;
}

export interface ScoutSwap {
  /** Change in OUR team total if our best and their best trade times. */
  readonly ourChange: number;
  /** Change in THEIR team total for the same swap. */
  readonly theirChange: number;
  /** `ourChange - theirChange`: the change in our lead over them. */
  readonly leadChange: number;
}

/** The closest pair of opposite-team entries whose trade changes which team leads the event's points. */
export interface ScoutSwing {
  readonly ourSwimmer: string;
  readonly ourTime: string;
  readonly ourPlace: number;
  readonly theirSwimmer: string;
  readonly theirTime: string;
  readonly theirPlace: number;
  /** Gap between the two times, in seconds. */
  readonly gapSec: number;
  /** The gap as a percent of the slower of the two times. */
  readonly gapPercent: number;
  /** Event points of each team now. */
  readonly ourPointsNow: number;
  readonly theirPointsNow: number;
  /** Event points of each team if the two traded times. */
  readonly ourPointsIfTraded: number;
  readonly theirPointsIfTraded: number;
}

export interface ScoutEvent {
  /** Canonical label (`'100 Freestyle'`). */
  readonly event: string;
  /** `swimEventIdentity` of the event. */
  readonly eventKey: string;
  /** Every entry of ours, fastest first. */
  readonly ours: readonly ScoutEntry[];
  /** Every entry of theirs, fastest first. */
  readonly theirs: readonly ScoutEntry[];
  readonly ourBest: ScoutEntry;
  readonly theirBest: ScoutEntry;
  readonly leader: ScoutLeader;
  /** Gap between the two best entries, in seconds, to the hundredth. 0 on a tie. */
  readonly marginSec: number;
  /** Points our entries earned in this event, from the scoring of all compared events together. */
  readonly ourPoints: number;
  readonly theirPoints: number;
  /** The swap of the two best entries. */
  readonly swap: ScoutSwap;
  /** The closest pair whose trade changes which team leads the event's points, or `null` for none. */
  readonly swing: ScoutSwing | null;
}

export type NotScoutedReason = 'relay' | 'diving' | 'event_not_recognised';

export interface ScoutNotScouted {
  readonly reason: NotScoutedReason;
  /** The event label as the row carried it, or `null` for the relay group as a whole. */
  readonly event: string | null;
  readonly side: ScoutSide | null;
  readonly note: string;
}

export type LeftOutReason =
  | 'exhibition'
  | 'time_trial'
  | 'converted_estimate'
  | 'not_scy'
  | 'no_valid_time'
  | 'caller_excluded'
  | 'unknown_source';

export interface ScoutLeftOut {
  readonly side: ScoutSide;
  readonly swimmer: string;
  readonly event: string;
  readonly time: string;
  readonly reason: LeftOutReason;
}

export interface ScoutNoTime {
  readonly event: string;
  readonly eventKey: string;
  /** The side with NO entry in this event. */
  readonly missing: ScoutSide;
  /**
   * `no_time`: the side has no measured time in the event. `entry_cap`: the opponent has a measured time
   * (see `cappedBest`) but the entry limit left the event out of its lineup.
   */
  readonly reason: 'no_time' | 'entry_cap';
  /** Set with reason `entry_cap`: the opponent's fastest measured time that the limit left out. */
  readonly cappedBest?: { readonly swimmer: string; readonly time: string };
  /** The other side's best entry. Shown for context, never compared. */
  readonly present: { readonly swimmer: string; readonly time: string };
}

/** A swimmer left out of an event because the scoring rules cap a team's swimmers per event. */
export interface ScoutCappedOut {
  readonly side: ScoutSide;
  readonly swimmer: string;
  readonly event: string;
  readonly time: string;
}

export interface ScoutReport {
  readonly gender: Gender;
  readonly ourTeam: string;
  readonly opponentTeam: string;
  /** Events with a time on both sides, in program order. */
  readonly events: readonly ScoutEvent[];
  readonly wins: readonly ScoutEvent[];
  readonly losses: readonly ScoutEvent[];
  readonly ties: readonly ScoutEvent[];
  /** Events where the swap changes a team total, smallest margin first. */
  readonly swingEvents: readonly ScoutEvent[];
  readonly noTime: readonly ScoutNoTime[];
  readonly notScouted: readonly ScoutNotScouted[];
  readonly leftOut: readonly ScoutLeftOut[];
  /** The per-team cap per event the rules state and that was applied, or `null` when none is stated. */
  readonly perTeamCap: number | null;
  /** Swimmers cut by that cap before places were set. Empty without a cap. */
  readonly cappedOut: readonly ScoutCappedOut[];
  /** Team totals over the compared events only. `null` when no event has a time on both sides. */
  readonly ourTotal: number | null;
  readonly theirTotal: number | null;
  /** Plain-word limits of this comparison that depend on the scoring rules. */
  readonly caveats: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Plain-word texts                                                            */
/* -------------------------------------------------------------------------- */

export const RELAYS_NOT_SCOUTED_NOTE =
  'Relays are not scouted. The other team\'s relay time would be the sum of four individual best times that no team swam, so it is an estimate and is not compared.';
export const DIVING_NOT_SCOUTED_NOTE =
  'Diving is not scouted. Diving is scored in points, not time, and a crawled team page holds no dive scores to compare.';
export const EVENT_ORDER_CAVEAT =
  'This scoring rule limits how many swimmers a team scores in the whole meet. Events are scored in the usual program order, and a different order can move points between events.';
export function perTeamCapCaveat(cap: number): string {
  return `The scoring rules let each team count its fastest ${cap} swimmers in an event. Slower swimmers are left out before places are set, as they would not race for a place. They are listed under "Left out of the comparison".`;
}
export const EVENT_NOT_RECOGNISED_NOTE = 'The event name is not a recognised individual event, so it is not compared.';

/* -------------------------------------------------------------------------- */
/* Reading one side                                                            */
/* -------------------------------------------------------------------------- */

interface SideEntry {
  readonly name: string;
  readonly time: string;
  readonly seconds: number;
  readonly hundredths: number;
}

interface SideRead {
  /** `swimEventIdentity` to canonical label. */
  readonly labels: Map<string, string>;
  /** `swimEventIdentity` to normalized name to the fastest entry. */
  readonly entries: Map<string, Map<string, SideEntry>>;
  readonly leftOut: ScoutLeftOut[];
  readonly notScouted: ScoutNotScouted[];
}

/** Whole hundredths of a second. Integers compare exactly, so a tie is a tie. */
function toHundredths(seconds: number): number {
  return Math.round(seconds * 100);
}

function sameTeam(a: string, b: string): boolean {
  return normalizeSwimmerName(a) === normalizeSwimmerName(b);
}

/**
 * Two team names name one school: the same normalized name, or the same canonical school in the app's
 * division table (so "Henderson State" and "Henderson State University" are one). An unmapped name only
 * matches itself. Used to refuse scouting your own team, never to choose a division.
 */
export function isSameSchool(a: string, b: string): boolean {
  if (sameTeam(a, b)) return true;
  const ca = resolveTeamDivision(a).canonicalTeam;
  const cb = resolveTeamDivision(b).canonicalTeam;
  return ca !== null && cb !== null && ca === cb;
}

interface Excluding {
  readonly typed: ReadonlySet<string> | undefined;
  readonly unknownSource: ReadonlySet<string> | undefined;
}

function leftOutReason(row: SwimmerResult, excluding: Excluding): LeftOutReason | null {
  if (row.isExhibition === true) return 'exhibition';
  if (row.isTimeTrial === true) return 'time_trial';
  if (row.convertedFrom !== undefined) return 'converted_estimate';
  const course = courseOfRecordFromEventLabel(row.event);
  if (course !== null && course !== 'SCY') return 'not_scy';
  if (excluding.typed?.has(row.id) === true) return 'caller_excluded';
  if (excluding.unknownSource?.has(row.id) === true) return 'unknown_source';
  return null;
}

function validSeconds(time: string): number | null {
  if (!isScoringSwimTime(time)) return null;
  const seconds = convertTimeToSeconds(time);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function noteOnce(list: ScoutNotScouted[], item: ScoutNotScouted): void {
  if (!list.some(n => n.reason === item.reason && n.event === item.event && n.side === item.side)) list.push(item);
}

function admitRow(read: SideRead, side: ScoutSide, row: SwimmerResult, excluding: Excluding): void {
  if (isRelayResult(row)) return;
  if (isDivingEvent(row.event)) {
    noteOnce(read.notScouted, { reason: 'diving', event: row.event, side, note: DIVING_NOT_SCOUTED_NOTE });
    return;
  }
  const leftOut = (reason: LeftOutReason): void => {
    read.leftOut.push({ side, swimmer: row.name, event: row.event, time: row.time, reason });
  };
  const reason = leftOutReason(row, excluding);
  if (reason !== null) {
    leftOut(reason);
    return;
  }
  const seconds = validSeconds(row.time);
  if (seconds === null) {
    leftOut('no_valid_time');
    return;
  }
  const label = canonicalMeetEventLabel(row.event);
  if (label === null) {
    noteOnce(read.notScouted, { reason: 'event_not_recognised', event: row.event, side, note: EVENT_NOT_RECOGNISED_NOTE });
    return;
  }
  const key = swimEventIdentity(row.event);
  read.labels.set(key, label);
  const byName = read.entries.get(key) ?? new Map<string, SideEntry>();
  read.entries.set(key, byName);
  const nameKey = normalizeSwimmerName(row.name);
  const hundredths = toHundredths(seconds);
  const held = byName.get(nameKey);
  // One swimmer, one entry per event: the fastest of the swimmer's rows (prelims and finals, for example).
  if (held === undefined || hundredths < held.hundredths) {
    byName.set(nameKey, { name: row.name, time: row.time, seconds, hundredths });
  }
}

function readSide(
  side: ScoutSide,
  team: string,
  gender: Gender,
  rows: readonly SwimmerResult[],
  excluding: Excluding
): SideRead {
  const read: SideRead = { labels: new Map(), entries: new Map(), leftOut: [], notScouted: [] };
  for (const row of rows) {
    if (!sameTeam(row.team, team)) continue;
    if (row.gender !== undefined && row.gender !== gender) {
      throw new ScoutError('gender-mismatch', `A row of ${row.name} (${row.event}) is ${String(row.gender)}, but the scout is for ${gender}.`);
    }
    admitRow(read, side, row, excluding);
  }
  return read;
}

/* -------------------------------------------------------------------------- */
/* Scoring through the engine                                                  */
/* -------------------------------------------------------------------------- */

interface FieldEntry {
  readonly side: ScoutSide;
  readonly nameKey: string;
  readonly name: string;
  readonly time: string;
  readonly hundredths: number;
}

type Field = readonly FieldEntry[];

/** An entry with its place. Standard competition ranking, fastest first: a shared place only on an exact tie (1, 2, 2, 4). */
interface PlacedEntry {
  readonly entry: FieldEntry;
  readonly place: number;
}

function placeField(field: Field): PlacedEntry[] {
  const sorted = [...field].sort((a, b) => a.hundredths - b.hundredths || a.name.localeCompare(b.name));
  const placeOf = new Map<FieldEntry, number>();
  let place = 0;
  let previous = Number.NaN;
  sorted.forEach((entry, position) => {
    if (position === 0 || entry.hundredths !== previous) place = position + 1;
    previous = entry.hundredths;
    placeOf.set(entry, place);
  });
  return sorted.map(entry => {
    const placed = placeOf.get(entry);
    if (placed === undefined) throw new Error('Opponent scouting: an entry got no place.');
    return { entry, place: placed };
  });
}

function roundForPlace(place: number, bracket: number): string {
  if (place <= bracket) return 'A Final';
  if (place <= bracket * 2) return 'B Final';
  return 'C Final';
}

function rowId(eventKey: string, entry: FieldEntry): string {
  return `scout|${eventKey}|${entry.side}|${entry.nameKey}`;
}

interface Ctx {
  readonly gender: Gender;
  readonly teams: Readonly<Record<ScoutSide, string>>;
  readonly settings: ScoringSettings;
  readonly conference: string | undefined;
  readonly bracket: number;
}

function rowsOfField(ctx: Ctx, eventKey: string, label: string, field: Field): SwimmerResult[] {
  return placeField(field).map(({ entry, place }) => ({
    id: rowId(eventKey, entry),
    rank: place,
    name: entry.name,
    classYear: 'UNKNOWN',
    team: ctx.teams[entry.side],
    time: entry.time,
    points: 0,
    event: label,
    gender: ctx.gender,
    roundSwam: roundForPlace(place, ctx.bracket),
  }));
}

/** Score every given field together (a meet-wide scorer pool spans events). Returns points by row id. */
function scoreFields(ctx: Ctx, fields: ReadonlyMap<string, { label: string; field: Field }>): Map<string, number> {
  const rows: SwimmerResult[] = [];
  for (const [eventKey, { label, field }] of fields) rows.push(...rowsOfField(ctx, eventKey, label, field));
  const scored = calculatePoints(rows, ctx.settings, { conferenceForMerge: ctx.conference, resultsForPdfHint: rows });
  const points = new Map<string, number>();
  for (const row of scored) {
    if (typeof row.points !== 'number' || !Number.isFinite(row.points)) {
      throw new Error(`Opponent scouting: the engine gave row ${row.id} no numeric points.`);
    }
    points.set(row.id, row.points);
  }
  return points;
}

function totalFor(fields: ReadonlyMap<string, { label: string; field: Field }>, points: ReadonlyMap<string, number>, side: ScoutSide): number {
  let total = 0;
  for (const [eventKey, { field }] of fields) {
    for (const entry of field) {
      if (entry.side === side) total += points.get(rowId(eventKey, entry)) ?? Number.NaN;
    }
  }
  if (Number.isNaN(total)) throw new Error('Opponent scouting: a scored row went missing from the engine result.');
  return total;
}

/* -------------------------------------------------------------------------- */
/* Building the report                                                         */
/* -------------------------------------------------------------------------- */

const STROKE_ORDER = ['freestyle', 'backstroke', 'breaststroke', 'butterfly', 'individual medley'];

/** Program order of a canonical label: stroke group, then distance. Unknown strokes sort last. */
function programKey(label: string): [number, number] {
  const m = /^(\d+)\s+(.*)$/.exec(label);
  const distance = m?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[1]);
  const stroke = (m?.[2] ?? label).toLowerCase();
  const index = STROKE_ORDER.findIndex(s => stroke.includes(s));
  return [index < 0 ? STROKE_ORDER.length : index, distance];
}

function compareProgram(a: string, b: string): number {
  const [sa, da] = programKey(a);
  const [sb, db] = programKey(b);
  return sa - sb || da - db || a.localeCompare(b);
}

function fieldOf(side: ScoutSide, entries: ReadonlyMap<string, SideEntry>): FieldEntry[] {
  return [...entries.entries()].map(([nameKey, e]) => ({ side, nameKey, name: e.name, time: e.time, hundredths: e.hundredths }));
}

function bestOf(field: Field, side: ScoutSide): FieldEntry {
  const mine = field.filter(e => e.side === side).sort((a, b) => a.hundredths - b.hundredths || a.name.localeCompare(b.name));
  const best = mine[0];
  if (best === undefined) throw new Error(`Opponent scouting: no ${side} entry in a compared field.`);
  return best;
}

/** The field with the two best entries trading times. */
function swappedField(field: Field, ours: FieldEntry, theirs: FieldEntry): Field {
  return field.map(e => {
    if (e.side === 'ours' && e.nameKey === ours.nameKey) return { ...e, time: theirs.time, hundredths: theirs.hundredths };
    if (e.side === 'theirs' && e.nameKey === theirs.nameKey) return { ...e, time: ours.time, hundredths: ours.hundredths };
    return e;
  });
}

function entriesOf(eventKey: string, field: Field, points: ReadonlyMap<string, number>, side: ScoutSide): ScoutEntry[] {
  const out: ScoutEntry[] = [];
  for (const { entry, place } of placeField(field)) {
    if (entry.side !== side) continue;
    const p = points.get(rowId(eventKey, entry));
    if (p === undefined) throw new Error('Opponent scouting: a scored row went missing from the engine result.');
    out.push({ swimmer: entry.name, time: entry.time, seconds: entry.hundredths / 100, place, points: p });
  }
  return out;
}

function leaderOf(ours: FieldEntry, theirs: FieldEntry): ScoutLeader {
  if (ours.hundredths === theirs.hundredths) return 'tie';
  return ours.hundredths < theirs.hundredths ? 'ours' : 'theirs';
}

function sumPoints(entries: readonly ScoutEntry[]): number {
  return entries.reduce((total, e) => total + e.points, 0);
}

/** The per-team cap per event the merged rules state, or `null` for none (absent, or 999 or more). */
function perTeamCapOf(settings: ScoringSettings): number | null {
  const cap = settings.maxIndividualScorersPerTeamPerEvent;
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 1 && cap < 999 ? cap : null;
}

/**
 * The event-order caveat holds only when the engine fills a meet-wide scorer pool in event order
 * (`resolveEventProcessingMode` in `calculatePoints.ts`: `scorerCapScope === 'meet'` and a pool under 999).
 */
function caveatsFor(settings: ScoringSettings, cap: number | null): string[] {
  const meetWide = settings.scorerCapScope === 'meet' && (settings.maxIndividualScorersPerTeam ?? 999) < 999;
  return [...(meetWide ? [EVENT_ORDER_CAVEAT] : []), ...(cap === null ? [] : [perTeamCapCaveat(cap)])];
}

/** Fastest `cap` entries kept, the rest cut. Equal times at the boundary are kept in name order, as the engine's cap does. */
function trimToCap(entries: FieldEntry[], cap: number | null): { kept: FieldEntry[]; cut: FieldEntry[] } {
  if (cap === null || entries.length <= cap) return { kept: entries, cut: [] };
  const sorted = [...entries].sort((a, b) => a.hundredths - b.hundredths || a.name.localeCompare(b.name));
  return { kept: sorted.slice(0, cap), cut: sorted.slice(cap) };
}

type Lead = 'ours' | 'theirs' | 'level';

function leadOf(ours: number, theirs: number): Lead {
  if (Math.abs(ours - theirs) < 1e-9) return 'level';
  return ours > theirs ? 'ours' : 'theirs';
}

function sideEventPoints(eventKey: string, field: Field, points: ReadonlyMap<string, number>, side: ScoutSide): number {
  let total = 0;
  for (const entry of field) {
    if (entry.side !== side) continue;
    const p = points.get(rowId(eventKey, entry));
    if (p === undefined) throw new Error('Opponent scouting: a scored row went missing from the engine result.');
    total += p;
  }
  return total;
}

interface SwingCandidate {
  readonly first: PlacedEntry;
  readonly second: PlacedEntry;
  readonly gapHundredths: number;
}

function scoresPoints(points: ReadonlyMap<string, number>, eventKey: string, placed: PlacedEntry): boolean {
  const p = points.get(rowId(eventKey, placed.entry));
  return p !== undefined && p > 0;
}

/** Opposite-team neighbours in finish order, one of them in a scoring place, with different times. Smallest percent gap first. */
function swingCandidates(field: Field, points: ReadonlyMap<string, number>, eventKey: string): SwingCandidate[] {
  const placed = placeField(field);
  const out: SwingCandidate[] = [];
  for (let i = 0; i + 1 < placed.length; i += 1) {
    const first = placed[i];
    const second = placed[i + 1];
    if (first === undefined || second === undefined) continue;
    if (first.entry.side === second.entry.side) continue;
    const gapHundredths = second.entry.hundredths - first.entry.hundredths;
    if (gapHundredths <= 0) continue;
    if (scoresPoints(points, eventKey, first) || scoresPoints(points, eventKey, second)) {
      out.push({ first, second, gapHundredths });
    }
  }
  // gap / slower time, compared by cross-multiplication so no float decides the order
  return out.sort((a, b) => a.gapHundredths * b.second.entry.hundredths - b.gapHundredths * a.second.entry.hundredths);
}

/**
 * The closest neighbouring pair whose trade changes which team leads the event's points, scored by the
 * same engine call as the base. `null` when no pair does.
 */
function findSwing(
  ctx: Ctx,
  fields: ReadonlyMap<string, { label: string; field: Field }>,
  eventKey: string,
  label: string,
  field: Field,
  base: ReadonlyMap<string, number>
): ScoutSwing | null {
  const ourNow = sideEventPoints(eventKey, field, base, 'ours');
  const theirNow = sideEventPoints(eventKey, field, base, 'theirs');
  const leadNow = leadOf(ourNow, theirNow);
  for (const c of swingCandidates(field, base, eventKey)) {
    const ours = c.first.entry.side === 'ours' ? c.first : c.second;
    const theirs = c.first.entry.side === 'ours' ? c.second : c.first;
    const traded = swappedField(field, ours.entry, theirs.entry);
    const scenario = new Map(fields);
    scenario.set(eventKey, { label, field: traded });
    const after = scoreFields(ctx, scenario);
    const ourAfter = sideEventPoints(eventKey, traded, after, 'ours');
    const theirAfter = sideEventPoints(eventKey, traded, after, 'theirs');
    if (leadOf(ourAfter, theirAfter) === leadNow) continue;
    return {
      ourSwimmer: ours.entry.name,
      ourTime: ours.entry.time,
      ourPlace: ours.place,
      theirSwimmer: theirs.entry.name,
      theirTime: theirs.entry.time,
      theirPlace: theirs.place,
      gapSec: c.gapHundredths / 100,
      gapPercent: (c.gapHundredths / c.second.entry.hundredths) * 100,
      ourPointsNow: ourNow,
      theirPointsNow: theirNow,
      ourPointsIfTraded: ourAfter,
      theirPointsIfTraded: theirAfter,
    };
  }
  return null;
}

function assertInput(input: ScoutInput): void {
  if (input.gender !== Gender.MEN && input.gender !== Gender.WOMEN) {
    throw new ScoutError('invalid-input', `The gender ${JSON.stringify(input.gender)} is not Men or Women.`);
  }
  if (input.ourTeam.trim().length === 0 || input.opponentTeam.trim().length === 0) {
    throw new ScoutError('invalid-input', 'A team name is empty.');
  }
  if (isSameSchool(input.ourTeam, input.opponentTeam)) {
    throw new ScoutError('same-team', `${input.ourTeam} and ${input.opponentTeam} are the same team. Pick a different opponent.`);
  }
  if (input.settings.usePdfPlacePoints === true) {
    throw new ScoutError(
      'pdf-points-settings',
      'The scoring settings read points from a meet PDF (usePdfPlacePoints), and scouted rows carry no PDF points, so every team would score 0. Choose a scoring preset instead.'
    );
  }
  if (!Array.isArray(input.settings.scoringPoints) || input.settings.scoringPoints.length === 0) {
    throw new ScoutError('no-place-table', 'The scoring settings have no individual place table.');
  }
}

/** The fastest measured capped-out seed per event identity. A seed with no valid time is ignored. */
function cappedSeedIndex(seeds: readonly ScoutCappedSeed[] | undefined): Map<string, ScoutCappedSeed> {
  const best = new Map<string, ScoutCappedSeed & { seconds: number }>();
  for (const seed of seeds ?? []) {
    const seconds = validSeconds(seed.time);
    if (seconds === null) continue;
    const key = swimEventIdentity(seed.event);
    const held = best.get(key);
    if (held === undefined || seconds < held.seconds) best.set(key, { ...seed, seconds });
  }
  return best;
}

/**
 * Compare our lineup with one opponent, event by event. See the file header for every definition.
 * Throws {@link ScoutError} on input it will not guess about.
 */
export function scoutOpponent(input: ScoutInput): ScoutReport {
  assertInput(input);
  const ours = readSide('ours', input.ourTeam, input.gender, input.ourRows, {
    typed: input.excludeOurRowIds,
    unknownSource: input.unknownSourceOurRowIds,
  });
  const theirs = readSide('theirs', input.opponentTeam, input.gender, input.theirRows, { typed: undefined, unknownSource: undefined });
  // Merged once, the way `buildTheoreticalMeetWorkspace` merges before it ranks.
  const settings = mergeScoringSettings(input.settings, { conference: input.conference });
  const ctx: Ctx = {
    gender: input.gender,
    teams: { ours: input.ourTeam, theirs: input.opponentTeam },
    settings,
    conference: input.conference,
    // The engine's own A-final rule: the setting, else half the table.
    bracket: settings.aFinalBracketSize ?? Math.floor(settings.scoringPoints.length / 2),
  };

  const cap = perTeamCapOf(settings);
  const capped = cappedSeedIndex(input.theirEntryCapped);
  const cappedOut: ScoutCappedOut[] = [];
  const compared: Array<{ key: string; label: string; field: Field }> = [];
  const noTime: ScoutNoTime[] = [];
  const keys = new Set<string>([...ours.entries.keys(), ...theirs.entries.keys()]);
  for (const key of keys) {
    const mine = ours.entries.get(key);
    const theirsHere = theirs.entries.get(key);
    const label = ours.labels.get(key) ?? theirs.labels.get(key) ?? key;
    if (mine === undefined || theirsHere === undefined) {
      const missing: ScoutSide = mine === undefined ? 'ours' : 'theirs';
      const presentSide: ScoutSide = mine === undefined ? 'theirs' : 'ours';
      const present = mine ?? theirsHere;
      if (present === undefined) continue;
      const best = fieldOf(presentSide, present).sort((a, b) => a.hundredths - b.hundredths || a.name.localeCompare(b.name))[0];
      if (best === undefined) continue;
      const cappedBest = missing === 'theirs' ? capped.get(key) : undefined;
      noTime.push({
        event: label,
        eventKey: key,
        missing,
        reason: cappedBest === undefined ? 'no_time' : 'entry_cap',
        ...(cappedBest === undefined ? {} : { cappedBest: { swimmer: cappedBest.swimmer, time: cappedBest.time } }),
        present: { swimmer: best.name, time: best.time },
      });
      continue;
    }
    const mineCut = trimToCap(fieldOf('ours', mine), cap);
    const theirsCut = trimToCap(fieldOf('theirs', theirsHere), cap);
    for (const e of [...mineCut.cut, ...theirsCut.cut]) {
      cappedOut.push({ side: e.side, swimmer: e.name, event: label, time: e.time });
    }
    compared.push({ key, label, field: [...mineCut.kept, ...theirsCut.kept] });
  }
  // Scored in program order, the default order of a theoretical meet. A meet-wide scorer pool fills in
  // this order, so the order can move a total (see `eventOrderCaveat`).
  compared.sort((a, b) => compareProgram(a.label, b.label));
  const fields = new Map(compared.map(c => [c.key, { label: c.label, field: c.field }] as const));

  const notScouted: ScoutNotScouted[] = [
    { reason: 'relay', event: null, side: null, note: RELAYS_NOT_SCOUTED_NOTE },
    ...ours.notScouted,
    ...theirs.notScouted,
  ];
  const leftOut = [...ours.leftOut, ...theirs.leftOut];
  noTime.sort((a, b) => compareProgram(a.event, b.event));

  if (fields.size === 0) {
    return {
      gender: input.gender,
      ourTeam: input.ourTeam,
      opponentTeam: input.opponentTeam,
      events: [],
      wins: [],
      losses: [],
      ties: [],
      swingEvents: [],
      noTime,
      notScouted,
      leftOut,
      perTeamCap: cap,
      cappedOut,
      ourTotal: null,
      theirTotal: null,
      caveats: caveatsFor(settings, cap),
    };
  }
  return assemble(input, ctx, fields, { noTime, notScouted, leftOut, perTeamCap: cap, cappedOut });
}

function assemble(
  input: ScoutInput,
  ctx: Ctx,
  fields: ReadonlyMap<string, { label: string; field: Field }>,
  rest: {
    noTime: ScoutNoTime[];
    notScouted: ScoutNotScouted[];
    leftOut: ScoutLeftOut[];
    perTeamCap: number | null;
    cappedOut: ScoutCappedOut[];
  }
): ScoutReport {
  const base = scoreFields(ctx, fields);
  const baseOur = totalFor(fields, base, 'ours');
  const baseTheir = totalFor(fields, base, 'theirs');

  const events: ScoutEvent[] = [];
  for (const [eventKey, { label, field }] of fields) {
    const ourBest = bestOf(field, 'ours');
    const theirBest = bestOf(field, 'theirs');
    const leader = leaderOf(ourBest, theirBest);
    const oursEntries = entriesOf(eventKey, field, base, 'ours');
    const theirEntries = entriesOf(eventKey, field, base, 'theirs');
    const swing = findSwing(ctx, fields, eventKey, label, field, base);
    let swap: ScoutSwap = { ourChange: 0, theirChange: 0, leadChange: 0 };
    if (leader !== 'tie') {
      const swapped = new Map(fields);
      swapped.set(eventKey, { label, field: swappedField(field, ourBest, theirBest) });
      const after = scoreFields(ctx, swapped);
      const ourChange = totalFor(swapped, after, 'ours') - baseOur;
      const theirChange = totalFor(swapped, after, 'theirs') - baseTheir;
      swap = { ourChange, theirChange, leadChange: ourChange - theirChange };
    }
    const bestOurEntry = oursEntries.find(e => e.swimmer === ourBest.name);
    const bestTheirEntry = theirEntries.find(e => e.swimmer === theirBest.name);
    if (bestOurEntry === undefined || bestTheirEntry === undefined) {
      throw new Error('Opponent scouting: a best entry is missing from its own side.');
    }
    events.push({
      event: label,
      eventKey,
      ours: oursEntries,
      theirs: theirEntries,
      ourBest: bestOurEntry,
      theirBest: bestTheirEntry,
      leader,
      marginSec: Math.abs(ourBest.hundredths - theirBest.hundredths) / 100,
      ourPoints: sumPoints(oursEntries),
      theirPoints: sumPoints(theirEntries),
      swap,
      swing,
    });
  }
  events.sort((a, b) => compareProgram(a.event, b.event));
  return {
    gender: input.gender,
    ourTeam: input.ourTeam,
    opponentTeam: input.opponentTeam,
    events,
    wins: events.filter(e => e.leader === 'ours'),
    losses: events.filter(e => e.leader === 'theirs'),
    ties: events.filter(e => e.leader === 'tie'),
    swingEvents: events
      .filter(e => e.swing !== null)
      .sort((a, b) => (a.swing?.gapPercent ?? Number.NaN) - (b.swing?.gapPercent ?? Number.NaN) || compareProgram(a.event, b.event)),
    noTime: rest.noTime,
    notScouted: rest.notScouted,
    leftOut: rest.leftOut,
    perTeamCap: rest.perTeamCap,
    cappedOut: rest.cappedOut,
    ourTotal: baseOur,
    theirTotal: baseTheir,
    caveats: caveatsFor(ctx.settings, rest.perTeamCap),
  };
}
