/**
 * E4 (2026-10-16): a SwimCloud swims-list row is not evidence until the user
 * flags it as a program swim.
 *
 * The swims list prints the bare event label ("100 Y Breast") for a program swim
 * and for a post-meet time trial. The page cannot say which. The importer stamps
 * every such row `programSwim: 'unconfirmed'`. An unconfirmed row counts toward
 * no best time, no arbitrage field and no cut tag. An event-page row states its
 * own program number and carries no stamp. A PDF row carries no stamp either.
 *
 * Fixtures are synthetic pages shaped like the real ones (see
 * `tests/scoredProgramBoundary.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Gender, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import {
  buildHistoryFromWorkspace,
  categorizeBestEvents,
} from '../packages/core/src/lib/athleteHistory';
import { isRankableSwim } from '../packages/core/src/lib/bestTimeEligibility';
import {
  buildCutlineTagForTeam,
  cutlineSwimOfRecord,
  cutlineTagRenderMode,
} from '../packages/core/src/lib/cutlineTags';
import { isUnconfirmedProgramSwim } from '../packages/core/src/lib/programSwim';
import { getAthleteCreditedSwims } from '../packages/core/src/lib/scorerRoster';
import { setCreditedSwimProgramStatus } from '../packages/core/src/lib/swimEditor';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import {
  buildEventTimeIndex,
  collectDroppableEntries,
  distinctIndividualResultTeams,
} from '../packages/core/src/lib/arbitrage/shared';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { listEligibleRelayLegCandidates, swimmerMatchesRelayLeg } from '../packages/core/src/lib/relayLegMatching';
import { buildCoverageGaps } from '../packages/core/src/lib/arbitrage/crossCourseTable';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { calculatePoints } from '../packages/core/src/lib/utils';
import {
  applySwimCloudRows,
  mergeSwimCloudResults,
  swimCloudTeamMeetSwimsToSwimmerResults,
} from '../packages/matrix/src/lib/swimCloudMeetImportBridge';
import { workspaceFixture } from './helpers/typedFixtures';
import type { SwimCloudMeetEventResultsParse, SwimCloudTeamMeetSwimsParse } from '../packages/swimcloud/src/parser';

const HSU = 'Henderson State University';
/** Legs of an A/B final are not auto-eligible, so a non-scorer's vacated leg costs the relay (as in relayLegSwapTiedLegRows). */
const STRICT = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
};
const legFixture = JSON.parse(
  readFileSync(new URL('./fixtures/nsisc-2026-relay-followups-r1.json', import.meta.url), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };
const NAME = 'Test Swimmer';

function swimsListParse(swimIds: string[]): SwimCloudTeamMeetSwimsParse {
  const swims = swimIds.map(id => ({
    swimKey: `999:swim:${id}`,
    swimCloudSwimId: id,
    event: {
      eventId: `evt-${id}`,
      swimCloudMeetId: '999',
      label: '100 Y Breast',
      kind: 'individual',
      course: 'SCY',
      gender: 'Men',
      distance: 100,
      stroke: 'Breaststroke',
    },
    entry: { entryId: `entry-${id}`, eventId: `evt-${id}`, athleteName: `${NAME} ${id}`, teamName: HSU },
    result: { resultId: `result-${id}`, entryId: `entry-${id}`, eventId: `evt-${id}`, place: 1, finalTime: '58.00' },
    relayLeadoff: false,
    cutStandards: [],
  }));
  return {
    swimCloudMeetId: '999',
    meetName: 'Test Championships',
    meet: { swimCloudMeetId: '999', name: 'Test Championships', format: 'unknown', ruleset: 'unknown', course: 'unknown' },
    gender: 'Men',
    swims,
    events: swims.map(s => s.event),
    rowCount: swims.length,
  } as unknown as SwimCloudTeamMeetSwimsParse;
}

/** An event page for the same swim id as `swimsListParse(['26'])`. */
function eventPageFor(id: string): SwimCloudMeetEventResultsParse {
  return {
    swimCloudMeetId: '999',
    eventRef: id,
    meetName: 'Test Championships',
    meet: { swimCloudMeetId: '999', name: 'Test Championships', format: 'unknown', ruleset: 'unknown', course: 'SCY' },
    event: {
      eventId: `999:event:${id}`,
      swimCloudMeetId: '999',
      eventRef: id,
      label: '100 Breast',
      kind: 'individual',
      course: 'SCY',
      gender: 'Men',
      distance: 100,
      stroke: 'Breast',
    },
    gender: 'Men',
    genderLabel: 'Men',
    eventIndex: [{ eventRef: id, label: '100 Breast Men', printedNumber: id, status: 'Scored' }],
    rounds: [
      {
        round: 'Timed Finals',
        pointsColumn: 'none',
        rowCount: 1,
        swims: [
          {
            swimKey: `999:swim:${id}`,
            entry: {
              entryId: `999:swim:${id}:entry`,
              eventId: `999:event:${id}`,
              athleteName: NAME,
              swimCloudSwimmerId: id,
              swimCloudTeamId: '58',
              teamName: HSU,
            },
            result: { resultId: `r${id}`, entryId: 'e', eventId: `999:event:${id}`, place: 1, finalTime: '57.50' },
            exhibition: false,
            relayLeadoff: false,
            cutStandards: [],
          },
        ],
      },
    ],
    rowCount: 1,
  } as unknown as SwimCloudMeetEventResultsParse;
}

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return { id: 'ws', name: 'ws', menResults: [], womenResults: [], recruits: [], createdAt: 0, ...over };
}

