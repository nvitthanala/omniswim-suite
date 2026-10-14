/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Architect re-review 2026-10-13 of ddb838fb (tied relays), findings 1 and 3.
 *
 * ## Finding 1 (HIGH): a projected tied relay got the other relay's key
 *
 * One team's A and B relays on a dead heat (same event, round, place, clock)
 * differ only in the swimmers they name. A projected leg whose swimmers all
 * left names none ('—' x4), and a leg with two of each relay's swimmers shares
 * as many names with A as with B. `narrowToTiedEntry` then returned the whole
 * group and the first row won: B's legs joined A's card, and an override for
 * B landed on A.
 *
 * - (a) Such a leg is `ambiguous`. The relays screen groups it apart and every
 *   writer refuses it with `tied_relay_ambiguous`.
 * - (b) A key saved before the two relays were told apart (the plain
 *   `relayEntryKey`) is rewritten into one override per relay
 *   (`migrateTiedRelayOverrides`) before any reader reads it, and the readers
 *   no longer fall back to it. So a clear on A cannot change B's fill.
 *
 * ## Finding 3 (LOW): history swims of other meets judged by the loaded meet
 *
 * A history swim labelled `Event 45 Men 100 Yard Breaststroke` became a time
 * trial when the loaded meet scored through 42. `HistoricalSwim` records no
 * boundary of its own meet, so the loaded meet's boundary judges only the swims
 * that meet's results gave (their `meetLabel` is the loaded meet's). Any other
 * swim is a time trial by its flag or label only.
 */
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type HistoricalSwim,
  type RelayLegOverride,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { simulateRoster } from '../packages/core/src/lib/utils';
import {
  findRelayLegOverride,
  hasRelayLegOverride,
  migrateTiedRelayOverrides,
  relayOverrideRefusal,
  removeRelayLegOverride,
  resolveRelayEntryForLeg,
  stableRelayEntryKey,
  suggestBestRelayLegFill,
  upsertRelayLegOverride,
} from '../packages/core/src/lib/relayLegMatching';
import {
  historySwimBoundary,
  loadedMeetHistoryLabel,
  relayLegHistoryCandidates,
} from '../packages/core/src/lib/relayLegHistoryCandidates';
import { buildHistoryFromWorkspace } from '../packages/core/src/lib/athleteHistory';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';
import { buildWhatIfProjection } from '../packages/core/src/lib/whatIfProjection';
import {
  buildRelayGroups,
  relayGroupWriteRefusal,
} from '../packages/manager/src/components/indRelayGroupsView';
import { workspaceFixture } from './helpers/typedFixtures';

const TEAM = 'Home';
const EVENT = 'Event 31 Men 4x50 Yard Freestyle Relay';
const CLOCK = '1:21.00';
const LEG = 1;
const VACANT = '—';

const relayLegs = (names: string[], clock = CLOCK): SwimmerResult[] =>
  names.map(
    (name, i) =>
      ({
        id: `${names[0]}-${i}`,
        rank: 2,
        name,
        classYear: 'FR',
        team: TEAM,
        time: clock,
        finalsTime: clock,
        relayTeamTime: clock,
        roundSwam: 'A Final',
        points: 0,
        event: EVENT,
        gender: Gender.MEN,
        isRelay: true,
        relayLegIndex: i,
        relayLegStroke: 'free',
        relayLegSplit: '20.00',
        relayNames: names.map(n => ({ name: n, year: 'FR' })),
      }) as SwimmerResult
  );

const fifty = (name: string, time: string): SwimmerResult =>
  ({
    id: `ind-${name}`,
    rank: 1,
    name,
    classYear: 'FR',
    team: TEAM,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event: 'Event 8 Men 50 Yard Freestyle',
    gender: Gender.MEN,
  }) as SwimmerResult;

