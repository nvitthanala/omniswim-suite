import { describe, expect, it } from 'vitest';
import { BUILTIN_SESSION_PRESETS, parseSessionPreset, sessionLoad, scoreMeet, entryKey } from '../packages/engine/src/index';
import type { CompleteRulePreset, ConversionSettings, Lineup, LineupEntry, MeetEvent, MeetModel, MeetSwim, RelaySplit, ScorerTag } from '../packages/engine/src/index';
import type { Results } from '../packages/engine/src/model/results';
import type { LoadPreference, SessionPreset } from '../packages/engine/src/planner/types';
import { completeNsisc, set, TEST_PROVENANCE } from './engineTestPresets';

const model = { events: [
  { eventKey: '200 Individual Medley', gender: 'Women', kind: 'individual' },
  { eventKey: '50 Freestyle', gender: 'Women', kind: 'individual' },
  { eventKey: '1000 Freestyle', gender: 'Women', kind: 'individual' },
  { eventKey: '200 Medley Relay', gender: 'Women', kind: 'relay' },
], swimmers: [], teams: [] } as unknown as MeetModel;
const entry = (swimmerId: string, eventKey: string, kind: 'individual' | 'relay' = 'individual') => kind === 'individual'
  ? { kind, teamId: 't', swimmerId, eventKey, gender: 'Women', seedSwimId: null } as const
  : { kind, teamId: 't', eventKey, gender: 'Women', letter: 'A', legs: [1, 2, 3, 4].map(() => ({ swimmerId, basis: { kind: 'no-time' } })) } as unknown as Lineup['entries'][number];
const resultRow = (e: Lineup['entries'][number], place: number, scored = true) => ({
  entryKey: e.kind === 'individual' ? `i|t|${e.swimmerId}|${e.eventKey}|${e.gender}` : `r|t|${e.eventKey}|${e.gender}|${e.letter}`,
  teamId: 't', swimmerId: e.kind === 'individual' ? e.swimmerId : null, place, points: scored ? 1 : 0, scored,
});
const resultsFor = (entries: Lineup['entries'], unscheduled: Results['violations'] = []): Results => ({ payloadVersion: 1, teams: [], rosterUnknown: [], violations: unscheduled, events: [...new Set(entries.map(e => `${e.eventKey}\0${e.gender}`))].map(k => {
  const [eventKey, gender] = k.split('\0');
  const matches = entries.filter(e => e.eventKey === eventKey && e.gender === gender);
  return { eventKey: eventKey!, gender: gender as 'Women', rows: matches.map((e, i) => resultRow(e, i + 1)) };
}) });
const pref: LoadPreference = { mode: 'respect', maxRacesPerSession: { state: 'set', value: 2, provenance: { kind: 'engine-neutral', reason: 'test' } }, diving: { state: 'set', value: 'excluded', provenance: { kind: 'engine-neutral', reason: 'test' } } };
const lineup = (entries: Lineup['entries']): Lineup => ({ payloadVersion: 1, meetKey: 'm', entries });
const emptyModel = model;
const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };

function plannerRules(changes: Partial<CompleteRulePreset['scoring']> = {}): CompleteRulePreset {
  const base = completeNsisc();
  return { ...base, scoring: { ...base.scoring, ...changes } } as CompleteRulePreset;
}

