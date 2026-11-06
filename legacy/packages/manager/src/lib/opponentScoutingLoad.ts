/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: read ONE crawled opponent team into the seed rows `scoutOpponent` compares against.
 *
 * ```
 * capture id -> theoreticalMeetFromCaptures -> buildTheoreticalMeetSeeds -> that team's rows for one gender
 * ```
 *
 * No second selector and no second cap counter: the rows are the ones a theoretical meet would hold for
 * the team (see `theoreticalMeetSeeds.ts`). The seed is each swimmer's all-time best in SCY, so the rows
 * are measured times and never converted or projected. No relay is requested (a relay time would be a
 * sum of individual bests that no team swam). Exhibition swims are excluded (`exhibitionSeeds: 'exclude'`):
 * they were not scored at their own meet and must not take an event slot from a scored swim. An event whose
 * only best is an exhibition swim then has no seed, and the report says so. I/O is injected (`deps`), so a test runs it over a fixture.
 */

import { Gender } from '@omniswim/core/types';
import type { ScoringSettings, SwimmerResult } from '@omniswim/core/types';
import { theoreticalMeetFromCaptures, type TheoreticalCaptureDeps } from './theoreticalMeetFromCaptures';
import { buildTheoreticalMeetSeeds, type TheoreticalTeamReport } from './theoreticalMeetSeeds';
import type { ScoutCappedSeed } from './opponentScouting';

export type OpponentLoadErrorCode =
  /** More or fewer than one capture id was given. One team at one season is scouted at a time. */
  | 'one-capture-required'
  /** The capture holds no roster for the gender asked for. */
  | 'no-team-for-gender';

export class OpponentLoadError extends Error {
  readonly code: OpponentLoadErrorCode;
  constructor(code: OpponentLoadErrorCode, message: string) {
    super(message);
    this.name = 'OpponentLoadError';
    this.code = code;
  }
}

export interface OpponentSeedInput {
  /** Exactly one capture id (`team-58-2026-2027`). */
  readonly captureIds: readonly string[];
  readonly gender: Gender;
  readonly deps: TheoreticalCaptureDeps;
  /** Preset settings. Not settings that carry `usePdfPlacePoints: true` (the seed builder throws). */
  readonly scoringSettings: ScoringSettings;
  /** The conference of a resolved preset choice, or undefined. */
  readonly conference?: string;
}

export interface OpponentSeeds {
  /** The team name the rows carry. Pass as `ScoutInput.opponentTeam`. */
  readonly teamName: string;
  readonly gender: Gender;
  /** Individual seed rows of this team and gender. Empty when no swimmer has a usable SCY time (see `report`). */
  readonly rows: readonly SwimmerResult[];
  /** Why athletes have no seed, how many seeds are exhibition swims, and so on. */
  readonly report: TheoreticalTeamReport;
  /**
   * Measured seeds the entry limit left out of the lineup (candidates with `notChosenReason: 'entry_cap'`).
   * Pass as `ScoutInput.theirEntryCapped`, so "no entry" can be told from "no time".
   */
  readonly entryCapped: readonly ScoutCappedSeed[];
  /** Caveats of the seed build and of the capture read, each once. */
  readonly caveats: readonly string[];
  /** Warnings from the capture read, each once. */
  readonly warnings: readonly string[];
  readonly captureId: string;
}

/** Read one team's seeds. Throws {@link OpponentLoadError}, `TheoreticalCaptureError` or `TheoreticalMeetError`. */
export async function loadOpponentSeeds(input: OpponentSeedInput): Promise<OpponentSeeds> {
  if (input.captureIds.length !== 1) {
    throw new OpponentLoadError('one-capture-required', `Scouting reads one team capture at a time. Got ${input.captureIds.length}.`);
  }
  const captureId = input.captureIds[0] as string;
  const captured = await theoreticalMeetFromCaptures([captureId], input.deps);
  const team = captured.teams.find(t => t.gender === input.gender);
  if (team === undefined) {
    throw new OpponentLoadError('no-team-for-gender', `Capture ${captureId} holds no ${input.gender} roster.`);
  }
  const seeds = buildTheoreticalMeetSeeds({
    meetId: `scout|${captureId}`,
    course: 'SCY',
    scoringSettings: input.scoringSettings,
    exhibitionSeeds: 'exclude',
    ...(input.conference === undefined ? {} : { conference: input.conference }),
    teams: [team],
  });
  const report = seeds.report.teams[0];
  if (report === undefined) throw new Error('Opponent scouting: the seed report holds no team.');
  // May be empty: a roster with no usable SCY time. The report says why, and every event then reads "no time".
  const rows = seeds.rows.filter(r => r.gender === input.gender);
  return {
    teamName: team.teamName,
    gender: input.gender,
    rows,
    report,
    entryCapped: report.eventsChosenPerSwimmer.flatMap(swimmer =>
      swimmer.events
        .filter(candidate => candidate.chosen === false && candidate.notChosenReason === 'entry_cap')
        .map(candidate => ({ swimmer: swimmer.name, event: candidate.event, time: candidate.time }))
    ),
    caveats: [...new Set([...seeds.report.caveats, ...report.caveats])],
    warnings: [...new Set([...captured.warnings, ...team.warnings])],
    captureId,
  };
}