const A = ['A1', 'A2', 'A3', 'A4'];
const B = ['B1', 'B2', 'B3', 'B4'];
const tied = [...relayLegs(A), ...relayLegs(B)];
const individuals = [fifty('X1', '20.00'), fifty('Y1', '20.50')];
const results = [...tied, ...individuals];
const aLeg = tied.find(r => r.name === 'A2') as SwimmerResult;
const bLeg = tied.find(r => r.name === 'B2') as SwimmerResult;
const aTemplate = tied.find(r => r.name === 'A1') as SwimmerResult;
const bTemplate = tied.find(r => r.name === 'B1') as SwimmerResult;
const keyA = stableRelayEntryKey(tied, aLeg);
const keyB = stableRelayEntryKey(tied, bLeg);
const plainKey = `${TEAM}|${EVENT}|A Final|2|${CLOCK}`;
const BOTH_LEFT = new Set(['a2', 'b2']);

/** A leg of the B relay as the projection writes it: its leg row with new `relayNames`. */
function projectedBLeg(names: string[], legIndex = 0): SwimmerResult {
  const row = relayLegs(B).find(r => r.relayLegIndex === legIndex) as SwimmerResult;
  return {
    ...row,
    name: names[legIndex] as string,
    time: '1:33.00',
    finalsTime: '1:33.00',
    relayTeamTime: '1:33.00',
    relayNames: names.map(n => ({ name: n, year: n === VACANT ? '' : 'FR' })),
  };
}

describe('a projected leg of a tied relay that names no relay', () => {
  it('every swimmer left: the leg is ambiguous, not the first relay', () => {
    const resolution = resolveRelayEntryForLeg(tied, projectedBLeg([VACANT, VACANT, VACANT, VACANT]));
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') return;
    expect(resolution.candidates.map(c => c.name).sort()).toStrictEqual(['A1', 'B1']);
    expect(resolution.groupKey.startsWith('ambiguous-tied-relay|')).toBe(true);
  });

  it('two swimmers of each relay: as many shared with A as with B, so ambiguous', () => {
    expect(resolveRelayEntryForLeg(tied, projectedBLeg(['B1', 'B2', 'A3', 'A4'])).status).toBe('ambiguous');
  });

  it('a leg that names no swimmers at all is ambiguous', () => {
    const bare = { ...projectedBLeg(B), relayNames: [] } as SwimmerResult;
    expect(resolveRelayEntryForLeg(tied, bare).status).toBe('ambiguous');
  });

  it('three of its own swimmers left: still its own relay', () => {
    const resolution = resolveRelayEntryForLeg(tied, projectedBLeg(['B1', VACANT, 'B3', 'B4']));
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.template.name).toBe('B1');
    expect(resolution.entryKey).toBe(keyB);
    expect(resolution.entryKey).not.toBe(keyA);
  });

  it('a leg that names its relay exactly, and a relay that is not tied, resolve', () => {
    const exact = resolveRelayEntryForLeg(tied, bLeg);
    expect(exact.status === 'resolved' && exact.entryKey).toBe(keyB);
    const onlyA = relayLegs(A);
    const alone = resolveRelayEntryForLeg(onlyA, projectedBLeg([VACANT, VACANT, VACANT, VACANT]));
    expect(alone.status).toBe('resolved');
    const lone = resolveRelayEntryForLeg(onlyA, onlyA[1] as SwimmerResult);
    expect(lone.status === 'resolved' && lone.entryKey).toBe(plainKey);
  });

  it('the refusal carries the reason code, and a resolved relay has none', () => {
    const ambiguous = resolveRelayEntryForLeg(tied, projectedBLeg([VACANT, VACANT, VACANT, VACANT]));
    expect(relayOverrideRefusal(ambiguous)?.reason).toBe('tied_relay_ambiguous');
    expect(relayOverrideRefusal(resolveRelayEntryForLeg(tied, bLeg))).toBeNull();
  });
});

