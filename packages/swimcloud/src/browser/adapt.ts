/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The simulator adapter (plans/2026-10-25/D2-ENGINE-API.md, 3.6; plan section 3.3):
 * `SimSnapshot` to `MeetModel` and `Lineup`.
 *
 * The page's own entries are the lineup. An individual entry is seeded from the swim whose time equals
 * the page's entry time, so the engine scores the swim the page scored. An entry whose time matches no
 * swim of that swimmer throws: it is a coach edit or a misread, and neither may become a time.
 *
 * ## What each snapshot row becomes
 * - `ind` row: a `MeetSwim`. A dive keeps the highest score across the course codes `"6"` and `""`,
 *   one swim per diver and event (recon Q13, `gf`).
 * - `leadoff` row: a `MeetSwim` flagged `extractedSplit`. SwimCloud uses a leadoff as an individual
 *   time (`getIndividuals`) and as the flat-start leg of an aggregate relay.
 * - `split` row: a `RelaySplit`. SwimCloud's row names the leg, not the relay, so `relayEventKey` is
 *   `null` (a 50 Freestyle split could belong to a free or a medley relay).
 * - `relay` row (an actual relay): not modeled. The model holds relay entries as four legs. The count
 *   is in `ignored.relayRows`.
 *
 * ## Relay entries
 * The page builds an aggregate relay from leg rows it copies into leg splashes: the leg's stroke and
 * distance, `flystart` and `eventtime` (`kf` in the archived bundle). A flat leg (`flystart` false) is
 * a `flat-start-swim` basis. A flying leg is a `split` basis. A leg splash with no `eventtime`, or
 * with `flystart` null, throws: the adapter cannot tell which row the page used. The four leg times
 * must sum to the relay's own time, or the adapter throws. A letter (A, B, ...) is assigned in splash
 * order per team and event; SwimCloud's own relay names are not in the snapshot.
 *
 * ## Not supported, and loud
 * A course other than SCY, an exhibition splash (the page sorts it last but still scores it, which no
 * engine rule matches), a time that is not whole hundredths, an unknown stroke code. Each throws
 * `AdapterError` with the path.
 *
 * Nothing here reads a clock or a random source. The meet key and snapshot id are inputs.
 */
import { entryKey, formatHundredths, programCompetedInSeason, programSponsorsGender, resolveTeamDivision, validateMeetModel } from '@omniswim/engine';
import type {
  DateWindow,
  EventKey,
  Gender,
  Hundredths,
  Lineup,
  LineupDisplay,
  LineupEntry,
  MeetEvent,
  MeetModel,
  MeetSwim,
  MeetSwimmer,
  MeetTeam,
  RelayLeg,
  RelaySplit,
  SwimmerId,
  TeamId,
  TimeValue,
} from '@omniswim/engine';
import { readDistance, simulatorEvent } from './events';
import type { SimulatorEventShape } from './events';
import { simulatorRulePreset } from './simulatorRules';
import type { SimulatorPresetBuild } from './simulatorRules';
import { AdapterError } from './simulatorTypes';
import type { SimulatorSnapshotInput, SimulatorSplashInput } from './simulatorTypes';
import { parseSwimCloudHundredths } from './times';

export interface AdaptOptions {
  /** Identifies the meet in storage. An input: the adapter reads no clock and no random source. */
  readonly meetKey: string;
  /** Identifies this snapshot in each swim's `origin`. */
  readonly snapshotId: string;
}

/** One entry the page chose, with the points the page recorded for it. */
export interface ObservedEntry {
  readonly entryKey: string;
  readonly splashId: string;
  readonly teamId: TeamId;
  /** `null` for a relay entry. */
  readonly swimmerId: SwimmerId | null;
  readonly eventKey: EventKey;
  readonly gender: Gender;
  /** SwimCloud's `points`. `null`: the splash states none (the page leaves it unset past the point table). Never 0. */
  readonly points: number | null;
}

