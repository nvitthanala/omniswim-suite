/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F7: the built theoretical-meet workspace records which events the build
 * preview removed (`loadedMeet.theoreticalRemovedEvents`), so the banner can
 * name them instead of saying events "may have been removed".
 *
 * ## What it pins
 *
 * - The stored list is exactly the (swimmer, event) pairs the builder marked
 *   `removed_by_user`, with the team, gender, swimmer name, event and the seed
 *   time that was removed, in report order.
 * - Absent is not empty. A build with no removal stores `[]`. A workspace built
 *   before the list existed has no field, and the reader returns `undefined`,
 *   so no reader can say "none were removed" about it.
 * - A removal that matches no offered event is not a removed event. It stays in
 *   `report.unmatchedExclusions` and out of the list.
 *
 * CONSTRUCTED swims (a name, a team, an event and a time); no competition
 * standard is typed in.
 */
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import type { HistoricalSwim } from '../packages/core/src/types';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { createWorkspaceSchema, updateWorkspaceSchema } from '../packages/core/src/schemas/workspace';
import { workspaceRowValues } from '../packages/db/src/workspacePersistence';
import {
  buildTheoreticalMeetSeeds,
  type TheoreticalEventExclusion,
  type TheoreticalMeetInput,
  type TheoreticalMeetSeeds,
  type TheoreticalMeetTeamInput,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';
import {
  buildTheoreticalMeetWorkspace,
  removedEventsOfReport,
  theoreticalRemovedEvents,
  TheoreticalWorkspaceError,
} from '../packages/manager/src/lib/theoreticalMeetWorkspace';

const TEAM = 'Alpha University';
// Eleven events: more than the NSISC total cap of 7, so the report holds events the cap left out as well as
// events the user removed. A removal must not be confused with a cap.
const EVENTS: ReadonlyArray<readonly [string, string]> = [
  ['50 Free SCY', '20.00'],
  ['100 Free SCY', '44.50'],
  ['200 Free SCY', '1:38.00'],
  ['500 Free SCY', '4:30.00'],
  ['100 Back SCY', '50.20'],
  ['200 Back SCY', '1:50.00'],
  ['100 Breast SCY', '56.00'],
  ['200 Breast SCY', '2:03.00'],
  ['100 Fly SCY', '49.80'],
  ['200 Fly SCY', '1:50.00'],
  ['200 IM SCY', '1:52.00'],
];

const swim = (name: string, event: string, time: string): HistoricalSwim => ({
  name,
  team: TEAM,
  gender: Gender.MEN,
  event,
  time,
  timeType: 'SCY',
  source: 'swimcloud',
});

/** `'1:38.00'` plus 0.5 s is `'1:38.50'`. */
function addSeconds(time: string, seconds: number): string {
  const [m, sec] = time.includes(':') ? time.split(':') : ['0', time];
  const total = Number(m) * 60 + Number(sec) + seconds;
  const mins = Math.floor(total / 60);
  const rest = (total - mins * 60).toFixed(2).padStart(5, '0');
  return mins > 0 ? `${mins}:${rest}` : String(Number(rest).toFixed(2));
}

const athlete = (name: string): SwimCloudAthlete => ({ name, swimCloudSwimmerId: `${TEAM}:${name}`, classYear: 'JR', gender: 'Men' });

const team: TheoreticalMeetTeamInput = {
  teamName: TEAM,
  gender: Gender.MEN,
  rosterStatus: 'parsed',
  athletes: ['Ann', 'Bob'].map((name, i) => ({
    athlete: athlete(name),
    swims: EVENTS.map(([event, time]) => swim(name, event, addSeconds(time, i * 0.5))),
  })),
};

function seedsWith(excludedEvents?: readonly TheoreticalEventExclusion[]): TheoreticalMeetSeeds {
  const input: TheoreticalMeetInput = {
    meetId: 'ws-removed',
    course: 'SCY',
    scoringSettings: NSISC_PRESET_SETTINGS,
    conference: 'NSISC',
    teams: [team],
    ...(excludedEvents === undefined ? {} : { excludedEvents }),
  };
  return buildTheoreticalMeetSeeds(input);
}

const buildWorkspace = (seeds: TheoreticalMeetSeeds) =>
  buildTheoreticalMeetWorkspace({ seeds, workspaceId: 'ws-removed', createdAt: 1, conference: 'NSISC' });

describe('F7 removed events on the built workspace', () => {
  const plain = seedsWith();
  const swimmers = plain.report.teams[0].eventsChosenPerSwimmer;
  const ann = swimmers.find(s => s.name === 'Ann')!;
  const bob = swimmers.find(s => s.name === 'Bob')!;
  const annChosen = ann.events.filter(e => e.chosen);
  const bobChosen = bob.events.filter(e => e.chosen);

  it('has chosen events to remove, and events the cap left out', () => {
    expect(annChosen.length).toBeGreaterThanOrEqual(2);
    expect(bobChosen.length).toBeGreaterThanOrEqual(1);
    expect(ann.events.some(e => e.notChosenReason === 'entry_cap')).toBe(true);
  });

  it('stores exactly the events the builder removed', () => {
    const removals: TheoreticalEventExclusion[] = [
      { teamName: TEAM, gender: Gender.MEN, swimmerKey: ann.swimmerKey, event: annChosen[0].event },
      { teamName: TEAM, gender: Gender.MEN, swimmerKey: bob.swimmerKey, event: bobChosen[0].event },
    ];
    const seeds = seedsWith(removals);
    const build = buildWorkspace(seeds);
    const stored = build.payload.loadedMeet.theoreticalRemovedEvents;
    expect(stored).toStrictEqual([
      { teamName: TEAM, gender: Gender.MEN, swimmerName: 'Ann', event: annChosen[0].event, time: annChosen[0].time },
      { teamName: TEAM, gender: Gender.MEN, swimmerName: 'Bob', event: bobChosen[0].event, time: bobChosen[0].time },
    ]);
    // The same pairs the report counts.
    expect(stored).toHaveLength(seeds.report.teams.reduce((n, t) => n + t.eventsRemovedByUser, 0));
    // A removed event has no row in the meet. The same swim has one in a build with no removal,
    // so the check is not an artefact of how a row spells its event.
    const hasRow = (rows: readonly { name: string; event: string; team: string }[], removed: { swimmerName: string; event: string; teamName: string }) =>
      rows.some(r => r.name === removed.swimmerName && r.event === removed.event && r.team === removed.teamName);
    const plainRows = buildWorkspace(plain).payload.menResults;
    for (const removed of stored ?? []) {
      expect(hasRow(plainRows, removed), `${removed.swimmerName} ${removed.event} in the plain build`).toBe(true);
      expect(hasRow(build.payload.menResults, removed)).toBe(false);
    }
  });

  it('stores an empty list, not a missing one, when nothing was removed', () => {
    const build = buildWorkspace(plain);
    expect(build.payload.loadedMeet.theoreticalRemovedEvents).toStrictEqual([]);
    expect(theoreticalRemovedEvents(build.payload)).toStrictEqual([]);
  });

  it('leaves out a removal that matched no offered event', () => {
    const seeds = seedsWith([{ teamName: TEAM, gender: Gender.MEN, swimmerKey: ann.swimmerKey, event: '1650 Free SCY' }]);
    expect(seeds.report.unmatchedExclusions).toHaveLength(1);
    expect(buildWorkspace(seeds).payload.loadedMeet.theoreticalRemovedEvents).toStrictEqual([]);
  });

  it('reads a legacy workspace as unknown, never as none removed', () => {
    const build = buildWorkspace(plain);
    const { theoreticalRemovedEvents: _dropped, ...legacyMeet } = build.payload.loadedMeet;
    expect(theoreticalRemovedEvents({ loadedMeet: legacyMeet })).toBeUndefined();
    // Not a theoretical meet at all.
    expect(theoreticalRemovedEvents({ loadedMeet: { meetLabel: 'NSISC 2026', theoreticalRemovedEvents: [] } })).toBeUndefined();
    expect(theoreticalRemovedEvents(null)).toBeUndefined();
  });

  it('survives the JSON column the workspace is saved in', () => {
    const removals = [{ teamName: TEAM, gender: Gender.MEN, swimmerKey: ann.swimmerKey, event: annChosen[0].event }];
    const loaded = JSON.parse(JSON.stringify(buildWorkspace(seedsWith(removals)).payload.loadedMeet));
    expect(theoreticalRemovedEvents({ loadedMeet: loaded })).toHaveLength(1);
  });

  it('passes the create and update schemas and the saved loaded_meet column', () => {
    const removals = [{ teamName: TEAM, gender: Gender.MEN, swimmerKey: ann.swimmerKey, event: annChosen[0].event }];
    const { payload } = buildWorkspace(seedsWith(removals));
    const stored = payload.loadedMeet.theoreticalRemovedEvents;
    expect(stored).toHaveLength(1);
    // The routes parse the body with these. A strict loadedMeet would drop the list and store "unknown".
    for (const schema of [createWorkspaceSchema, updateWorkspaceSchema]) {
      const parsed = schema.parse(JSON.parse(JSON.stringify(payload)));
      expect((parsed.loadedMeet as { theoreticalRemovedEvents?: unknown }).theoreticalRemovedEvents).toStrictEqual(stored);
    }
    const row = workspaceRowValues(payload as never, 0);
    expect(JSON.parse(String(row.loaded_meet)).theoreticalRemovedEvents).toStrictEqual(stored);
  });

  it('refuses a report that counts one number and lists another', () => {
    const seeds = seedsWith([{ teamName: TEAM, gender: Gender.MEN, swimmerKey: ann.swimmerKey, event: annChosen[0].event }]);
    const lying = {
      ...seeds.report,
      teams: seeds.report.teams.map(t => ({ ...t, eventsRemovedByUser: t.eventsRemovedByUser + 1 })),
    };
    expect(() => removedEventsOfReport(lying)).toThrow(TheoreticalWorkspaceError);
  });
});