function resultRow(over: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id: '999:swim:1',
    rank: 1,
    name: NAME,
    classYear: 'unknown',
    team: HSU,
    time: '58.00',
    points: 0,
    event: '100 Breaststroke',
    gender: Gender.MEN,
    ...over,
  };
}

async function runImport(parses: SwimCloudTeamMeetSwimsParse[], eventResults: SwimCloudMeetEventResultsParse[], loaded: Workspace = workspaceWith()) {
  const patches: Partial<Workspace>[] = [];
  await applySwimCloudRows(parses, loaded, patch => void patches.push(patch), {
    eventResults,
    resolveKeepRecruits: () => true,
  });
  return (patches[0]?.menResults ?? []) as SwimmerResult[];
}

describe('the import stamps the rows it cannot classify', () => {
  it('stamps every swims-list row unconfirmed', () => {
    const { men } = swimCloudTeamMeetSwimsToSwimmerResults(swimsListParse(['1', '2']));
    expect(men).toHaveLength(2);
    for (const row of men) expect(row.programSwim).toBe('unconfirmed');
  });

  it('leaves an event-page row unstamped, and the event page replaces the swims-list row of the same swim', async () => {
    const rows = await runImport([swimsListParse(['26'])], [eventPageFor('26')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('999:swim:26');
    expect(rows[0]!.time).toBe('57.50');
    expect(rows[0]!.programSwim).toBeUndefined();
  });

  it('leaves a swims-list row stamped when no event page covers it', async () => {
    const rows = await runImport([swimsListParse(['26'])], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.programSwim).toBe('unconfirmed');
  });

  it('keeps a confirmation across a re-import of the same swims-list row', async () => {
    const first = await runImport([swimsListParse(['26'])], []);
    const confirmed = first.map(r => ({ ...r, programSwim: 'program' as const }));
    const second = await runImport([swimsListParse(['26'])], [], workspaceWith({ menResults: confirmed }));
    expect(second).toHaveLength(1);
    expect(second[0]!.programSwim).toBe('program');
  });

  it('does not invent a confirmation: an unconfirmed stored row stays unconfirmed on re-import', async () => {
    const first = await runImport([swimsListParse(['26'])], []);
    const second = await runImport([swimsListParse(['26'])], [], workspaceWith({ menResults: first }));
    expect(second[0]!.programSwim).toBe('unconfirmed');
  });

  it('mergeSwimCloudResults: an incoming event-page row replaces a stored confirmation whole', () => {
    const stored = resultRow({ programSwim: 'program' });
    const incoming = resultRow({ time: '57.50' });
    const merged = mergeSwimCloudResults([stored], [incoming]);
    expect(merged[0]!.time).toBe('57.50');
    expect(merged[0]!.programSwim).toBeUndefined();
  });
});

describe('an unconfirmed row is not evidence', () => {
  const unconfirmed = resultRow({ programSwim: 'unconfirmed' });
  const confirmed = resultRow({ programSwim: 'program' });
  const unstamped = resultRow();

  it('isUnconfirmedProgramSwim is true only for the unconfirmed stamp', () => {
    expect(isUnconfirmedProgramSwim(unconfirmed)).toBe(true);
    expect(isUnconfirmedProgramSwim(confirmed)).toBe(false);
    expect(isUnconfirmedProgramSwim(unstamped)).toBe(false);
  });

  it('is not a best time, and a confirmed or unstamped row is', () => {
    const bestOf = (row: SwimmerResult) => {
      const history = buildHistoryFromWorkspace(workspaceWith({ menResults: [row] }));
      return categorizeBestEvents(history, HSU, Gender.MEN, NAME, NSISC_PRESET_SETTINGS);
    };
    expect(Object.keys(bestOf(unconfirmed).bestByEvent)).toHaveLength(0);
    expect(Object.keys(bestOf(confirmed).bestByEvent)).toHaveLength(1);
    expect(Object.keys(bestOf(unstamped).bestByEvent)).toHaveLength(1);
  });

  it('is kept in the history, flagged, so nothing is lost', () => {
    const history = buildHistoryFromWorkspace(workspaceWith({ menResults: [unconfirmed] }));
    expect(history).toHaveLength(1);
    expect(history[0]!.programUnconfirmed).toBe(true);
    expect(isRankableSwim(history[0]!)).toBe(false);
  });

  it('is not a competitor in an arbitrage field', () => {
    const fieldOf = (row: SwimmerResult) =>
      buildEventTimeIndex(workspaceWith({ menResults: [row] }), Gender.MEN);
    expect(fieldOf(unconfirmed).size).toBe(0);
    expect(fieldOf(confirmed).size).toBe(1);
    expect(fieldOf(unstamped).size).toBe(1);
    expect(distinctIndividualResultTeams([unconfirmed], Gender.MEN).size).toBe(0);
    expect(distinctIndividualResultTeams([confirmed], Gender.MEN).size).toBe(1);
  });

  it('is not a droppable entry, and not a field or coverage entry', () => {
    const droppable = (row: SwimmerResult) =>
      collectDroppableEntries(workspaceWith({ menResults: [row] }), HSU, Gender.MEN).size;
    expect(droppable(unconfirmed)).toBe(0);
    expect(droppable(confirmed)).toBe(1);
    expect(droppable(unstamped)).toBe(1);
    const coverage = (row: SwimmerResult) =>
      buildCoverageGaps(workspaceWith({ menResults: [row] }), { team: HSU, gender: Gender.MEN }).find(
        g => g.event === '100 Breaststroke'
      )!;
    expect(coverage(unconfirmed).fieldSize).toBe(0);
    expect(coverage(unconfirmed).countTeamEntries).toBe(0);
    expect(coverage(confirmed).fieldSize).toBe(1);
    expect(coverage(unstamped).countTeamEntries).toBe(1);
  });

  it('keeps its stamp through the what-if projection and scoring, so the credited-swim view still gates it', () => {
    const workspace = workspaceWith({ menResults: [unconfirmed, resultRow({ id: '999:swim:3', name: 'Other Swimmer' })] });
    const projected = buildWhatIfResults({ workspace, gender: Gender.MEN, removeSeniors: false });
    const scored = calculatePoints(projected, { scoringPoints: [20, 17, 16], relayMultiplier: 2 } as never, {});
    const swims = getAthleteCreditedSwims(scored, HSU, NAME, Gender.MEN);
    expect(swims).toHaveLength(1);
    expect(swims[0]!.programSwim).toBe('unconfirmed');
    // The unstamped row beside it stays unstamped.
    expect(scored.find(r => r.id === '999:swim:3')!.programSwim).toBeUndefined();
  });

  it('gets no cut tag: the state is program_unconfirmed and renders unknown', () => {
    const tagOf = (row: SwimmerResult) =>
      buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, ...cutlineSwimOfRecord(row) });
    const unconfirmedTag = tagOf(unconfirmed);
    expect(unconfirmedTag.state).toBe('program_unconfirmed');
    expect(cutlineTagRenderMode(unconfirmedTag)).toBe('unknown');
    // Confirming the swim lifts the gate. The same time is then judged against a table.
    expect(tagOf(confirmed).state).not.toBe('program_unconfirmed');
    expect(tagOf(unstamped).state).not.toBe('program_unconfirmed');
    expect(tagOf(confirmed)).toEqual(tagOf(unstamped));
  });

  it('reaches the credited-swim view, so its cut tag is gated too', () => {
    const swims = getAthleteCreditedSwims([unconfirmed], HSU, NAME, Gender.MEN);
    expect(swims).toHaveLength(1);
    expect(swims[0]!.programSwim).toBe('unconfirmed');
    const tag = buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, ...cutlineSwimOfRecord(swims[0]!) });
    expect(tag.state).toBe('program_unconfirmed');
    expect(getAthleteCreditedSwims([unstamped], HSU, NAME, Gender.MEN)[0]!).not.toHaveProperty('programSwim');
  });
});

