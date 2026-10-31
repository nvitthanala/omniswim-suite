import { describe, expect, it } from 'vitest';
import { buildIndex, resolveLineup } from '../packages/engine/src/model/results';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { entryKey, type IndividualEntry, type Lineup, type LineupEntry, type RelayLeg } from '../packages/engine/src/model/lineup';
import type { MeetModel, MeetSwim } from '../packages/engine/src/model/meet';
import type { Results, ResultRow } from '../packages/engine/src/model/results';
import type { EventFormat, SessionPreset, SessionRef } from '../packages/engine/src/planner/types';
import { captureReportFacts, diffResults, entryCsv, parseReportFacts, parseResults, ReportDiffError, scoreProgression, swimmerPoints } from '../packages/engine/src/report';

const entries: IndividualEntry[] = [
  { kind: 'individual', teamId: 'A', swimmerId: 's1', eventKey: '50 Freestyle', gender: 'Men', seedSwimId: null },
  { kind: 'individual', teamId: 'A', swimmerId: 's2', eventKey: '50 Freestyle', gender: 'Men', seedSwimId: null },
];
const lineup: Lineup = { payloadVersion: 1, meetKey: 'meet', entries };
const row = (entry: LineupEntry, points: number, place = 1): ResultRow => ({ entryKey: entryKey(entry), teamId: entry.teamId, swimmerId: entry.kind === 'individual' ? entry.swimmerId : null, place, points, scored: points > 0 });
const makeResults = (rows: readonly { entry: LineupEntry; points: number }[], extras: readonly { entryKey: string; eventKey: string; gender: 'Men' | 'Women'; teamId: string; points: number }[] = []): Results => {
  const events = new Map<string, { eventKey: string; gender: 'Men' | 'Women'; rows: ResultRow[] }>();
  for (const { entry, points } of rows) { const key = `${entry.gender}\u0000${entry.eventKey}`; const e = events.get(key) ?? { eventKey: entry.eventKey, gender: entry.gender, rows: [] }; e.rows.push(row(entry, points)); events.set(key, e); }
  for (const x of extras) { const key = `${x.gender}\u0000${x.eventKey}`; const e = events.get(key) ?? { eventKey: x.eventKey, gender: x.gender, rows: [] }; e.rows.push({ entryKey: x.entryKey, teamId: x.teamId, swimmerId: null, place: 1, points: x.points, scored: x.points > 0 }); events.set(key, e); }
  return { payloadVersion: 1, teams: [{ teamId: 'A', points: rows.reduce((n, x) => n + x.points, 0) + extras.filter(x => x.teamId === 'A').reduce((n, x) => n + x.points, 0), rank: 1 }, { teamId: 'B', points: 0, rank: 2 }], events: [...events.values()], violations: [], rosterUnknown: [] };
};
const results = makeResults([{ entry: entries[0]!, points: 4 }, { entry: entries[1]!, points: 0 }]);
const session = (day: number, slot: SessionRef['slot']): SessionRef => ({ day, slot });
const provenance = { kind: 'engine-neutral' as const, reason: 'Test schedule ordering only' };
const set = <T>(value: T) => ({ state: 'set' as const, value, provenance });
const schedule = (...events: { eventKey: string; gender: 'Men' | 'Women' | 'both'; format: EventFormat }[]): SessionPreset => ({ payloadVersion: 1, provenance, events });
const scheduled = (eventKey: string, format: EventFormat, gender: 'Men' | 'Women' | 'both' = 'Men') => ({ eventKey, gender, format });