function scoredFixture(eventKey: string, specs: readonly { id: string; time: number | null; convertedValue?: number; role?: 'scorer' | 'non-scorer' }[], rules = plannerRules()) {
  const event: MeetEvent = { eventKey, gender: 'Women', kind: eventKey.includes('Diving') ? 'diving' : 'individual', distanceYards: eventKey.includes('Diving') ? null : 50, relayKind: null };
  const swims: MeetSwim[] = specs.map(s => ({ swimId: `seed-${s.id}`, swimmerId: s.id, eventKey, recordedCourse: 'SCY', recordedTime: s.time === null ? null : { text: `${(s.time / 100).toFixed(2)}`, hundredths: s.time }, date: null, seasonId: null, flags: {}, scy: s.convertedValue === undefined ? { kind: 'recorded-scy' } : { kind: 'converted', hundredths: s.convertedValue, estimated: true, basis: { method: 'lcm_scy_tool_derived', lcmEventKey: eventKey, scyEventKey: eventKey, divisorScaled: 100000, turnHundredths: 0, provenance: TEST_PROVENANCE, appliedTo: 'individual-swim' } }, origin: { kind: 'simulator', snapshotId: 'planner-test' } }));
  const meet: MeetModel = { payloadVersion: 1, meetKey: 'm', teams: [{ teamId: 't', division: { state: 'unknown', reason: 'unmapped_team' } }], swimmers: specs.map(s => ({ swimmerId: s.id, teamId: 't', gender: 'Women', classYear: null, roster: 'member' })), events: [event], swims, relaySplits: [], recordRange: { kind: 'seasons', seasonIds: [] }, extendedWindow: false, observedScores: null };
  const entries: LineupEntry[] = specs.map(s => ({ kind: 'individual', teamId: 't', swimmerId: s.id, eventKey, gender: 'Women', seedSwimId: `seed-${s.id}` }));
  const lu: Lineup = { payloadVersion: 1, meetKey: 'm', entries };
  const tags: ScorerTag[] = specs.map(s => ({ teamId: 't', swimmerId: s.id, role: s.role ?? 'scorer' }));
  return { model: meet, lineup: lu, results: scoreMeet(meet, lu, tags, rules, SOURCING), rules };
}

function pfSchedule(eventKey: string): SessionPreset {
  return { payloadVersion: 1, provenance: BUILTIN_SESSION_PRESETS[0]!.preset.provenance, events: [{ eventKey, gender: 'Women', format: { kind: 'prelims-finals', prelims: { day: 1, slot: 'morning' }, finals: { day: 1, slot: 'evening' } } }] };
}
function runLoad(model: MeetModel, lineup: Lineup, results: Results, schedule: SessionPreset, pref: LoadPreference, rules = plannerRules()) {
  return sessionLoad(model, lineup, results, schedule, pref, rules);
}

function scoredRelayFixture() {
  const event: MeetEvent = { eventKey: '200 Freestyle Relay', gender: 'Women', kind: 'relay', distanceYards: 200, relayKind: 'freestyle' };
  const swimmers = Array.from({ length: 12 }, (_, i) => ({ swimmerId: `r${i}`, teamId: `t${Math.floor(i / 4)}`, gender: 'Women' as const, classYear: null, roster: 'member' as const }));
  const relaySplits: RelaySplit[] = [];
  const entries: LineupEntry[] = [0, 1, 2].map(team => ({
    kind: 'relay', teamId: `t${team}`, eventKey: event.eventKey, gender: 'Women', letter: 'A',
    legs: [0, 1, 2, 3].map(leg => {
      const swimmerId = `r${team * 4 + leg}`;
      const splitId = `sp-${team}-${leg}`;
      relaySplits.push({ splitId, swimmerId, relayEventKey: event.eventKey, legPosition: (leg + 1) as 1 | 2 | 3 | 4, start: 'flying', legEventKey: '50 Freestyle', split: { text: `${(25 + team * 2 + leg / 10).toFixed(2)}`, hundredths: 2500 + team * 200 + leg * 10 }, course: 'SCY', date: null, origin: { kind: 'simulator', snapshotId: 'relay-planner' } });
      return { swimmerId, basis: { kind: 'split' as const, splitId } };
    }) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
  }));
  const teams = [...new Set(swimmers.map(s => s.teamId))].map(teamId => ({ teamId, division: { state: 'unknown' as const, reason: 'unmapped_team' as const } }));
  const meet: MeetModel = { payloadVersion: 1, meetKey: 'm', teams, swimmers, events: [event], swims: [], relaySplits, recordRange: { kind: 'seasons', seasonIds: [] }, extendedWindow: false, observedScores: null };
  const lu: Lineup = { payloadVersion: 1, meetKey: 'm', entries };
  const tags: ScorerTag[] = swimmers.map(s => ({ teamId: s.teamId, swimmerId: s.swimmerId, role: 'scorer' }));
  const rules = plannerRules({ individualPoints: set([20]), relayPoints: set({ kind: 'table', points: [40, 30] }), abFinalsScorersOnly: set(false), cFinal: set({ kind: 'none' }) });
  return { meet, lu, rules, results: scoreMeet(meet, lu, tags, rules, SOURCING) };
}