export interface AdaptedSimulator {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly preset: SimulatorPresetBuild;
  readonly observedEntries: readonly ObservedEntry[];
  /** Snapshot content the model cannot hold. Counted, never silently dropped. */
  readonly ignored: { readonly relayRows: number };
  /** Why the snapshot could not supply a season for strict division resolution. */
  readonly divisionSeasonNote?: string;
}

export type AdaptOutcome =
  | { readonly kind: 'not_loaded'; readonly missing: readonly ('swimmers' | 'swims' | 'splashes')[] }
  | { readonly kind: 'ready'; readonly adapted: AdaptedSimulator };

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function genderOf(raw: string, path: string): Gender {
  if (raw === 'M') return 'Men';
  if (raw === 'F') return 'Women';
  throw new AdapterError('unsupported_gender', path, `"${raw}" is not M or F`);
}

function recordRange(s: SimulatorSnapshotInput['settings']): DateWindow {
  let from: string | null;
  let to: string | null;
  if (s.dateToUse === 'season') {
    from = s.startSeason;
    to = s.endSeason;
  } else if (s.dateToUse === 'specific-dates') {
    from = s.startDate;
    to = s.endDate;
  } else {
    throw new AdapterError('invalid_window', 'settings.dateToUse', `"${s.dateToUse}" is not season or specific-dates`);
  }
  if (from === null || to === null || !ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    throw new AdapterError('invalid_window', 'settings', `the ${s.dateToUse} window ${String(from)} to ${String(to)} is not two ordered dates`);
  }
  return { kind: 'dates', from, to };
}

function seasonForSettings(s: SimulatorSnapshotInput['settings']): string | null {
  if (s.dateToUse !== 'season' || !s.startSeason || !s.endSeason || !ISO_DATE.test(s.startSeason) || !ISO_DATE.test(s.endSeason)) return null;
  const fromYear = Number(s.startSeason.slice(0, 4));
  const throughYear = Number(s.endSeason.slice(0, 4));
  return throughYear === fromYear + 1 ? `${fromYear}-${throughYear}` : null;
}

const timeValue = (h: Hundredths, diving: boolean): TimeValue => ({ text: diving ? (h / 100).toFixed(2) : formatHundredths(h), hundredths: h });

const swimKey = (swimmerId: SwimmerId, eventKey: EventKey): string => `${swimmerId}\u0000${eventKey}`;

function isExhibition(raw: SimulatorSplashInput['exhibition']): boolean {
  if (raw === undefined || raw === null || raw === false || raw === 0 || raw === '0' || raw === '') return false;
  if (raw === true || raw === 1 || raw === '1') return true;
  throw new AdapterError('unsupported_exhibition', 'splash.exhibition', `unrecognized exhibition value ${JSON.stringify(raw)}`);
}

const nonEmpty = (v: string | null | undefined): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