function seedModel(): { model: MeetModel; lineup: Lineup } {
  const swim = (swimId: string, converted: boolean): MeetSwim => ({ swimId, swimmerId: 's1', eventKey: '50 Freestyle', recordedCourse: converted ? 'LCM' : 'SCY', recordedTime: { text: '22.00', hundredths: 2200 }, date: null, seasonId: null, flags: {}, scy: converted ? { kind: 'converted', hundredths: 2200, basis: { method: 'swimcloud', displayedText: '22.00' }, estimated: true } : { kind: 'recorded-scy' }, origin: { kind: 'simulator', snapshotId: 'snapshot' } });
  const model: MeetModel = { payloadVersion: 1, meetKey: 'meet', teams: [{ teamId: 'A', division: { state: 'unknown', reason: 'unmapped_team' } }], swimmers: [{ swimmerId: 's1', teamId: 'A', gender: 'Men', classYear: 'JR', roster: 'member' }, { swimmerId: 's2', teamId: 'A', gender: 'Men', classYear: null, roster: 'member' }], events: [{ eventKey: '50 Freestyle', gender: 'Men', kind: 'individual', distanceYards: 50, relayKind: null }], swims: [swim('converted', true), swim('recorded', false)], relaySplits: [], recordRange: { kind: 'seasons', seasonIds: ['2025-26'] }, extendedWindow: false, observedScores: null };
  const l: Lineup = { ...lineup, entries: [entries[0]!] };
  return { model, lineup: l };
}

describe('parseResults / parseReportFacts', () => {
  it('rejects malformed Results with the precise path', () => { expect(() => parseResults({ payloadVersion: 1, teams: [] })).toThrow('$.events'); });
  it('rejects malformed report facts with the precise path', () => { expect(() => parseReportFacts({ payloadVersion: 1, seeds: { s: { kind: 'time', hundredths: 'bad', estimated: false } }, classYears: {} })).toThrow('$.seeds.s.hundredths'); });
});

