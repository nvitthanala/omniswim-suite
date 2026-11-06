/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a (plans/2026-10-25/D7-DATA-SOURCING.md section 4, "Membership"): apply fetched rosters to an adapted simulator meet.
 *
 * The adapter marks every swimmer the simulator lists as a `member` (adapt.ts), because the endpoint lists the current roster.
 * This module lets a stored roster change that, and fills `MeetSwimmer.classYear`. It is pure: no storage, no network, no clock.
 * The caller reads the stored rosters, resolves the class years (override, then sourced, then absent) and passes both in.
 *
 * | Mode | Roster | Simulator lists the swimmer | `MeetSwimmer.roster` |
 * |---|---|---|---|
 * | `simulator-current` | any | yes | `member`, unchanged. A fetched roster is a cross-check only: mismatches are listed, never applied. |
 * | `season` | not loaded | yes | `unknown` |
 * | `season` | members, id listed | yes | `member` |
 * | `season` | members, id not listed | yes | `not_member` |
 * | `season` | verified-empty | yes | `unknown`, plus a contradiction note |
 * | `season` | members, zero overlap with the simulator's ids | yes | `unknown` for the team, plus the note `id-join-suspect` |
 *
 * Checks run in this order for a team: not loaded, verified-empty, zero overlap, then each id. Zero overlap first, or one id-scheme
 * mismatch would turn a whole team into `not_member`.
 *
 * A `not_member` swimmer's lineup entries are removed and listed. A relay with such a leg is removed whole (else `scoreMeet` throws
 * `roster_not_member`). Members of the roster with no swims in the simulator are counted, never added as entries.
 *
 * Decision P: the result must never reach `rescoreSimulator` or `parityReport`. Parity reads the raw snapshot only.
 * Swimmers join by SwimCloud id. No name is ever compared.
 */
import { entryKey, validateMeetModel } from '@omniswim/engine';
import type { Gender, Lineup, LineupEntry, MeetModel, MeetSwimmer, SwimmerId, TeamId } from '@omniswim/engine';

/** What a stored roster says, without the storage types. The extension builds it from a `RosterRecord`. */
export type RosterEvidence =
  /** No record: the season was never fetched, or every fetch was refused. */
  | { readonly state: 'not-loaded' }
  /** SwimCloud said "No rosters found". */
  | { readonly state: 'verified-empty'; readonly gender: Gender }
  | { readonly state: 'members'; readonly gender: Gender; readonly memberIds: readonly SwimmerId[] };

export type EnrichMode = 'simulator-current' | 'season';

export interface EnrichInput {
  readonly mode: EnrichMode;
  /** By team id. A team with no key is `not-loaded`. */
  readonly rosters: Readonly<Record<TeamId, RosterEvidence>>;
  /** By swimmer id: the resolved class year, or `null` for absent. A swimmer with no key gets `null`. */
  readonly classYears?: Readonly<Record<SwimmerId, MeetSwimmer['classYear']>>;
}

export type TeamRosterStatus = 'not-loaded' | 'verified-empty' | 'members' | 'id-join-suspect';

export interface TeamEnrichment {
  readonly teamId: TeamId;
  readonly status: TeamRosterStatus;
  /** The simulator's swimmers for this team. */
  readonly simulatorSwimmers: number;
  /** Roster members the simulator also lists. */
  readonly overlap: number;
  /** Roster members with no swims in the simulator: "N on the roster have no swims here". Zero unless the roster has members. */
  readonly rosterOnly: readonly SwimmerId[];
  /** Simulator swimmers the roster does not list. In `simulator-current` mode these are mismatches, listed and not applied. */
  readonly notOnRoster: readonly SwimmerId[];
  readonly notes: readonly string[];
}

export interface RemovedEntry {
  readonly entryKey: string;
  readonly teamId: TeamId;
  readonly kind: 'individual' | 'relay';
  readonly eventKey: string;
  /** The `not_member` swimmers that caused the removal. One for an individual entry, one or more for a relay. */
  readonly swimmerIds: readonly SwimmerId[];
}

export interface EnrichResult {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly teams: readonly TeamEnrichment[];
  readonly removedEntries: readonly RemovedEntry[];
}

/** Sorted, so the result does not depend on set order. */
const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