export function adaptSimulatorSnapshot(snapshot: SimulatorSnapshotInput, opts: AdaptOptions): AdaptOutcome {
  const { swimmers: rawSwimmers, swims: rawSwims, splashes: rawSplashes, settings } = snapshot;
  const missing: ('swimmers' | 'swims' | 'splashes')[] = [];
  if (rawSwimmers === null) missing.push('swimmers');
  if (rawSwims === null) missing.push('swims');
  if (rawSplashes === null) missing.push('splashes');
  if (rawSwimmers === null || rawSwims === null || rawSplashes === null) return { kind: 'not_loaded', missing };

  const gender = genderOf(settings.gender, 'settings.gender');
  if (settings.eventCourse !== 'Y') {
    throw new AdapterError('unsupported_course', 'settings.eventCourse', `"${settings.eventCourse}" is not SCY; only yards re-score in P2`);
  }
  const preset = simulatorRulePreset(settings);
  const origin = { kind: 'simulator' as const, snapshotId: opts.snapshotId };
  const snapshotSeason = seasonForSettings(settings);
  const divisionSeasonNote = snapshotSeason ? undefined : `The ${settings.dateToUse} date window does not identify one competition season.`;

  // ---- teams and swimmers ----
  const teams: MeetTeam[] = [];
  const teamIds = new Set<TeamId>();
  snapshot.teams.forEach((t, i) => {
    const teamId = String(t.id);
    if (teamIds.has(teamId)) throw new AdapterError('duplicate_id', `teams[${i}].id`, `team ${teamId} appears twice`);
    teamIds.add(teamId);
    const resolution = snapshotSeason ? resolveTeamDivision(t.name, { season: snapshotSeason }) : null;
    let division: MeetTeam['division'] = { state: 'unknown', reason: 'unmapped_team' };
    if (snapshotSeason && resolution?.entry) {
      if (!programCompetedInSeason(resolution.entry, snapshotSeason)) division = { state: 'unknown', reason: 'program_discontinued' };
      else if (!resolution.sponsoredGenders) division = { state: 'unknown', reason: 'sponsorship_unaudited' };
      else if (!programSponsorsGender(resolution.entry, gender)) division = { state: 'unknown', reason: 'gender_not_sponsored' };
      else if (resolution.division) division = { state: 'known', division: resolution.division, season: snapshotSeason };
    }
    teams.push({ teamId, division });
  });

  const swimmers: MeetSwimmer[] = [];
  const swimmerById = new Map<SwimmerId, MeetSwimmer>();
  const swimmerNames: Record<SwimmerId, { name: string }> = {};
  rawSwimmers.forEach((s, i) => {
    const path = `swimmers[${i}]`;
    const swimmerId = String(s.id);
    const teamId = String(s.teamId);
    if (swimmerById.has(swimmerId)) throw new AdapterError('duplicate_id', `${path}.id`, `swimmer ${swimmerId} appears twice`);
    if (!teamIds.has(teamId)) throw new AdapterError('unresolved_reference', `${path}.teamId`, `team ${teamId} is not in teams`);
    if (s.gender === null || s.gender === undefined) throw new AdapterError('swimmer_gender', `${path}.gender`, 'the swimmer states no gender');
    if (genderOf(s.gender, `${path}.gender`) !== gender) {
      throw new AdapterError('swimmer_gender', `${path}.gender`, `swimmer ${swimmerId} is ${s.gender}, the simulator is ${settings.gender}`);
    }
    // The endpoint lists the current roster (recon 6), so a listed swimmer is a member. Class year is
    // not derived from `gradcollege`: SwimCloud's year can be wrong and the user sets it (P3).
    const swimmer: MeetSwimmer = { swimmerId, teamId, gender, classYear: null, roster: 'member' };
    swimmers.push(swimmer);
    swimmerById.set(swimmerId, swimmer);
    const name = nonEmpty(s.name) ?? nonEmpty(s.display_name);
    if (name !== undefined) swimmerNames[swimmerId] = { name };
  });

  // ---- events: the meet's own list first, then every event a row names ----
  const eventShapes = new Map<EventKey, SimulatorEventShape>();
  const noteEvent = (shape: SimulatorEventShape): SimulatorEventShape => {
    const known = eventShapes.get(shape.eventKey);
    if (known) return known;
    eventShapes.set(shape.eventKey, shape);
    return shape;
  };
  settings.eventIds.forEach((id, i) => {
    const path = `settings.eventIds[${i}]`;
    const parts = id.split('|');
    const stroke = parts[0] ?? '';
    const distance = readDistance(parts[1] ?? '', path);
    if (stroke !== 'H' && parts[2] !== 'Y') {
      throw new AdapterError('unsupported_course', path, `event "${id}" is not a yards event`);
    }
    noteEvent(simulatorEvent(stroke, distance, path));
  });

  const checkCourse = (stroke: string, course: string, path: string): void => {
    if (stroke === 'H') {
      // A dive has no course. The page sends `divecourse=6` and gets rows coded "6" or "".
      if (course !== '6' && course !== '') throw new AdapterError('unsupported_course', path, `dive course code "${course}" is not "6" or ""`);
    } else if (course !== 'Y') {
      throw new AdapterError('unsupported_course', path, `course "${course}" is not Y (SCY)`);
    }
  };

  // ---- swims, splits ----
  const swims: MeetSwim[] = [];
  const relaySplits: RelaySplit[] = [];
  const swimIds = new Set<string>();
  const splitIds = new Set<string>();
  const bestDive = new Map<string, { id: string | number; swimmerId: SwimmerId; eventKey: EventKey; hundredths: Hundredths }>();
  let relayRows = 0;

  rawSwims.forEach((row, i) => {
    const path = `swims[${i}]`;
    if (row.kind === 'relay') {
      relayRows += 1;
      return;
    }
    if (row.swimmerId === null) throw new AdapterError('unresolved_reference', `${path}.swimmerId`, `a ${row.kind} row has no swimmer`);
    const swimmerId = String(row.swimmerId);
    if (!swimmerById.has(swimmerId)) throw new AdapterError('unresolved_reference', `${path}.swimmerId`, `swimmer ${swimmerId} is not in swimmers`);
    // "X" is a mixed event: the swimmer row's own gender was checked above, so the time is theirs. Whether
    // the swim is used is SwimCloud's choice, read from its splashes. Any other code must match the simulator.
    if (row.eventgender !== 'X' && genderOf(row.eventgender, `${path}.eventgender`) !== gender) {
      throw new AdapterError('swimmer_gender', `${path}.eventgender`, `row is ${row.eventgender}, the simulator is ${settings.gender}`);
    }
    checkCourse(row.eventstroke, row.eventcourse, `${path}.eventcourse`);
    const shape = noteEvent(simulatorEvent(row.eventstroke, readDistance(row.eventdistance, `${path}.eventdistance`), path));
    if (shape.kind === 'relay') throw new AdapterError('unknown_event', path, `a ${row.kind} row names the relay "${shape.eventKey}"`);
    const hundredths = parseSwimCloudHundredths(row.eventtime, `${path}.eventtime`);

    if (row.kind === 'split') {
      if (shape.kind === 'diving') throw new AdapterError('unknown_event', path, 'a relay split cannot be a dive');
      const splitId = `split:${String(row.id)}`;
      if (splitIds.has(splitId)) throw new AdapterError('duplicate_id', `${path}.id`, `split ${splitId} appears twice`);
      splitIds.add(splitId);
      relaySplits.push({
        splitId,
        swimmerId,
        relayEventKey: null,
        legPosition: null,
        start: row.flystart === true ? 'flying' : row.flystart === false ? 'flat' : 'unknown',
        legEventKey: shape.eventKey,
        split: timeValue(hundredths, false),
        course: 'SCY',
        date: null,
        origin,
      });
      return;
    }

    if (shape.kind === 'diving') {
      if (row.kind === 'leadoff') throw new AdapterError('unknown_event', path, 'a relay leadoff cannot be a dive');
      // One row per diver and event: the highest score, across both course codes.
      const k = swimKey(swimmerId, shape.eventKey);
      const held = bestDive.get(k);
      if (held === undefined || hundredths > held.hundredths) bestDive.set(k, { id: row.id, swimmerId, eventKey: shape.eventKey, hundredths });
      return;
    }

    const swimId = `${row.kind}:${String(row.id)}`;
    if (swimIds.has(swimId)) throw new AdapterError('duplicate_id', `${path}.id`, `swim ${swimId} appears twice`);
    swimIds.add(swimId);
    swims.push({
      swimId,
      swimmerId,
      eventKey: shape.eventKey,
      recordedCourse: 'SCY',
      recordedTime: timeValue(hundredths, false),
      date: null,
      seasonId: null,
      flags: row.kind === 'leadoff' ? { extractedSplit: true } : {},
      scy: { kind: 'recorded-scy' },
      origin,
    });
  });
  for (const dive of bestDive.values()) {
    const swimId = `ind:${String(dive.id)}`;
    if (swimIds.has(swimId)) throw new AdapterError('duplicate_id', 'swims', `swim ${swimId} appears twice`);
    swimIds.add(swimId);
    swims.push({
      swimId,
      swimmerId: dive.swimmerId,
      eventKey: dive.eventKey,
      recordedCourse: 'SCY',
      recordedTime: timeValue(dive.hundredths, true),
      date: null,
      seasonId: null,
      flags: {},
      scy: { kind: 'recorded-scy' },
      origin,
    });
  }

  const swimsByKey = new Map<string, MeetSwim[]>();
  for (const swim of swims) {
    const k = swimKey(swim.swimmerId, swim.eventKey);
    const bucket = swimsByKey.get(k);
    if (bucket) bucket.push(swim);
    else swimsByKey.set(k, [swim]);
  }
  const splitsByKey = new Map<string, RelaySplit[]>();
  for (const split of relaySplits) {
    const k = swimKey(split.swimmerId, split.legEventKey as EventKey);
    const bucket = splitsByKey.get(k);
    if (bucket) bucket.push(split);
    else splitsByKey.set(k, [split]);
  }

  // ---- the lineup: the page's own entries ----
  const legSplashes = new Map<string, { splash: SimulatorSplashInput; index: number }[]>();
  rawSplashes.forEach((sp, index) => {
    if (sp.relay_id === undefined || sp.relay_id === null) return;
    const k = String(sp.relay_id);
    const bucket = legSplashes.get(k);
    if (bucket) bucket.push({ splash: sp, index });
    else legSplashes.set(k, [{ splash: sp, index }]);
  });

  const entries: LineupEntry[] = [];
  const observedEntries: ObservedEntry[] = [];
  const entryTimes: Record<string, TimeValue> = {};
  const relayLetters = new Map<string, number>();
  const usedRelayIds = new Set<string>();

  const needTeam = (sp: SimulatorSplashInput, path: string): TeamId => {
    const teamId = String(sp.teamId);
    if (!teamIds.has(teamId)) throw new AdapterError('unresolved_reference', `${path}.teamId`, `team ${teamId} is not in teams`);
    return teamId;
  };
  const needSwimmer = (id: string | number | null, teamId: TeamId, path: string): MeetSwimmer => {
    if (id === null) throw new AdapterError('invalid_splash', `${path}.swimmerId`, 'the splash has no swimmer');
    const swimmer = swimmerById.get(String(id));
    if (!swimmer) throw new AdapterError('unresolved_reference', `${path}.swimmerId`, `swimmer ${String(id)} is not in swimmers`);
    if (swimmer.teamId !== teamId) {
      throw new AdapterError('unresolved_reference', `${path}.swimmerId`, `swimmer ${swimmer.swimmerId} is on team ${swimmer.teamId}, the splash on ${teamId}`);
    }
    return swimmer;
  };
  const needTime = (raw: string | number | null | undefined, path: string, what: string): Hundredths => {
    if (raw === null || raw === undefined) throw new AdapterError('invalid_splash', `${path}.eventtime`, `${what} has no time; the adapter cannot tell which swim the page used`);
    return parseSwimCloudHundredths(raw, `${path}.eventtime`);
  };

  rawSplashes.forEach((sp, index) => {
    const path = `splashes[${index}]`;
    if (sp.relay_id !== undefined && sp.relay_id !== null) return; // a leg: read with its relay
    if (isExhibition(sp.exhibition)) {
      throw new AdapterError('unsupported_exhibition', `${path}.exhibition`, 'an exhibition entry is scored by the page in a way no engine rule matches');
    }
    const teamId = needTeam(sp, path);
    checkCourse(sp.eventstroke, sp.eventcourse, `${path}.eventcourse`);
    const shape = noteEvent(simulatorEvent(sp.eventstroke, readDistance(sp.eventdistance, `${path}.eventdistance`), path));

    if (shape.kind !== 'relay') {
      const swimmer = needSwimmer(sp.swimmerId, teamId, path);
      const hundredths = needTime(sp.eventtime, path, 'an individual entry');
      const matches = (swimsByKey.get(swimKey(swimmer.swimmerId, shape.eventKey)) ?? []).filter((s) => s.recordedTime?.hundredths === hundredths);
      if (matches.length === 0) {
        throw new AdapterError(
          'time_not_in_swims',
          `${path}.eventtime`,
          `${String(sp.eventtime)} in "${shape.eventKey}" matches no swim of swimmer ${swimmer.swimmerId}; a coach edit, or a dive rule that kept the wrong score`,
        );
      }
      // Equal times from two rows score alike. Prefer a result over a leadoff, then model order.
      const seed = matches.find((s) => s.flags.extractedSplit !== true) ?? (matches[0] as MeetSwim);
      const entry: LineupEntry = { kind: 'individual', teamId, swimmerId: swimmer.swimmerId, eventKey: shape.eventKey, gender, seedSwimId: seed.swimId };
      entries.push(entry);
      const key = entryKey(entry);
      entryTimes[key] = timeValue(hundredths, shape.kind === 'diving');
      observedEntries.push({ entryKey: key, splashId: String(sp.id), teamId, swimmerId: swimmer.swimmerId, eventKey: shape.eventKey, gender, points: sp.points ?? null });
      return;
    }

    // A relay-level splash.
    if (sp.swimmerId !== null) throw new AdapterError('invalid_relay', `${path}.swimmerId`, 'a relay splash names a swimmer');
    const relayId = String(sp.id);
    usedRelayIds.add(relayId);
    const legs = (legSplashes.get(relayId) ?? []).slice().sort((a, b) => Number(a.splash.legposition) - Number(b.splash.legposition));
    if (legs.length !== 4 || legs.some((l, i) => Number(l.splash.legposition) !== i + 1)) {
      throw new AdapterError('invalid_relay', path, `relay ${relayId} has ${legs.length} leg splash(es); expected legs 1 to 4 (an actual relay has none and is not supported)`);
    }
    let total = 0;
    const relayLegs = legs.map(({ splash: leg, index: legIndex }): RelayLeg => {
      const legPath = `splashes[${legIndex}]`;
      const legTeam = needTeam(leg, legPath);
      if (legTeam !== teamId) throw new AdapterError('invalid_relay', `${legPath}.teamId`, `leg is on team ${legTeam}, the relay on ${teamId}`);
      const swimmer = needSwimmer(leg.swimmerId, teamId, legPath);
      checkCourse(leg.eventstroke, leg.eventcourse, `${legPath}.eventcourse`);
      const legShape = noteEvent(simulatorEvent(leg.eventstroke, readDistance(leg.eventdistance, `${legPath}.eventdistance`), legPath));
      if (legShape.kind !== 'individual') throw new AdapterError('invalid_relay', legPath, `leg event "${legShape.eventKey}" is not a swimming stroke`);
      const hundredths = needTime(leg.eventtime, legPath, 'a relay leg');
      total += hundredths;
      if (leg.flystart === null || leg.flystart === undefined) {
        throw new AdapterError('invalid_relay', `${legPath}.flystart`, 'the leg does not say flat or flying start; the adapter will not guess');
      }
      if (leg.flystart) {
        const found = (splitsByKey.get(swimKey(swimmer.swimmerId, legShape.eventKey)) ?? []).filter((s) => s.start === 'flying' && s.split.hundredths === hundredths);
        const split = found[0];
        if (!split) throw new AdapterError('time_not_in_swims', `${legPath}.eventtime`, `flying split ${String(leg.eventtime)} in "${legShape.eventKey}" matches no split of swimmer ${swimmer.swimmerId}`);
        return { swimmerId: swimmer.swimmerId, basis: { kind: 'split', splitId: split.splitId } };
      }
      const flat = (swimsByKey.get(swimKey(swimmer.swimmerId, legShape.eventKey)) ?? []).filter((s) => s.recordedTime?.hundredths === hundredths);
      const swim = flat.find((s) => s.flags.extractedSplit !== true) ?? flat[0];
      if (!swim) throw new AdapterError('time_not_in_swims', `${legPath}.eventtime`, `flat-start time ${String(leg.eventtime)} in "${legShape.eventKey}" matches no swim of swimmer ${swimmer.swimmerId}`);
      return { swimmerId: swimmer.swimmerId, basis: { kind: 'flat-start-swim', swimId: swim.swimId } };
    });
    const relayTime = needTime(sp.eventtime, path, 'a relay entry');
    if (relayTime !== total) {
      throw new AdapterError('relay_time_mismatch', `${path}.eventtime`, `the page's relay time is ${relayTime} hundredths; its four legs sum to ${total}`);
    }
    const letterKey = `${teamId}|${shape.eventKey}`;
    const n = relayLetters.get(letterKey) ?? 0;
    if (n >= 26) throw new AdapterError('invalid_relay', path, `team ${teamId} has more than 26 relays in "${shape.eventKey}"`);
    relayLetters.set(letterKey, n + 1);
    const entry: LineupEntry = {
      kind: 'relay',
      teamId,
      eventKey: shape.eventKey,
      gender,
      letter: String.fromCharCode(65 + n),
      legs: relayLegs as [RelayLeg, RelayLeg, RelayLeg, RelayLeg],
    };
    entries.push(entry);
    const key = entryKey(entry);
    entryTimes[key] = timeValue(relayTime, false);
    observedEntries.push({ entryKey: key, splashId: relayId, teamId, swimmerId: null, eventKey: shape.eventKey, gender, points: sp.points ?? null });
  });
  for (const relayId of legSplashes.keys()) {
    if (!usedRelayIds.has(relayId)) {
      throw new AdapterError('invalid_relay', 'splashes', `leg splashes name relay ${relayId}, which no relay splash has`);
    }
  }

  // ---- observed totals ----
  let observedScores: MeetModel['observedScores'] = null;
  if (snapshot.totalScores !== null) {
    observedScores = Object.entries(snapshot.totalScores).map(([teamId, score]) => {
      if (!teamIds.has(teamId)) throw new AdapterError('unresolved_reference', `totalScores.${teamId}`, `team ${teamId} is not in teams`);
      return { teamId, points: score.points };
    });
  }

  const events: MeetEvent[] = [...eventShapes.values()].map((shape) => ({ ...shape, gender }));
  const teamNames: Record<TeamId, { name: string }> = {};
  for (const t of snapshot.teams) {
    const name = nonEmpty(t.name);
    if (name !== undefined) teamNames[String(t.id)] = { name };
  }

  // The adapter's own output goes through the model's validator: a model the adapter should not
  // build fails here, with a path, and never reaches the scorer.
  const model = validateMeetModel({
    payloadVersion: 1,
    meetKey: opts.meetKey,
    teams,
    swimmers,
    events,
    swims,
    relaySplits,
    recordRange: recordRange(settings),
    // The window is the simulator's own request; nothing here widens it (plan F1.1).
    extendedWindow: false,
    observedScores,
    display: { swimmers: swimmerNames, teams: teamNames },
  });
  const display: LineupDisplay = { swimmers: swimmerNames, teams: teamNames, entryTimes };
  const lineup: Lineup = { payloadVersion: 1, meetKey: opts.meetKey, entries, display };

  return { kind: 'ready', adapted: { model, lineup, preset, observedEntries, ignored: { relayRows }, ...(divisionSeasonNote ? { divisionSeasonNote } : {}) } };
}