describe('scoreProgression placement and ordering', () => {
  it('places timed finals in their session and prelims-finals in finals', () => {
    const a = entries[0]!; const b: LineupEntry = { ...a, eventKey: '100 Freestyle', swimmerId: 's2' };
    const r = makeResults([{ entry: a, points: 1 }, { entry: b, points: 1 }]);
    const p = scoreProgression(r, schedule(scheduled('50 Freestyle', { kind: 'timed-final', session: session(1, 'morning') }), scheduled('100 Freestyle', { kind: 'prelims-finals', prelims: session(1, 'morning'), finals: session(2, 'evening') })));
    expect(p.points.map(x => x.scoresIn)).toEqual([session(1, 'morning'), session(2, 'evening')]);
  });
  it('places split timed finals in fastHeat or the small-field session at the threshold', () => {
    const ev: EventFormat = { kind: 'timed-final-split', slowHeats: session(1, 'morning'), fastHeat: session(2, 'evening'), fastHeatSize: set(2), smallFieldSession: set(session(1, 'afternoon')) };
    const small = scoreProgression(results, schedule(scheduled('50 Freestyle', ev)));
    expect(small.points[0]?.scoresIn).toEqual(session(1, 'afternoon'));
    const threeEntries = [...entries, { ...entries[0]!, swimmerId: 's3' }];
    const big = scoreProgression(makeResults(threeEntries.map(entry => ({ entry, points: 1 }))), schedule(scheduled('50 Freestyle', ev)));
    expect(big.points[0]?.scoresIn).toEqual(session(2, 'evening'));
  });
  it('leaves pending split settings unplaced and switches the whole chart to simulator order', () => {
    const pending = { state: 'pending' as const, question: 'small field session?', blocks: [] };
    const format: EventFormat = { kind: 'timed-final-split', slowHeats: session(1, 'morning'), fastHeat: session(2, 'evening'), fastHeatSize: set(4), smallFieldSession: pending };
    const p = scoreProgression(results, schedule(scheduled('50 Freestyle', format)));
    expect(p.order).toMatchObject({ kind: 'simulator', reason: 'unplaced', unplaced: [{ eventKey: '50 Freestyle', gender: 'Men', why: 'pending_setting' }] });
    expect(p.points.map(x => x.eventKey)).toEqual(['50 Freestyle']);
  });
  it('marks a pending fastHeatSize unplaced because the split session cannot be chosen', () => {
    const pending = { state: 'pending' as const, question: 'fast heat size?', blocks: [] };
    const format: EventFormat = { kind: 'timed-final-split', slowHeats: session(1, 'morning'), fastHeat: session(2, 'evening'), fastHeatSize: pending, smallFieldSession: set(session(1, 'afternoon')) };
    expect(scoreProgression(results, schedule(scheduled('50 Freestyle', format))).order).toMatchObject({ kind: 'simulator', reason: 'unplaced', unplaced: [{ why: 'pending_setting' }] });
  });
  it('orders by day, morning before afternoon before evening; both expands Men before Women', () => {
    const men: LineupEntry = { ...entries[0]!, eventKey: 'Shared', gender: 'Men' }; const women: LineupEntry = { ...men, gender: 'Women' };
    const dayFirst: LineupEntry = { ...men, eventKey: 'Day first' }; const afternoon: LineupEntry = { ...men, eventKey: 'Afternoon' }; const evening: LineupEntry = { ...men, eventKey: 'Evening' }; const tomorrow: LineupEntry = { ...men, eventKey: 'Tomorrow' };
    const r = makeResults([{ entry: women, points: 1 }, { entry: men, points: 1 }, { entry: dayFirst, points: 1 }, { entry: afternoon, points: 1 }, { entry: evening, points: 1 }, { entry: tomorrow, points: 1 }]);
    const p = scoreProgression(r, schedule(scheduled('Shared', { kind: 'timed-final', session: session(1, 'morning') }, 'both'), scheduled('Evening', { kind: 'timed-final', session: session(1, 'evening') }), scheduled('Day first', { kind: 'timed-final', session: session(1, 'morning') }), scheduled('Afternoon', { kind: 'timed-final', session: session(1, 'afternoon') }), scheduled('Tomorrow', { kind: 'timed-final', session: session(2, 'morning') })));
    expect(p.points.map(x => `${x.eventKey}/${x.gender}`)).toEqual(['Shared/Men', 'Shared/Women', 'Day first/Men', 'Afternoon/Men', 'Evening/Men', 'Tomorrow/Men']);
  });
  it('keeps preset array index ahead of Results.events order for same-session ties', () => {
    const first: LineupEntry = { ...entries[0]!, eventKey: 'Preset first' }; const second: LineupEntry = { ...entries[0]!, eventKey: 'Result first' };
    const r = makeResults([{ entry: second, points: 1 }, { entry: first, points: 1 }]);
    const p = scoreProgression(r, schedule(scheduled('Preset first', { kind: 'timed-final', session: session(1, 'morning') }), scheduled('Result first', { kind: 'timed-final', session: session(1, 'morning') })));
    expect(p.points.map(x => x.eventKey)).toEqual(['Preset first', 'Result first']);
  });
  it('uses simulator order for any unscheduled event, lists it, and preserves all-team final totals', () => {
    const extra: LineupEntry = { ...entries[0]!, eventKey: 'Unscheduled' };
    const r = makeResults([{ entry: entries[0]!, points: 0.1 }, { entry: entries[1]!, points: 0.2 }, { entry: extra, points: 0.3 }]);
    const p = scoreProgression(r, schedule(scheduled('50 Freestyle', { kind: 'timed-final', session: session(9, 'evening') })));
    expect(p.order).toMatchObject({ kind: 'simulator', reason: 'unplaced', unplaced: [{ eventKey: 'Unscheduled', gender: 'Men', why: 'unscheduled' }] });
    expect(p.points.map(x => x.eventKey)).toEqual(r.events.map(x => x.eventKey));
    expect(p.points.at(-1)?.totals.A).toBeCloseTo(r.teams[0]!.points, 9);
    expect(p.points.at(-1)?.totals.B).toBe(r.teams[1]!.points);
  });
  it('returns no_schedule order and exact quarter-point cumulative totals', () => {
    const quarterEntries = [0, 1, 2, 3].map(i => ({ ...entries[0]!, eventKey: `Q${i}`, swimmerId: `s${i}` }));
    const r = makeResults(quarterEntries.map(entry => ({ entry, points: 0.25 })));
    const p = scoreProgression(r, null);
    expect(p.order).toMatchObject({ kind: 'simulator', reason: 'no_schedule' });
    expect(p.points.at(-1)?.totals.A).toBe(1);
    expect(p.points.at(-1)?.totals.B).toBe(0);
  });
  it('uses Results.events order to break ties sharing one preset row', () => {
    const base = results.events[0]!;
    const first = { ...base, rows: [{ ...base.rows[0]!, entryKey: 'result-first', points: 1 }] };
    const second = { ...base, rows: [{ ...base.rows[0]!, entryKey: 'result-second', points: 2 }] };
    const tied: Results = { ...results, teams: [{ teamId: 'A', points: 3, rank: 1 }, { teamId: 'B', points: 0, rank: 2 }], events: [first, second] };
    const p = scoreProgression(tied, schedule(scheduled('50 Freestyle', { kind: 'timed-final', session: session(1, 'morning') })));
    expect(p.points.map(point => point.totals.A)).toEqual([1, 3]);
  });
  it('ends scheduled cumulative totals at the recorded team points within 1e-9', () => {
    const p = scoreProgression(results, schedule(scheduled('50 Freestyle', { kind: 'timed-final', session: session(1, 'morning') })));
    expect(Math.abs(p.points.at(-1)!.totals.A! - results.teams[0]!.points)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(p.points.at(-1)!.totals.B! - results.teams[1]!.points)).toBeLessThanOrEqual(1e-9);
  });
});