describe('the relays screen groups a projected tied relay by its own key', () => {
  // All four B swimmers leave: the projection writes '—' x4 into B's legs and leaves A's rows as they were.
  const projected = simulateRoster(results, [], false, new Set(['b1', 'b2', 'b3', 'b4']), []);
  const groups = buildRelayGroups({
    allScored: projected,
    originalResults: tied,
    gender: Gender.MEN,
    team: TEAM,
  });

  it('is a real projection: B names nobody, A is unchanged', () => {
    const bRows = projected.filter(r => r.isRelay && r.relayLegIndex === 0 && r.rank === 2 && r.name === VACANT);
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.relayNames?.map(n => n.name)).toStrictEqual([VACANT, VACANT, VACANT, VACANT]);
  });

  it("B's legs do not join A's card", () => {
    const aGroup = groups.find(g => g.key === keyA);
    expect(aGroup?.legs.map(l => l.name).sort()).toStrictEqual(A);
    expect(groups).toHaveLength(2);
    const other = groups.find(g => g.key !== keyA);
    expect(other?.legs).toHaveLength(4);
    expect(other?.legs.every(l => l.name === VACANT)).toBe(true);
  });

  it('refuses every write for the unresolved card and none for the resolved one', () => {
    const aGroup = groups.find(g => g.key === keyA);
    const other = groups.find(g => g.key !== keyA);
    expect(relayGroupWriteRefusal(aGroup as NonNullable<typeof aGroup>)).toBeNull();
    expect(relayGroupWriteRefusal(other as NonNullable<typeof other>)?.reason).toBe('tied_relay_ambiguous');
    // The card key names no stored override, so a write could not land there either.
    expect(other?.key.startsWith('ambiguous-tied-relay|')).toBe(true);
  });
});

describe('the lineup audit offers no quick fill for an ambiguous vacated leg', () => {
  const ws = workspaceFixture({
    id: 'ws',
    name: 'tied',
    createdAt: 0,
    menResults: results,
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    conference: 'NSISC',
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
  });
  const auditOf = (leftNames: string[]) => {
    const projected = simulateRoster(results, [], false, new Set(leftNames.map(n => n.toLowerCase())), []);
    return buildTeamLineupAudit({
      workspace: ws,
      gender: Gender.MEN,
      team: TEAM,
      settings: NSISC_PRESET_SETTINGS,
      allResults: results,
      allScored: projected,
      removeSeniors: false,
      detectDuplicates: false,
    });
  };

  it('a leg of a relay that still names three of its swimmers keeps its entry key', () => {
    const items = auditOf(['B2']).checklistItems.filter(i => i.type === 'relay_needs_fill');
    expect(items.map(i => [i.legIndex, i.relayEntryKey])).toStrictEqual([[LEG, keyB]]);
  });

  it('a relay that names nobody any more is reported with no entry key to fill under', () => {
    const items = auditOf(['B1', 'B2', 'B3', 'B4']).checklistItems.filter(i => i.type === 'relay_needs_fill');
    expect(items.map(i => i.legIndex).sort()).toStrictEqual([0, 1, 2, 3]);
    // The screen reads a missing key as "open the relays screen": no override is written for either relay.
    expect(items.every(i => i.relayEntryKey === undefined)).toBe(true);
  });
});