describe('setCreditedSwimProgramStatus', () => {
  const stored = workspaceWith({ menResults: [resultRow({ programSwim: 'unconfirmed' }), resultRow({ id: '999:swim:2' })] });

  it('confirms a row, and the confirmed row counts again', () => {
    const { patch } = setCreditedSwimProgramStatus(stored, Gender.MEN, '999:swim:1', 'program');
    const next = { ...stored, ...patch };
    expect(next.menResults![0]!.programSwim).toBe('program');
    const history = buildHistoryFromWorkspace(next);
    const profile = categorizeBestEvents(history, HSU, Gender.MEN, NAME, NSISC_PRESET_SETTINGS);
    expect(Object.keys(profile.bestByEvent).length).toBeGreaterThan(0);
  });

  it('undoes exactly', () => {
    const { patch, inverse } = setCreditedSwimProgramStatus(stored, Gender.MEN, '999:swim:1', 'program');
    const undone = { ...stored, ...patch, ...inverse };
    expect(undone.menResults).toEqual(stored.menResults);
  });

  it('puts a confirmed row back to unconfirmed', () => {
    const confirmedWs = workspaceWith({ menResults: [resultRow({ programSwim: 'program' })] });
    const { patch } = setCreditedSwimProgramStatus(confirmedWs, Gender.MEN, '999:swim:1', 'unconfirmed');
    expect({ ...confirmedWs, ...patch }.menResults![0]!.programSwim).toBe('unconfirmed');
  });

  it('throws for a missing row, and for a row that carries no stamp', () => {
    expect(() => setCreditedSwimProgramStatus(stored, Gender.MEN, 'nope', 'program')).toThrow(/no result row/);
    expect(() => setCreditedSwimProgramStatus(stored, Gender.MEN, '999:swim:2', 'program')).toThrow(/no programSwim stamp/);
  });
});

