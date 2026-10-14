/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for the printable lineup and relay cards. No React.
 *
 * Everything here is read from data the app already holds: the active entry
 * plan (`selectActiveEntries`, the same rows an export writes), the relay
 * groups the Relays screen shows (`buildRelayGroups`) and the projected team
 * total. Nothing is scored, estimated or filled in. A time that is not stored
 * prints as `NT`, never as `0.00`.
 */

import { Gender, type Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { selectActiveEntries } from '@omniswim/core/lib/entryExport';
import { relayLegTimeView } from '@omniswim/core/lib/relaySplits';
import { isEstimatedRelayRow } from '@omniswim/core/lib/theoreticalMeetLabel';
import { convertTimeToSeconds, isRelayResult } from '@omniswim/core/lib/utils';
import { buildRelayGroups } from './indRelayGroupsView';

/** What a card prints where a time is not stored. */
export const PRINT_NO_TIME = 'NT';
/** What a card prints where a value is not stored (round, place, class, course). */
export const PRINT_ABSENT = '—';

export type PrintEventRow = {
  key: string;
  name: string;
  classYear: string;
  /** The seed time as stored, or `NT`. */
  seed: string;
  course: string;
  place: string;
};

export type PrintEventCard = {
  kind: 'event';
  key: string;
  team: string;
  event: string;
  round: string;
  rows: PrintEventRow[];
};

export type PrintRelayLeg = {
  key: string;
  /** 1-based, as the Relays screen shows it. */
  leg: number;
  name: string;
  time: string;
  vacant: boolean;
  /** `SwimmerResult.relayLegTimeTrial` is set on the leg's row. */
  timeTrial: boolean;
  /**
   * `time` is an estimate (a theoretical meet's leg, nobody swam the relay), not a split. The card and the
   * report print it with the "Estimate" label.
   */
  estimate: boolean;
};

export type PrintRelayCard = {
  kind: 'relay';
  key: string;
  team: string;
  event: string;
  round: string;
  teamTime: string;
  /** `isEstimatedRelayRow`: a relay nobody swam. */
  estimate: boolean;
  legs: PrintRelayLeg[];
};

export type PrintCard = PrintEventCard | PrintRelayCard;

export type PrintCardSet = {
  team: string;
  /** The team's projected points, or `null` when the bundle has no such team. Never 0 by default. */
  projectedPoints: number | null;
  events: PrintEventCard[];
  relays: PrintRelayCard[];
};

/**
 * A stored time for print. `''`, a dash, `NT` and any value that is not a
 * positive number of seconds print as `NT`. A real time prints as stored.
 */
export function printableTime(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (text === '' || text === '—' || text === '-') return PRINT_NO_TIME;
  const seconds = convertTimeToSeconds(text);
  if (!Number.isFinite(seconds) || seconds <= 0) return PRINT_NO_TIME;
  return text;
}

function orAbsent(value: string | number | null | undefined): string {
  const text = String(value ?? '').trim();
  return text === '' ? PRINT_ABSENT : text;
}

function isRelayEventLabel(event: string): boolean {
  return /\brelay\b/i.test(event);
}

function seedSortKey(row: PrintEventRow): number {
  if (row.seed === PRINT_NO_TIME) return Number.POSITIVE_INFINITY;
  return convertTimeToSeconds(row.seed);
}

function buildEventCards(workspace: Workspace, gender: Gender, team: string): PrintEventCard[] {
  const entries = selectActiveEntries(workspace).filter(
    e => e.gender === gender && (e.team ?? '').trim() === team && !isRelayEventLabel(e.event ?? '')
  );
  const cards = new Map<string, PrintEventCard>();
  for (const e of entries) {
    const event = orAbsent(e.event);
    const round = orAbsent(e.projectedRound);
    const key = `${event}|${round}`;
    let card = cards.get(key);
    if (!card) {
      card = { kind: 'event', key, team, event, round, rows: [] };
      cards.set(key, card);
    }
    card.rows.push({
      key: e.id,
      name: orAbsent(e.name),
      classYear: orAbsent(e.classYear),
      seed: printableTime(e.time),
      course: orAbsent(e.timeType),
      place: typeof e.projectedRank === 'number' && e.projectedRank > 0 ? String(e.projectedRank) : PRINT_ABSENT,
    });
  }
  const list = [...cards.values()];
  for (const card of list) {
    card.rows.sort((a, b) => seedSortKey(a) - seedSortKey(b) || a.name.localeCompare(b.name));
  }
  return list.sort(
    (a, b) =>
      a.event.localeCompare(b.event, undefined, { numeric: true }) ||
      a.round.localeCompare(b.round, undefined, { numeric: true })
  );
}

function buildRelayCards(
  workspace: Workspace,
  scoringBundle: ScoringBundle,
  gender: Gender,
  team: string
): PrintRelayCard[] {
  const groups = buildRelayGroups({
    allScored: scoringBundle.allScored,
    // The same source the Relays screen reads.
    originalResults: gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [],
    gender,
    team,
  });
  return groups
    .filter(group => isRelayResult(group.template) || isRelayEventLabel(group.event))
    .map(group => ({
      kind: 'relay' as const,
      key: group.key,
      team,
      event: group.event,
      round: group.roundSwam,
      teamTime: printableTime(group.teamTotal),
      estimate: isEstimatedRelayRow(workspace, group.template),
      legs: group.legs.map(leg => {
        const vacant = Boolean(leg.relayLegVacant || leg.relayMissingLeg);
        const name = (leg.name ?? '').trim();
        const legView = vacant ? null : relayLegTimeView(leg);
        return {
          key: leg.id,
          leg: (leg.relayLegIndex ?? 0) + 1,
          name: vacant && (name === '' || name === '—') ? 'Vacant' : orAbsent(name),
          // A vacant leg has no swimmer, so it has no seed. The row can still carry the split of
          // the swimmer who left; printing it would pair a time with nobody.
          time: vacant ? PRINT_NO_TIME : printableTime(legView?.time),
          vacant,
          timeTrial: leg.relayLegTimeTrial === true,
          estimate: legView?.kind === 'estimate',
        };
      }),
    }));
}

/** Every card for one team and gender: entries per event, then relays. */
export function buildPrintCards(params: {
  workspace: Workspace;
  scoringBundle: ScoringBundle;
  gender: Gender;
  team: string;
}): PrintCardSet {
  const { workspace, scoringBundle, gender, team } = params;
  const total = scoringBundle.sortedTeams.find(t => t.teamName === team)?.totalPoints;
  return {
    team,
    projectedPoints: typeof total === 'number' && Number.isFinite(total) ? total : null,
    events: buildEventCards(workspace, gender, team),
    relays: buildRelayCards(workspace, scoringBundle, gender, team),
  };
}

export function printCardCount(set: PrintCardSet): number {
  return set.events.length + set.relays.length;
}