describe('a key saved before the two relays were told apart', () => {
  const legacy: RelayLegOverride = { relayEntryKey: plainKey, legIndex: LEG, assigneeName: 'X1', source: 'manual' };
  const nameOnLeg = (rows: SwimmerResult[], first: string) =>
    rows.find(r => r.isRelay && r.relayLegIndex === LEG && r.relayNames?.some(n => n.name === first))?.name;

  it('is rewritten into one override per relay, in place, with every field kept', () => {
    const migrated = migrateTiedRelayOverrides([legacy], results);
    expect(migrated.map(o => o.relayEntryKey).sort()).toStrictEqual([keyA, keyB].sort());
    for (const o of migrated) {
      expect(o).toMatchObject({ legIndex: LEG, assigneeName: 'X1', source: 'manual' });
    }
    expect(findRelayLegOverride(migrated, aTemplate, LEG, tied)?.assigneeName).toBe('X1');
    expect(findRelayLegOverride(migrated, bTemplate, LEG, tied)?.assigneeName).toBe('X1');
  });

  it('a core writer (upsert on A) leaves what B reads unchanged', () => {
    const forA: RelayLegOverride = { relayEntryKey: keyA, legIndex: LEG, assigneeName: 'Y1', source: 'manual' };
    const list = upsertRelayLegOverride([legacy], forA);
    expect(list).toContainEqual(legacy);
    const out = simulateRoster(results, [], false, BOTH_LEFT, list);
    expect(nameOnLeg(out, 'A1')).toBe('Y1');
    expect(nameOnLeg(out, 'B1')).toBe('X1');
  });

  it('a clear on A leaves A open and B filled', () => {
    const migrated = migrateTiedRelayOverrides([legacy], results);
    expect(hasRelayLegOverride(migrated, keyA, LEG)).toBe(true);
    const cleared = removeRelayLegOverride(migrated, keyA, LEG);
    expect(hasRelayLegOverride(cleared, keyA, LEG)).toBe(false);
    expect(hasRelayLegOverride(cleared, keyB, LEG)).toBe(true);
    const out = simulateRoster(results, [], false, BOTH_LEFT, cleared);
    expect(nameOnLeg(out, 'A1')).toBe('—');
    expect(nameOnLeg(out, 'B1')).toBe('X1');
  });

  it('the legacy key on a projected tied relay reaches both through the what-if projection', () => {
    const ws = workspaceFixture({
      id: 'ws',
      name: 'tied',
      createdAt: 0,
      menResults: results,
      womenResults: [],
      recruits: [],
      meetEntryPlans: [],
      activeEntryIds: [],
      athleteHistory: [],
      relayLegOverrides: [legacy],
      deletedSwimmers: [
        { name: 'A2', gender: Gender.MEN },
        { name: 'B2', gender: Gender.MEN },
      ],
      conference: 'NSISC',
      scoringSettings: { ...NSISC_PRESET_SETTINGS },
    });
    const rows = buildWhatIfProjection({ workspace: ws, gender: Gender.MEN, removeSeniors: false }).rows;
    const legs = rows.filter(r => r.isRelay === true && r.relayLegIndex === LEG);
    expect(legs.map(r => r.name)).toStrictEqual(['X1', 'X1']);
  });

  it('migration is idempotent and returns the same list when nothing is rewritten', () => {
    const once = migrateTiedRelayOverrides([legacy], results);
    expect(migrateTiedRelayOverrides(once, results)).toBe(once);
    const ownOnly: RelayLegOverride[] = [{ relayEntryKey: keyA, legIndex: LEG, assigneeName: 'Y1', source: 'manual' }];
    expect(migrateTiedRelayOverrides(ownOnly, results)).toBe(ownOnly);
  });

  it("a relay's own override wins, and a second legacy override of one leg is dropped", () => {
    const own: RelayLegOverride = { relayEntryKey: keyB, legIndex: LEG, assigneeName: 'Y1', source: 'manual' };
    const second: RelayLegOverride = { ...legacy, assigneeName: 'Z9' };
    const migrated = migrateTiedRelayOverrides([legacy, own, second], results);
    expect(migrated).toHaveLength(2);
    expect(findRelayLegOverride(migrated, bTemplate, LEG, tied)?.assigneeName).toBe('Y1');
    expect(findRelayLegOverride(migrated, aTemplate, LEG, tied)?.assigneeName).toBe('X1');
  });

  it('the keys of untied relays and of the other gender come back as they were', () => {
    const untied = relayLegs(['U1', 'U2', 'U3', 'U4'], '1:30.00');
    const women = { relayEntryKey: `${TEAM}|Event 32 Women 4x50 Yard Freestyle Relay|A Final|1|1:30.00`, legIndex: 0, assigneeName: 'W1', source: 'manual' } as RelayLegOverride;
    const onUntied: RelayLegOverride = {
      relayEntryKey: `${TEAM}|${EVENT}|A Final|2|1:30.00`,
      legIndex: 0,
      assigneeName: 'U9',
      source: 'manual',
    };
    const list = [women, onUntied];
    expect(migrateTiedRelayOverrides(list, [...results, ...untied])).toBe(list);
    // A legacy key rewritten next to them leaves them in their order and untouched.
    const mixed = migrateTiedRelayOverrides([women, legacy, onUntied], [...results, ...untied]);
    expect(mixed[0]).toBe(women);
    expect(mixed[mixed.length - 1]).toBe(onUntied);
    expect(mixed).toHaveLength(4);
  });

  it('the writer for a tied relay always writes the relay own key', () => {
    const fill = suggestBestRelayLegFill(individuals, bTemplate, LEG, new Set(), new Set(), undefined, tied);
    expect(fill?.override.relayEntryKey).toBe(keyB);
  });
});