describe('planner', () => {
  it('uses scoreMeet entry keys when assigning finals', () => {
    const fx = scoredFixture('50 Freestyle', [{ id: 'a', time: 2000 }]);
    expect(fx.results.events[0]!.rows[0]!.entryKey).toBe(entryKey(fx.lineup.entries[0]!));
    const load = sessionLoad(fx.model, fx.lineup, fx.results, pfSchedule('50 Freestyle'), { mode: 'off' }, fx.rules);
    expect(load.perSwimmer[0]?.sessions).toHaveLength(2);
    expect(load.perSwimmer[0]?.sessions[1]?.session.slot).toBe('evening');
  });

  it('ranks split heats from every seeded entry, including removed non-scorers', () => {
    const specs = [{ id: 'ns', time: 18000, role: 'non-scorer' as const }, ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, time: 20000 + i * 1000 }))];
    const rules = plannerRules({ nonScorerPlacement: set('removed-from-consideration') });
    const fx = scoredFixture('1000 Freestyle', specs, rules);
    expect(fx.results.events[0]!.rows.find(r => r.swimmerId === 'ns')?.place).toBeNull();
    const preset = BUILTIN_SESSION_PRESETS[0]!.preset;
    const load = sessionLoad(fx.model, fx.lineup, fx.results, preset, { mode: 'off' }, fx.rules);
    expect(load.perSwimmer.find(s => s.swimmerId === 'ns')?.sessions[0]?.session.slot).toBe('evening');
    expect(load.perSwimmer.find(s => s.swimmerId === 's7')?.sessions[0]?.session.slot).toBe('morning');
  });

  it('uses scoreMeet resolution values to seed converted swims in split heats', () => {
    const specs = [
      { id: 'converted-fast', time: 30000, convertedValue: 18000 },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, time: 19000 + i * 1000 })),
    ];
    const fx = scoredFixture('1000 Freestyle', specs);
    expect(fx.results.events[0]!.rows.find(r => r.swimmerId === 'converted-fast')?.place).toBe(1);
    const load = sessionLoad(fx.model, fx.lineup, fx.results, BUILTIN_SESSION_PRESETS[0]!.preset, { mode: 'off' }, fx.rules);
    expect(load.perSwimmer.find(s => s.swimmerId === 'converted-fast')?.sessions[0]?.session.slot).toBe('evening');
    expect(load.perSwimmer.find(s => s.swimmerId === 's7')?.sessions[0]?.session.slot).toBe('morning');
  });

  it('does not assign a split heat to an entry with no seed time', () => {
    const specs = [...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, time: 20000 + i * 1000 })), { id: 'nt', time: null }];
    const fx = scoredFixture('1000 Freestyle', specs);
    const load = sessionLoad(fx.model, fx.lineup, fx.results, BUILTIN_SESSION_PRESETS[0]!.preset, { mode: 'off' }, fx.rules);
    expect(load.perSwimmer.some(s => s.swimmerId === 'nt')).toBe(false);
    expect(load.violations).toContainEqual(expect.objectContaining({ kind: 'seed_time_missing', entryKey: entryKey(fx.lineup.entries[8]!) }));
  });

  it('reports pending finals and diving settings without counting undecidable finals or dives', () => {
    const fx = scoredFixture('50 Freestyle', [{ id: 'a', time: 2000 }]);
    const pendingAb = plannerRules({ abFinalsScorersOnly: { state: 'pending', question: 'unknown', blocks: ['sessionLoad'] } });
    const ab = sessionLoad(fx.model, fx.lineup, fx.results, pfSchedule('50 Freestyle'), { mode: 'off' }, pendingAb);
    expect(ab.perSwimmer[0]?.sessions.map(s => s.session.slot)).toEqual(['morning']);
    expect(ab.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'abFinalsScorersOnly' }));
    const pendingPoints = plannerRules({ individualPoints: { state: 'pending', question: 'unknown', blocks: ['sessionLoad'] } });
    const points = sessionLoad(fx.model, fx.lineup, fx.results, pfSchedule('50 Freestyle'), { mode: 'off' }, pendingPoints);
    expect(points.perSwimmer[0]?.sessions.map(s => s.session.slot)).toEqual(['morning']);
    expect(points.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'individualPoints' }));
    const dive = scoredFixture('1-Meter Diving', [{ id: 'd', time: 4500 }]);
    const divePref: LoadPreference = { mode: 'respect', maxRacesPerSession: set(2), diving: { state: 'pending', question: 'unknown', blocks: ['sessionLoad'] } };
    const diving = sessionLoad(dive.model, dive.lineup, dive.results, pfSchedule('1-Meter Diving'), divePref, dive.rules);
    expect(diving.perSwimmer).toEqual([]);
    expect(diving.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'diving' }));
    const pendingDivePoints = plannerRules({ divingPoints: { state: 'pending', question: 'unknown', blocks: ['sessionLoad'] } });
    const diveFinals = sessionLoad(dive.model, dive.lineup, dive.results, pfSchedule('1-Meter Diving'), { mode: 'off' }, pendingDivePoints);
    expect(diveFinals.perSwimmer[0]?.sessions.map(s => s.session.slot)).toEqual(['morning']);
    expect(diveFinals.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'diving' }));
    const absentRules = sessionLoad(fx.model, fx.lineup, fx.results, pfSchedule('50 Freestyle'), { mode: 'off' }, undefined as never);
    expect(absentRules.perSwimmer[0]?.sessions.map(s => s.session.slot)).toEqual(['morning']);
    expect(absentRules.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'abFinalsScorersOnly' }));
  });

  it('uses the relay point table for a relay final cutoff', () => {
    const fx = scoredRelayFixture();
    const load = sessionLoad(fx.meet, fx.lu, fx.results, pfSchedule('200 Freestyle Relay'), { mode: 'off' }, fx.rules);
    for (const entry of fx.lu.entries) {
      const swimmer = (entry as Extract<LineupEntry, { kind: 'relay' }>).legs[0].swimmerId;
      const sessions = load.perSwimmer.find(s => s.swimmerId === swimmer)?.sessions.map(s => s.session.slot) ?? [];
      const place = fx.results.events[0]!.rows.find(r => r.entryKey === entryKey(entry))!.place!;
      expect(sessions).toContain('morning');
      expect(sessions.includes('evening')).toBe(place <= 2);
    }
  });

  it('keeps relay finals pending when the relay point table is pending', () => {
    const fx = scoredRelayFixture();
    const pendingRelay = plannerRules({ relayPoints: { state: 'pending', question: 'unknown', blocks: ['sessionLoad'] } });
    const load = sessionLoad(fx.meet, fx.lu, fx.results, pfSchedule('200 Freestyle Relay'), { mode: 'off' }, pendingRelay);
    expect(load.perSwimmer.every(s => s.sessions.length === 1 && s.sessions[0]?.session.slot === 'morning')).toBe(true);
    expect(load.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'relayPoints' }));
  });

  it.each(['holds-place', 'removed-from-consideration'] as const)('ranks scorer-only finalists under %s non-scorer placement', treatment => {
    const rules = plannerRules({ individualPoints: set([9]), abFinalsScorersOnly: set(true), nonScorerPlacement: set(treatment), cFinal: set({ kind: 'none' }) });
    const fx = scoredFixture('50 Freestyle', [{ id: 'n', time: 1800, role: 'non-scorer' }, { id: 's', time: 2000 }], rules);
    const load = sessionLoad(fx.model, fx.lineup, fx.results, pfSchedule('50 Freestyle'), { mode: 'off' }, rules);
    expect(fx.results.events[0]!.rows.find(r => r.swimmerId === 's')?.place).toBe(treatment === 'holds-place' ? 2 : 1);
    expect(load.perSwimmer.find(s => s.swimmerId === 's')?.sessions.map(s => s.session.slot)).toContain('evening');
  });

  it('uses the diving point table length when selecting diving finalists', () => {
    const rules = plannerRules({ individualPoints: set([9, 4, 3]), divingPoints: set({ kind: 'table', points: [5] }), abFinalsScorersOnly: set(false), cFinal: set({ kind: 'none' }) });
    const fx = scoredFixture('1-Meter Diving', [{ id: 'd1', time: 5000 }, { id: 'd2', time: 4500 }], rules);
    const load = sessionLoad(fx.model, fx.lineup, fx.results, pfSchedule('1-Meter Diving'), { mode: 'off' }, rules);
    expect(load.perSwimmer.find(s => s.swimmerId === 'd1')?.sessions.map(s => s.session.slot)).toEqual(['morning', 'evening']);
    expect(load.perSwimmer.find(s => s.swimmerId === 'd2')?.sessions.map(s => s.session.slot)).toEqual(['morning']);
  });

  it('accounts for the NSISC day 2 load, including relay finals; dropping one clears the preference violation', () => {
    const preset = BUILTIN_SESSION_PRESETS[0]!.preset;
    const entries = [entry('s', '200 Individual Medley'), entry('s', '50 Freestyle'), entry('s', '200 Medley Relay', 'relay')];
    const load = runLoad(emptyModel, lineup(entries), resultsFor(entries), preset, pref);
    expect(load.violations).toContainEqual(expect.objectContaining({ kind: 'session_load', swimmerId: 's', races: 3, limit: 2 }));
    const fewer = entries.slice(1);
    expect(runLoad(emptyModel, lineup(fewer), resultsFor(fewer), preset, pref).violations.some(v => v.kind === 'session_load')).toBe(false);
  });

  it('moves a split 1000 to one heat session, and a prelims-finals switch adds prelims plus finalist races', () => {
    const base = BUILTIN_SESSION_PRESETS[0]!.preset;
    const distance = base.events.find(e => e.eventKey === '1000 Freestyle')!;
    const rules = plannerRules({ individualPoints: set([20, 17, 15, 13, 11, 9, 7, 5]), abFinalsScorersOnly: set(false), cFinal: set({ kind: 'none' }) });
    const specs = ['fast', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'slow'].map((id, i) => ({ id, time: 18000 + i * 1000 }));
    const fx = scoredFixture('1000 Freestyle', specs, rules);
    const split = sessionLoad(fx.model, fx.lineup, fx.results, base, { mode: 'off' }, rules);
    expect(split.perSwimmer.find(x => x.swimmerId === 'fast')?.sessions).toEqual([{ session: { day: 2, slot: 'evening' }, races: 1, eventKeys: ['1000 Freestyle'] }]);
    const switched = { ...distance, format: { kind: 'prelims-finals', prelims: { day: 2, slot: 'morning' }, finals: { day: 2, slot: 'evening' } } } as const;
    const changed: SessionPreset = { ...base, events: base.events.map(e => e === distance ? switched : e) };
    const pf = sessionLoad(fx.model, fx.lineup, fx.results, changed, { mode: 'off' }, rules);
    expect(pf.perSwimmer.find(x => x.swimmerId === 'slow')?.sessions).toHaveLength(1);
    expect(pf.perSwimmer.find(x => x.swimmerId === 'fast')?.sessions).toHaveLength(2);
    expect(sessionLoad(fx.model, fx.lineup, fx.results, base, { mode: 'off' }, rules).perSwimmer).toEqual(split.perSwimmer);
  });

  it('rejects duplicate both/gender keys and finals that do not follow prelims', () => {
    const base = BUILTIN_SESSION_PRESETS[0]!.preset;
    expect(() => parseSessionPreset({ ...base, events: [...base.events, { ...base.events[1]!, gender: 'Women' }] })).toThrow(/duplicate schedule key/);
    const row = base.events[1]!;
    expect(() => parseSessionPreset({ ...base, events: [{ ...row, format: { kind: 'prelims-finals', prelims: { day: 2, slot: 'evening' }, finals: { day: 2, slot: 'morning' } } }] })).toThrow(/strictly after/);
  });

  it('counts C-final swimmers only when the configured cutoff includes them, and leaves pending settings pending', () => {
    const base = BUILTIN_SESSION_PRESETS[0]!.preset;
    const cFinalRules = plannerRules({ cFinal: set({ kind: 'non-scorers', size: 1 }) });
    const fx = scoredFixture('200 Individual Medley', [{ id: 'scorer', time: 1900 }, { id: 'n1', time: 2000, role: 'non-scorer' }, { id: 'n2', time: 2100, role: 'non-scorer' }], cFinalRules);
    const counted = sessionLoad(fx.model, fx.lineup, fx.results, base, { mode: 'off' }, cFinalRules);
    expect(counted.perSwimmer.find(x => x.swimmerId === 'n1')?.sessions.some(s => s.session.slot === 'evening')).toBe(true);
    expect(counted.perSwimmer.find(x => x.swimmerId === 'n2')?.sessions.some(s => s.session.slot === 'evening')).toBe(false);
    const pendingC = plannerRules({ cFinal: { state: 'pending', question: 'unknown', blocks: ['sessionLoad'] } });
    expect(sessionLoad(fx.model, fx.lineup, fx.results, base, { mode: 'off' }, pendingC).violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'cFinal' }));
  });

  it('moves a regular prelims-finals event to one timed-final race when edited', () => {
    const base = BUILTIN_SESSION_PRESETS[0]!.preset;
    const row = base.events.find(e => e.eventKey === '50 Freestyle')!;
    const swimmer = entry('s', '50 Freestyle');
    const changed: SessionPreset = { ...base, events: base.events.map(e => e === row ? { ...e, format: { kind: 'timed-final', session: { day: 2, slot: 'evening' } } } : e) };
    const load = runLoad(model, lineup([swimmer]), resultsFor([swimmer]), changed, { mode: 'off' });
    expect(load.perSwimmer[0]?.sessions).toEqual([{ session: { day: 2, slot: 'evening' }, races: 1, eventKeys: ['50 Freestyle'] }]);
  });

  it('surfaces pending split settings without assigning a heat session', () => {
    const preset = BUILTIN_SESSION_PRESETS[0]!.preset;
    const split = preset.events.find(e => e.eventKey === '1000 Freestyle')!;
    const entries = [entry('s', '1000 Freestyle')];
    const pendingSize: SessionPreset = { ...preset, events: preset.events.map(e => e === split ? { ...e, format: { ...e.format, fastHeatSize: { state: 'pending', question: 'unknown', blocks: ['sessionLoad'] } } } as typeof e : e) };
    const load = runLoad(model, lineup(entries), resultsFor(entries), pendingSize, { mode: 'off' });
    expect(load.perSwimmer).toEqual([]);
    expect(load.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'fastHeatSize', eventKey: '1000 Freestyle' }));
    const unresolvedSmallField = runLoad(model, lineup(entries), resultsFor(entries), preset, { mode: 'off' });
    expect(unresolvedSmallField.perSwimmer).toEqual([]);
    expect(unresolvedSmallField.violations).toContainEqual(expect.objectContaining({ kind: 'pending_setting', setting: 'smallFieldSession', eventKey: '1000 Freestyle' }));
  });

  it('applies the diving preference to diving entries', () => {
    const diveModel = { ...model, events: [...model.events, { eventKey: '1-Meter Diving', gender: 'Women', kind: 'diving' }] } as MeetModel;
    const dive = entry('diver', '1-Meter Diving');
    const schedule: SessionPreset = { payloadVersion: 1, provenance: BUILTIN_SESSION_PRESETS[0]!.preset.provenance, events: [{ eventKey: '1-Meter Diving', gender: 'Women', format: { kind: 'timed-final', session: { day: 2, slot: 'evening' } } }] };
    const load = runLoad(diveModel, lineup([dive]), resultsFor([dive]), schedule, pref);
    expect(load.perSwimmer).toEqual([]);
    const counts: LoadPreference = { ...pref, diving: { state: 'set', value: 'counts', provenance: { kind: 'engine-neutral', reason: 'test' } } };
    expect(runLoad(diveModel, lineup([dive]), resultsFor([dive]), schedule, counts).perSwimmer[0]?.sessions[0]?.races).toBe(1);
  });

  it('reports extra-race penalty in prefer mode, excludes diving, and reports unscheduled entries', () => {
    const entries = [entry('s', '200 Individual Medley'), entry('s', '50 Freestyle'), entry('s', '200 Medley Relay', 'relay')];
    const prefer: LoadPreference = { ...pref, mode: 'prefer', penaltyPointsPerExtraRace: { state: 'set', value: 4, provenance: { kind: 'engine-neutral', reason: 'test' } } };
    const schedule = BUILTIN_SESSION_PRESETS[0]!.preset;
    const load = runLoad(emptyModel, lineup(entries), resultsFor(entries), schedule, prefer);
    expect(load.penaltyPoints).toBe(4);
    expect(load.violations.some(v => v.kind === 'session_load')).toBe(true);
    const missing = entry('s', 'Unknown Event');
    expect(runLoad(emptyModel, lineup([missing]), resultsFor([missing]), schedule, { mode: 'off' }).violations).toContainEqual({ kind: 'unscheduled_event', eventKey: 'Unknown Event', gender: 'Women' });
  });
});
