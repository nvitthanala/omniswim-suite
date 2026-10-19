/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Where a meet's scored program ends, for a SwimCloud import.
 *
 * A meet numbers its program 1..N and numbers post-meet time trials above it.
 * A SwimCloud event page prints the number but not N. Without N the import
 * cannot tell the time trials from the program, and computed mode scores them:
 * meet 356467 under NSISC counted +57 men and +134 women for swims above Event 42.
 *
 * N is never guessed. It comes from one of two places, in this order:
 *
 *  1. `ScoringSettings.scoredEventNumberMax`: a number the user or a preset
 *     stated.
 *  2. A conference program on record (`data/relayPrograms.ts`, each tied to an
 *     archived source): the highest event number of the numbered championship
 *     events. Used only when the program's conference matches the workspace's
 *     and the imported meet falls inside the dates the program describes.
 *
 * Neither holds: the boundary is `unknown`, with a warning for the coach. No
 * number is written for it. NSISC has no program on record (only the order of
 * its five relays, with no event numbers), so today an NSISC import lands here.
 *
 * This result is read at import to flag rows. It is deliberately not written
 * into `scoringSettings`, where the relay leg matchers, the relay simulation and
 * the points engine would read it as a number the user stated.
 */
import { CONFERENCE_PROGRAMS, type ConferenceProgram } from '../data/relayPrograms';
import type { Workspace } from '../types';
import { conferenceWords, containsWholeWords } from './scoringDefaults';

export type ScoredProgramBoundary =
  | {
      status: 'known';
      /** Highest event number that scores. A higher number is a time trial. */
      scoredEventNumberMax: number;
      origin: 'scoring-setting' | 'conference-program';
      /** What backs the number, for a tooltip. */
      detail: string;
      /** Set for `origin: 'conference-program'`: id in `data/relay-programs/sources/manifest.json`. */
      sourceId?: string;
    }
  | {
      status: 'unknown';
      reason:
        | 'no-conference'
        | 'no-program-on-record'
        | 'meet-date-unknown'
        | 'meet-outside-program-dates'
        | 'no-event-pages';
      /** Plain words for the coach. The import returns it as a warning. */
      warning: string;
    };

export type ScoredProgramBoundaryInput = {
  /** The workspace the rows will be written into. Only these two fields are read. */
  workspace: Pick<Workspace, 'conference' | 'scoringSettings'>;
  /** The imported meet's first day, `YYYY-MM-DD`, from the page. Absent: not stated. */
  meetStartDate?: string;
  /** The imported meet's last day, `YYYY-MM-DD`. Absent for a one-day meet. */
  meetEndDate?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The boundary of a capture that holds swims-list pages and no event page.
 *
 * A swims-list row prints no event number, so no boundary, stated or published,
 * can mark a time trial in it. This is `unknown` with a warning, never `null`:
 * a silent `null` would let the time trials score with no word to the coach.
 */
export function swimsListOnlyBoundary(): ScoredProgramBoundary {
  return {
    status: 'unknown',
    reason: 'no-event-pages',
    warning:
      'The last scored event of this meet is unknown: the swims list prints no event numbers, so time trials cannot be told from program swims. ' +
      'Time trials in this capture are not marked and may score. Capture the meet event pages to mark them. ' +
      'Until then each swims-list row stays unconfirmed (no best time, arbitrage field or cut tag) until you flag it as a program swim.',
  };
}

function programMatchesConference(program: ConferenceProgram, conference: string): boolean {
  const words = conferenceWords(conference);
  // The parenthetical in a source's name is its abbreviation: "(GLVC)" is a word
  // of the name only to the source, not to a coach who types the long form.
  const names = [program.conference.replace(/\s*\([^)]*\)/g, ''), ...(program.conferenceAliases ?? [])];
  return names.some(name => containsWholeWords(words, conferenceWords(name)));
}

/** The highest numbered event of a program. Throws on an empty program: that is a data defect. */
function highestEventNumber(program: ConferenceProgram): number {
  if (program.events.length === 0) {
    throw new Error(`Conference program ${program.sourceId} lists no events, so it has no last event number.`);
  }
  return Math.max(...program.events.map(event => event.eventNumber));
}

/**
 * The scored boundary for an import into this workspace, or why there is none.
 *
 * `meetStartDate` and `meetEndDate` are the page's own dates. A program is for
 * one meet, so an import whose dates the page did not state, or whose dates fall
 * outside the program's window, gets `unknown` and never the program's number.
 * ISO strings compare correctly as text.
 */
export function resolveScoredProgramBoundary(input: ScoredProgramBoundaryInput): ScoredProgramBoundary {
  const stated = input.workspace.scoringSettings?.scoredEventNumberMax;
  if (stated !== undefined && stated !== null) {
    return {
      status: 'known',
      scoredEventNumberMax: stated,
      origin: 'scoring-setting',
      detail: `Scoring settings state that Event ${stated} is the last scored event.`,
    };
  }

  const conference = input.workspace.conference?.trim() ?? '';
  if (conference.length === 0) {
    return {
      status: 'unknown',
      reason: 'no-conference',
      warning:
        'The last scored event of this meet is unknown: the workspace names no conference, so no published program can be matched. ' +
        'Swims above the scored program (time trials) are not marked and may score.',
    };
  }

  const program = CONFERENCE_PROGRAMS.find(candidate => programMatchesConference(candidate, conference));
  if (program === undefined) {
    return {
      status: 'unknown',
      reason: 'no-program-on-record',
      warning:
        `The last scored event of this meet is unknown: no published program is on record for ${conference}. ` +
        'Swims above the scored program (time trials) are not marked and may score. ' +
        'Set the last scored event in the scoring settings to mark them.',
    };
  }

  const start = input.meetStartDate;
  if (start === undefined || !ISO_DATE.test(start)) {
    return {
      status: 'unknown',
      reason: 'meet-date-unknown',
      warning:
        `The last scored event of this meet is unknown: a ${program.season} ${program.conference} program is on record, ` +
        'but the imported meet states no date, so it cannot be matched to that program. Time trials are not marked and may score.',
    };
  }
  const end = input.meetEndDate !== undefined && ISO_DATE.test(input.meetEndDate) ? input.meetEndDate : start;
  if (start < program.meetDates.start || end > program.meetDates.end) {
    return {
      status: 'unknown',
      reason: 'meet-outside-program-dates',
      warning:
        `The last scored event of this meet is unknown: the program on record for ${program.conference} describes the meet of ` +
        `${program.meetDates.start} to ${program.meetDates.end}, and this meet ran ${start}${end === start ? '' : ` to ${end}`}. ` +
        'Time trials are not marked and may score.',
    };
  }

  const scoredEventNumberMax = highestEventNumber(program);
  return {
    status: 'known',
    scoredEventNumberMax,
    origin: 'conference-program',
    sourceId: program.sourceId,
    detail:
      `Event ${scoredEventNumberMax} is the last event of the ${program.season} ${program.conference} program ` +
      `(${program.sourceId}). Swims above it are marked as time trials.`,
  };
}