/* -------------------------------------------------------------------------- */
/* Relay legs: an unconfirmed swim fills no leg                                */
/* -------------------------------------------------------------------------- */

describe('an unconfirmed swim fills no relay leg', () => {
  const FREE_50 = (over: Partial<SwimmerResult> = {}): SwimmerResult =>
    resultRow({ id: 'free50', event: '50 Freestyle', time: '21.50', ...over });
  const RELAY = '200 Freestyle Relay';

  it('swimmerMatchesRelayLeg refuses an unconfirmed swim, and accepts the same swim once confirmed or unstamped', () => {
    expect(swimmerMatchesRelayLeg(FREE_50({ programSwim: 'unconfirmed' }), RELAY, 3)).toBe(false);
    expect(swimmerMatchesRelayLeg(FREE_50({ programSwim: 'program' }), RELAY, 3)).toBe(true);
    expect(swimmerMatchesRelayLeg(FREE_50(), RELAY, 3)).toBe(true);
  });

  it('refuses it even when the settings let time trials fill a leg', () => {
    const settings = { relayLegsAllowTimeTrials: true };
    expect(swimmerMatchesRelayLeg(FREE_50({ programSwim: 'unconfirmed' }), RELAY, 3, settings)).toBe(false);
  });

  it('listEligibleRelayLegCandidates leaves it out', () => {
    const pool = [FREE_50({ programSwim: 'unconfirmed' }), FREE_50({ id: 'b', name: 'Other Swimmer', time: '22.00' })];
    const names = listEligibleRelayLegCandidates(pool, RELAY, 3, new Set(), HSU, Gender.MEN).map(s => s.name);
    expect(names).toStrictEqual(['Other Swimmer']);
  });

  it('rankRelayLegSwaps never offers a swimmer whose only leg-event swim is unconfirmed', () => {
    const ws = (rows: SwimmerResult[]) =>
      workspaceFixture({
        id: 'ws-leg-swaps',
        name: 'leg swaps',
        createdAt: 0,
        menResults: rows,
        womenResults: legFixture.womenResults,
        recruits: [],
        meetEntryPlans: [],
        activeEntryIds: [],
        athleteHistory: [],
        relayLegOverrides: [],
        deletedSwimmers: [],
        conference: 'NSISC',
        scoringSettings: STRICT,
        scorerRosterOverrides: [{ name: 'Scott Doll', team: HSU, gender: Gender.MEN, isScorer: false }],
      });
    const offered = (rows: SwimmerResult[]) =>
      new Set(
        rankRelayLegSwaps(ws(rows), { team: HSU, gender: Gender.MEN, settings: STRICT }).swaps.map(s => s.inAthlete)
      );
    const base = offered(legFixture.menResults);
    expect(base.size).toBeGreaterThan(0);
    // Mark every individual swim of one offered swimmer unconfirmed: they must vanish from the offers.
    const target = [...base][0]!;
    const marked = legFixture.menResults.map(r =>
      !r.isRelay && r.team === HSU && r.name === target ? { ...r, programSwim: 'unconfirmed' as const } : r
    );
    const after = offered(marked);
    expect(after.has(target)).toBe(false);
    // Nobody else is affected.
    for (const name of base) if (name !== target) expect(after.has(name)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* E1 / E4 follow-ups: swims-list-only warning, and never downgrade a known row */
/* -------------------------------------------------------------------------- */

describe('a swims-list-only capture warns that time trials are not marked', () => {
  it('returns an unknown boundary and a warning, not null and nothing', async () => {
    const patches: Partial<Workspace>[] = [];
    const result = await applySwimCloudRows([swimsListParse(['26'])], workspaceWith({ conference: 'GLVC' }), p => void patches.push(p), {
      resolveKeepRecruits: () => true,
    });
    expect(result.scoredProgramBoundary).toMatchObject({ status: 'unknown', reason: 'no-event-pages' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/time trials/i);
    expect(patches[0]?.menResults).toHaveLength(1);
  });

  it('still reports no boundary and no warning when the call converted nothing', async () => {
    const result = await applySwimCloudRows([], workspaceWith(), () => undefined);
    expect(result.scoredProgramBoundary).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('a capture with event pages keeps its own boundary result (no extra warning from the swims list)', async () => {
    const result = await applySwimCloudRows([swimsListParse(['26'])], workspaceWith({ conference: 'NSISC' }), () => undefined, {
      eventResults: [eventPageFor('26')],
      resolveKeepRecruits: () => true,
    });
    expect(result.scoredProgramBoundary).toMatchObject({ status: 'unknown', reason: 'no-program-on-record' });
    expect(result.warnings).toHaveLength(1);
  });
});

describe('mergeSwimCloudResults never downgrades a known swim', () => {
  it('keeps a stored event-page row when a later swims-list row of the same swim arrives', () => {
    const stored = resultRow({ time: '57.50', roundSwam: 'Finals' });
    const incoming = resultRow({ time: '58.00', programSwim: 'unconfirmed' });
    const merged = mergeSwimCloudResults([stored], [incoming]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(stored);
    expect(merged[0]!.programSwim).toBeUndefined();
  });

  it('through applySwimCloudRows: a swims-list re-import leaves the event-page row in the workspace', async () => {
    const eventRows = await runImport([], [eventPageFor('26')]);
    expect(eventRows[0]!.programSwim).toBeUndefined();
    const again = await runImport([swimsListParse(['26'])], [], workspaceWith({ menResults: eventRows }));
    expect(again).toHaveLength(1);
    expect(again[0]!.time).toBe('57.50');
    expect(again[0]!.programSwim).toBeUndefined();
  });

  it('still lets a stored unconfirmed row be refreshed by a newer swims-list row', () => {
    const merged = mergeSwimCloudResults(
      [resultRow({ time: '58.00', programSwim: 'unconfirmed' })],
      [resultRow({ time: '57.90', programSwim: 'unconfirmed' })]
    );
    expect(merged[0]!.time).toBe('57.90');
  });
});