describe('a history swim of another meet is not judged by the loaded meet boundary', () => {
  const ZED = 'Zed Rower';
  const MEDLEY = 'Event 20 Men 4x100 Yard Medley Relay';
  const OTHER = 'SE Conference Championships';
  const medleyLegs = ['M1', 'M2', 'M3', 'M4'].map(
    (name, i) =>
      ({
        id: `m-${i}`,
        rank: 1,
        name,
        classYear: 'FR',
        team: TEAM,
        time: '3:30.00',
        finalsTime: '3:30.00',
        relayTeamTime: '3:30.00',
        roundSwam: 'A Final',
        points: 0,
        event: MEDLEY,
        gender: Gender.MEN,
        isRelay: true,
        relayLegIndex: i,
        relayNames: ['M1', 'M2', 'M3', 'M4'].map(n => ({ name: n, year: 'FR' })),
      }) as SwimmerResult
  );
  // Zed has a swim in the meet but none at the breaststroke leg's event, so history may offer one.
  const zedSwim = { ...fifty(ZED, '24.00'), id: 'zed-50' } as SwimmerResult;
  const swim = (over: Partial<HistoricalSwim>): HistoricalSwim => ({
    name: ZED,
    team: TEAM,
    gender: Gender.MEN,
    event: 'Event 45 Men 100 Yard Breaststroke',
    time: '1:00.00',
    timeType: 'SCY',
    source: 'swimcloud',
    meetLabel: OTHER,
    ...over,
  });
  const workspace = (history: HistoricalSwim[], settings = {}): Workspace =>
    workspaceFixture({
      id: 'ws',
      name: 'Loaded Meet',
      createdAt: 0,
      menResults: [...medleyLegs, zedSwim],
      womenResults: [],
      recruits: [],
      meetEntryPlans: [],
      activeEntryIds: [],
      athleteHistory: history,
      relayLegOverrides: [],
      conference: 'NSISC',
      // The loaded meet scored through event 42, on officialTeamScores as a loaded meet keeps it.
      officialTeamScores: { eventThrough: 42, men: {}, women: {} },
      scoringSettings: { ...NSISC_PRESET_SETTINGS, ...settings },
    });
  const breast = (ws: Workspace) =>
    relayLegHistoryCandidates(ws, [zedSwim], Gender.MEN).filter(r => r.event === '100 Breaststroke');

  it('an event numbered past the loaded meet boundary is still a leg swim at another meet', () => {
    expect(breast(workspace([swim({})]))).toHaveLength(1);
  });

  it('the same label from the loaded meet own results is judged by its boundary', () => {
    const ws = workspace([]);
    const own = swim({ meetLabel: loadedMeetHistoryLabel(ws) });
    expect(breast(workspace([own]))).toHaveLength(0);
  });

  it('a flagged time trial of another meet is still a time trial', () => {
    expect(breast(workspace([swim({ isTimeTrial: true })]))).toHaveLength(0);
    expect(breast(workspace([swim({ event: 'Event 45 Men 100 Yard Breaststroke Time Trial' })]))).toHaveLength(0);
  });

  it('a swim that records no meet is judged by its flag and label alone', () => {
    expect(breast(workspace([swim({ meetLabel: undefined })]))).toHaveLength(1);
  });

  it('the boundary rule is the loaded meet label match', () => {
    expect(historySwimBoundary({ meetLabel: 'Loaded Meet' }, 'Loaded Meet', 42)).toBe(42);
    expect(historySwimBoundary({ meetLabel: OTHER }, 'Loaded Meet', 42)).toBeUndefined();
    expect(historySwimBoundary({}, 'Loaded Meet', 42)).toBeUndefined();
    expect(historySwimBoundary({ meetLabel: 'Loaded Meet' }, 'Loaded Meet', undefined)).toBeUndefined();
  });

  it('the label buildHistoryFromWorkspace writes is the label the rule matches', () => {
    const ws = workspace([]);
    expect(buildHistoryFromWorkspace(ws)[0]?.meetLabel).toBe(loadedMeetHistoryLabel(ws));
    const withPdf = { ...ws, loadedMeet: { pdfFilename: 'meet.pdf' } } as unknown as Workspace;
    expect(buildHistoryFromWorkspace(withPdf)[0]?.meetLabel).toBe('meet.pdf');
    expect(loadedMeetHistoryLabel(withPdf)).toBe('meet.pdf');
  });
});