describe('swimmerPoints and diffResults', () => {
  it('attributes one quarter per relay leg and swimmer totals reconcile to the team', () => {
    const legs: readonly [RelayLeg, RelayLeg, RelayLeg, RelayLeg] = [{ swimmerId: 'r0', basis: { kind: 'no-time' } }, { swimmerId: 'r1', basis: { kind: 'no-time' } }, { swimmerId: 'r2', basis: { kind: 'no-time' } }, { swimmerId: 'r3', basis: { kind: 'no-time' } }];
    const relay: LineupEntry = { kind: 'relay', teamId: 'A', eventKey: '200 Freestyle Relay', gender: 'Men', letter: 'A', legs };
    const individual = entries[0]!; const r = makeResults([{ entry: individual, points: 2 }, { entry: relay, points: 8 }]);
    const pts = swimmerPoints(r, { ...lineup, entries: [individual, relay] });
    expect(pts.filter(x => x.relayShare > 0).map(x => x.relayShare)).toEqual([2, 2, 2, 2]);
    expect(pts.reduce((sum, x) => sum + x.total, 0)).toBe(r.teams[0]!.points);
  });
  it('marks absent sides without converting them to zero and throws on meet-key mismatch', () => {
    const absent: Lineup = { ...lineup, entries: [] };
    const d = diffResults({ results, lineup: absent }, { results, lineup }, 'A');
    expect(d.totals).toEqual({ then: null, now: 4, delta: null, inThen: false, inNow: true });
    expect(d.events).toHaveLength(1); expect(d.events[0]?.pointsThen).toBeNull();
    expect(() => diffResults({ results, lineup }, { results, lineup: { ...lineup, meetKey: 'another-meet' } }, 'A')).toThrow(ReportDiffError);
    try { diffResults({ results, lineup }, { results, lineup: { ...lineup, meetKey: 'another-meet' } }, 'A'); } catch (error) { expect(error).toMatchObject({ code: 'meet_key_mismatch' }); }
  });
  it('reports per-swimmer event changes and keeps each relay as one diff row', () => {
    const relayLegs: readonly [RelayLeg, RelayLeg, RelayLeg, RelayLeg] = [{ swimmerId: 'r0', basis: { kind: 'no-time' } }, { swimmerId: 'r1', basis: { kind: 'no-time' } }, { swimmerId: 'r2', basis: { kind: 'no-time' } }, { swimmerId: 'r3', basis: { kind: 'no-time' } }];
    const relay: LineupEntry = { kind: 'relay', teamId: 'A', eventKey: '200 Freestyle Relay', gender: 'Men', letter: 'A', legs: relayLegs };
    const oldLineup: Lineup = { ...lineup, entries: [entries[0]!, relay] };
    const newLineup: Lineup = { ...lineup, entries: [entries[1]!, relay] };
    const oldResults = makeResults([{ entry: entries[0]!, points: 3 }, { entry: relay, points: 8 }]);
    const newResults = makeResults([{ entry: entries[1]!, points: 5 }, { entry: relay, points: 12 }]);
    const diff = diffResults({ results: oldResults, lineup: oldLineup }, { results: newResults, lineup: newLineup }, 'A');
    expect(diff.swimmers.filter(swimmer => swimmer.isRelay)).toHaveLength(1);
    expect(diff.swimmers.find(swimmer => swimmer.isRelay)?.pointsNow).toBe(12);
    expect(diff.swimmers.find(swimmer => swimmer.name === 's1')?.eventsRemoved).toEqual(['50 Freestyle']);
    expect(diff.swimmers.find(swimmer => swimmer.name === 's2')?.eventsAdded).toEqual(['50 Freestyle']);
    expect(diff.events.find(event => event.eventKey === '50 Freestyle')).toMatchObject({ pointsThen: 3, pointsNow: 5, swimmersChanged: 2 });
  });
  it('includes per-swimmer time changes in the ScenarioDiffResult-shaped output', () => {
    const entry = entries[0]!;
    const thenLineup: Lineup = { ...lineup, entries: [entry], display: { swimmers: { s1: { name: 'Swimmer One' } }, teams: { A: { name: 'A' } }, entryTimes: { [entryKey(entry)]: { text: '22.00', hundredths: 2200 } } } };
    const nowLineup: Lineup = { ...thenLineup, display: { ...thenLineup.display!, entryTimes: { [entryKey(entry)]: { text: '21.50', hundredths: 2150 } } } };
    const diff = diffResults({ results: makeResults([{ entry, points: 3 }]), lineup: thenLineup }, { results: makeResults([{ entry, points: 4 }]), lineup: nowLineup }, 'A');
    expect(diff).toHaveProperty('totals'); expect(diff).toHaveProperty('events'); expect(diff).toHaveProperty('swimmers');
    expect(diff.swimmers[0]?.eventsChanged).toEqual([{ event: '50 Freestyle', timeThen: '22.00', timeNow: '21.50' }]);
  });
});