export function enrichRosterMembership(input: { readonly model: MeetModel; readonly lineup: Lineup }, enrich: EnrichInput): EnrichResult {
  const { model, lineup } = input;
  const apply = enrich.mode === 'season';

  const byTeam = new Map<TeamId, MeetSwimmer[]>();
  for (const s of model.swimmers) {
    const list = byTeam.get(s.teamId) ?? [];
    list.push(s);
    byTeam.set(s.teamId, list);
  }

  const teams: TeamEnrichment[] = [];
  const membership = new Map<SwimmerId, MeetSwimmer['roster']>();
  for (const team of model.teams) {
    const swimmers = byTeam.get(team.teamId) ?? [];
    const simIds = new Set(swimmers.map((s) => s.swimmerId));
    const evidence = Object.hasOwn(enrich.rosters, team.teamId) ? (enrich.rosters[team.teamId] as RosterEvidence) : ({ state: 'not-loaded' } as const);
    if (evidence.state !== 'not-loaded') {
      const wrong = swimmers.find((s) => s.gender !== evidence.gender);
      if (wrong) throw new RangeError(`enrichRosterMembership: the ${evidence.gender} roster of team ${team.teamId} was given for a ${wrong.gender} meet`);
    }
    const notes: string[] = [];
    let status: TeamRosterStatus;
    let rosterOnly: SwimmerId[] = [];
    let notOnRoster: SwimmerId[] = [];
    let overlap = 0;
    let assign: (s: MeetSwimmer) => MeetSwimmer['roster'] = () => 'unknown';
    if (evidence.state === 'not-loaded') {
      status = 'not-loaded';
    } else if (evidence.state === 'verified-empty') {
      status = 'verified-empty';
      if (swimmers.length > 0) notes.push(`SwimCloud lists no roster for this season, but the simulator lists ${swimmers.length} swimmers for this team. Membership stays unknown.`);
    } else {
      const roster = new Set(evidence.memberIds);
      overlap = swimmers.filter((s) => roster.has(s.swimmerId)).length;
      rosterOnly = sorted([...roster].filter((id) => !simIds.has(id)));
      notOnRoster = sorted(swimmers.filter((s) => !roster.has(s.swimmerId)).map((s) => s.swimmerId));
      if (swimmers.length > 0 && overlap === 0) {
        status = 'id-join-suspect';
        notes.push('id-join-suspect: no roster id matches a simulator swimmer id (or no current swimmer was on this roster). Membership stays unknown for this team.');
      } else {
        status = 'members';
        assign = (s) => (roster.has(s.swimmerId) ? 'member' : 'not_member');
      }
    }
    teams.push({ teamId: team.teamId, status, simulatorSwimmers: swimmers.length, overlap, rosterOnly, notOnRoster, notes });
    if (apply) for (const s of swimmers) membership.set(s.swimmerId, assign(s));
  }

  const classYears = enrich.classYears ?? {};
  const swimmers: MeetSwimmer[] = model.swimmers.map((s) => ({
    ...s,
    classYear: Object.hasOwn(classYears, s.swimmerId) ? (classYears[s.swimmerId] ?? null) : null,
    ...(apply ? { roster: membership.get(s.swimmerId) ?? 'unknown' } : {}),
  }));
  const notMember = new Set(swimmers.filter((s) => s.roster === 'not_member').map((s) => s.swimmerId));

  const removedEntries: RemovedEntry[] = [];
  const kept: LineupEntry[] = [];
  for (const entry of lineup.entries) {
    const bad = entry.kind === 'individual' ? (notMember.has(entry.swimmerId) ? [entry.swimmerId] : []) : sorted(new Set(entry.legs.map((l) => l.swimmerId).filter((id) => notMember.has(id))));
    if (bad.length === 0) { kept.push(entry); continue; }
    removedEntries.push({ entryKey: entryKey(entry), teamId: entry.teamId, kind: entry.kind, eventKey: entry.eventKey, swimmerIds: bad });
  }
  const removedKeys = new Set(removedEntries.map((r) => r.entryKey));
  const entryTimes = lineup.display?.entryTimes;
  const display = lineup.display && entryTimes
    ? { ...lineup.display, entryTimes: Object.fromEntries(Object.entries(entryTimes).filter(([k]) => !removedKeys.has(k))) }
    : lineup.display;

  return {
    model: validateMeetModel({ ...model, swimmers }),
    lineup: { ...lineup, entries: kept, ...(display ? { display } : {}) },
    teams,
    removedEntries,
  };
}