describe('captureReportFacts', () => {
  it('captures every seed from resolveLineup and chooses recorded on a recorded/converted tie', () => {
    const { model, lineup: l } = seedModel(); const resolved = resolveLineup(model, l, buildIndex(model)).resolved;
    const facts = captureReportFacts(model, l);
    for (const seed of resolved) { const fact = facts.seeds[seed.key]; expect(fact && 'hundredths' in fact ? fact.hundredths : null).toBe(seed.value); }
    expect(facts.seeds[resolved[0]!.key]).toEqual({ kind: 'time', hundredths: resolved[0]!.value, estimated: false });
  });
  it('matches every config C seed to resolveLineup values', () => {
    const { snapshot } = buildSnapshot('C');
    const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: 'report-config-C', snapshotId: 'test' });
    if (adapted.kind !== 'ready') throw new Error(`config C did not adapt: ${adapted.kind}`);
    const { model, lineup: configLineup } = adapted.adapted;
    const resolved = resolveLineup(model, configLineup, buildIndex(model)).resolved;
    const facts = captureReportFacts(model, configLineup);
    for (const item of resolved) {
      const fact = facts.seeds[item.key];
      expect(fact && 'hundredths' in fact ? fact.hundredths : null).toBe(item.value);
    }
  });
  it('records not_convertible when every unpinned swim for an entry cannot convert', () => {
    const { model, lineup: l } = seedModel();
    const noConversion: MeetModel = {
      ...model,
      swims: model.swims.map(swim => ({ ...swim, scy: { kind: 'not-convertible', reason: 'no_conversion_available' } })),
    };
    const fact = captureReportFacts(noConversion, l).seeds[entryKey(l.entries[0]!)];
    expect(fact).toEqual({ kind: 'none', reason: 'not_convertible' });
  });
});

describe('entryCsv', () => {
  it('writes BOM, CRLF and final CRLF with no sep line; preserves José and 1:52.34', () => {
    const facts = { payloadVersion: 1 as const, seeds: { [entryKey(entries[0]!)]: { kind: 'time' as const, hundredths: 11234, estimated: false }, [entryKey(entries[1]!)]: { kind: 'time' as const, hundredths: 2200, estimated: false } }, classYears: { s1: null, s2: null } };
    const l: Lineup = { ...lineup, display: { swimmers: { s1: { name: `Jos${String.fromCharCode(233)}` }, s2: { name: 'Plain' } }, teams: { A: { name: 'Team A' } }, entryTimes: {} } };
    const csv = entryCsv(l, results, facts, new Map());
    expect(csv.content.charCodeAt(0)).toBe(0xfeff); expect(csv.content.endsWith('\r\n')).toBe(true); expect(csv.content).not.toContain('sep=');
    expect(csv.content).toContain(`Jos` + String.fromCharCode(233)); expect(csv.content).toContain('1:52.34'); expect(csv.content).toContain('\r\n');
  });
  it('quotes quote, comma, CR, LF, and leading or trailing spaces', () => {
    const special = `"comma,CR${String.fromCharCode(13)}LF${String.fromCharCode(10)} leading trailing `;
    const l: Lineup = { ...lineup, display: { swimmers: { s1: { name: special }, s2: { name: 'Plain' } }, teams: { A: { name: ' Team ' } }, entryTimes: {} } };
    const facts = { payloadVersion: 1 as const, seeds: { [entryKey(entries[0]!)]: { kind: 'time' as const, hundredths: 1, estimated: false }, [entryKey(entries[1]!)]: { kind: 'time' as const, hundredths: 2, estimated: false } }, classYears: { s1: null, s2: null } };
    const csv = entryCsv(l, results, facts, new Map()); expect(csv.content).toContain('"""comma,CR'); expect(csv.content).toContain('" Team "'); expect(csv.content).toContain(`${String.fromCharCode(13)}LF${String.fromCharCode(10)} leading trailing "`);
  });
  it('guards dangerous text prefixes but leaves numeric cells unguarded', () => {
    const dangerous = ['=SUM(1)', '+SUM(1)', '-SUM(1)', '@SUM(1)', '\ttext', '\rtext'];
    const es = dangerous.map((_, i) => ({ ...entries[0]!, swimmerId: `d${i}` }));
    const l: Lineup = { ...lineup, entries: es, display: { swimmers: Object.fromEntries(es.map((e, i) => [e.kind === 'individual' ? e.swimmerId : '', { name: dangerous[i]! }])), teams: { A: { name: 'A' } }, entryTimes: {} } };
    const r = makeResults(es.map(entry => ({ entry, points: 1 })));
    const facts = { payloadVersion: 1 as const, seeds: Object.fromEntries(es.map(e => [entryKey(e), { kind: 'time' as const, hundredths: 1, estimated: false }])), classYears: Object.fromEntries(es.map(e => [e.kind === 'individual' ? e.swimmerId : '', null])) };
    const csv = entryCsv(l, r, facts, new Map()); for (const prefix of dangerous) expect(csv.content).toContain(`'${prefix}`); expect(csv.content).toContain(`,1,1${String.fromCharCode(13)}${String.fromCharCode(10)}`);
  });
  it('emits one row per relay leg and divides relay points into swimmer shares that sum to team points', () => {
    const legs: readonly [RelayLeg, RelayLeg, RelayLeg, RelayLeg] = [{ swimmerId: 'r0', basis: { kind: 'no-time' } }, { swimmerId: 'r1', basis: { kind: 'no-time' } }, { swimmerId: 'r2', basis: { kind: 'no-time' } }, { swimmerId: 'r3', basis: { kind: 'no-time' } }];
    const relay: LineupEntry = { kind: 'relay', teamId: 'A', eventKey: '200 Freestyle Relay', gender: 'Men', letter: 'A', legs };
    const r = makeResults([{ entry: relay, points: 8 }]); const facts = { payloadVersion: 1 as const, seeds: { [entryKey(relay)]: { kind: 'time' as const, hundredths: 30000, estimated: false } }, classYears: { r0: null, r1: null, r2: null, r3: null } };
    const l: Lineup = { payloadVersion: 1, meetKey: 'meet', entries: [relay], display: { swimmers: Object.fromEntries([0,1,2,3].map(i => [`r${i}`, { name: `Leg ${i}` }])), teams: { A: { name: 'A' } }, entryTimes: {} } };
    const out = entryCsv(l, r, facts, new Map()); const body = out.content.slice(1).split('\r\n').slice(1,-1); expect(out.count).toBe(4); expect(body).toHaveLength(4); expect(body.reduce((n, line) => n + Number(line.split(',').at(-1)), 0)).toBe(r.teams[0]!.points);
  });
  it('prints a dive score as points instead of as a swimming clock', () => {
    const dive: LineupEntry = { kind: 'individual', teamId: 'A', swimmerId: 'dive1', eventKey: '1m Diving', gender: 'Men', seedSwimId: null };
    const divingResults = makeResults([{ entry: dive, points: 1 }]);
    const diveLineup: Lineup = { payloadVersion: 1, meetKey: 'meet', entries: [dive], display: { swimmers: { dive1: { name: 'Diver' } }, teams: { A: { name: 'A' } }, entryTimes: {} } };
    const facts = { payloadVersion: 1 as const, seeds: { [entryKey(dive)]: { kind: 'score' as const, hundredths: 25000 } }, classYears: { dive1: null } };
    const csv = entryCsv(diveLineup, divingResults, facts, new Map());
    expect(csv.content).toContain('250.00'); expect(csv.content).not.toContain('4:10.00');
  });
  it('reports missing names and result rows instead of substituting ids or blank scores', () => {
    const l: Lineup = { ...lineup, display: { swimmers: {}, teams: { A: { name: 'A' } }, entryTimes: {} } };
    const noRows: Results = { ...results, events: [] };
    const facts = { payloadVersion: 1 as const, seeds: { [entryKey(entries[0]!)]: { kind: 'time' as const, hundredths: 1000, estimated: false }, [entryKey(entries[1]!)]: { kind: 'time' as const, hundredths: 1100, estimated: false } }, classYears: { s1: null, s2: null } };
    const csv = entryCsv(l, noRows, facts, new Map());
    expect(csv.content).toBe('');
    expect(csv.issues.map(issue => issue.kind)).toContain('name_missing');
    expect(csv.issues.map(issue => issue.kind)).toContain('result_missing');
    expect(csv.issues.some(issue => issue.message.includes('SwimCloud display data is unavailable'))).toBe(true);
  });
  it('refuses CSV when seed facts are missing and reports the affected entry', () => {
    const out = entryCsv(lineup, results, { payloadVersion: 1, seeds: {}, classYears: {} }, new Map());
    expect(out.content).toBe(''); expect(out.count).toBe(0); expect(out.issues).toHaveLength(4);
    expect(out.issues.map(issue => issue.kind)).toEqual(['seed_facts_missing', 'name_missing', 'seed_facts_missing', 'name_missing']);
  });
});
