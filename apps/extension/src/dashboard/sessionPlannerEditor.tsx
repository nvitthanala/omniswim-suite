import * as React from 'react';
import { parseSessionPreset } from '@omniswim/engine';
import type { EventFormat, LoadPreference, SessionPreset, SessionRef, SessionSlot } from '@omniswim/engine';
import type { SimSnapshot } from '../shared/bridgeSchema';
import type { PresetRef } from '../storage/schema';
import type { StorageRepo } from '../storage/repo';
import { listSessionPresetChoices, readSessionLoadPreference, readSessionPreset, saveEditedSessionPreset, saveSessionLoadPreference, saveSessionPresetChoice } from '../storage';
import { defaultLoadPreference, pendingPenaltyPreference, userPreference } from '../storage/sessionPreference';
import { rescoreSimulator } from '@omniswim/swimcloud/browser';

const slots: SessionSlot[] = ['morning', 'afternoon', 'evening'];
const refKey = (r: PresetRef): string => JSON.stringify(r);
const meetKeyForSnapshot = (snapshot: SimSnapshot): string => `swimcloud-simulator:${JSON.stringify({ teams: [...new Set(snapshot.teams.map(t => String(t.id)))].sort(), startDate: snapshot.settings.startDate, endDate: snapshot.settings.endDate })}`;
const blankFormat = (): EventFormat => ({ kind: 'timed-final', session: { day: 1, slot: 'morning' } });
function changeMode(current: LoadPreference, mode: LoadPreference['mode']): LoadPreference {
  if (mode === 'off') return { mode: 'off' };
  let base: Exclude<LoadPreference, { mode: 'off' }>;
  if (current.mode === 'off') base = defaultLoadPreference(); else base = current;
  return mode === 'prefer' ? { mode, maxRacesPerSession: base.maxRacesPerSession, diving: base.diving, penaltyPointsPerExtraRace: current.mode === 'prefer' ? current.penaltyPointsPerExtraRace : pendingPenaltyPreference() }
    : { mode, maxRacesPerSession: base.maxRacesPerSession, diving: base.diving };
}

export function SessionPlannerEditor({ snapshot, repoForMeet }: { snapshot: SimSnapshot; repoForMeet: () => Promise<StorageRepo> }) {
  const meetKey = meetKeyForSnapshot(snapshot);
  const [choices, setChoices] = React.useState<Awaited<ReturnType<typeof listSessionPresetChoices>>>([]);
  const [ref, setRef] = React.useState<PresetRef>();
  const [preset, setPreset] = React.useState<SessionPreset>();
  const [preference, setPreference] = React.useState<LoadPreference>(defaultLoadPreference());
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState('');
  const availableEvents = React.useMemo(() => {
    const result = rescoreSimulator(snapshot, { meetKey, snapshotId: 'planner-editor' });
    return result.kind === 'scored' || result.kind === 'preset_incomplete' ? result.adapted.model.events : [];
  }, [snapshot, meetKey]);
  React.useEffect(() => {
    let active = true;
    void repoForMeet().then(async repo => {
      const [rows, selected, pref] = await Promise.all([listSessionPresetChoices(repo), readSessionPreset(repo, meetKey), readSessionLoadPreference(repo, meetKey)]);
      if (!active) return;
      setChoices(rows); setRef(selected.ref); setPreset(selected.preset); setPreference(pref);
    }).catch(e => active && setError(e instanceof Error ? e.message : String(e)));
    return () => { active = false; };
  }, [meetKey, repoForMeet]);
  const selectPreset = async (value: string) => {
    const choice = choices.find(c => refKey(c.ref) === value);
    if (!choice) { setRef(undefined); setPreset(undefined); return; }
    try { const repo = await repoForMeet(); await saveSessionPresetChoice(repo, meetKey, choice.ref); const selected = await readSessionPreset(repo, meetKey); setRef(selected.ref); setPreset(selected.preset); setError(''); setSaved('Session preset choice saved.'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const updateEvent = (index: number, update: Partial<SessionPreset['events'][number]>) => setPreset(current => current && ({ ...current, events: current.events.map((event, i) => i === index ? { ...event, ...update } : event) }));
  const updateFormat = (index: number, format: EventFormat) => updateEvent(index, { format });
  const moveEvent = (index: number, delta: -1 | 1) => setPreset(current => {
    if (!current) return current;
    const target = index + delta; if (target < 0 || target >= current.events.length) return current;
    const events = [...current.events]; [events[index], events[target]] = [events[target]!, events[index]!];
    return { ...current, events };
  });
  const savePreset = async () => {
    if (!preset || !ref) return;
    try {
      const validated = parseSessionPreset(preset);
      const repo = await repoForMeet(); const next = await saveEditedSessionPreset(repo, meetKey, ref, validated);
      const selected = await readSessionPreset(repo, meetKey); setRef(next); setPreset(selected.preset); setChoices(await listSessionPresetChoices(repo)); setError(''); setSaved('Schedule saved.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSaved(''); }
  };
  const savePreference = async (next: LoadPreference) => {
    setPreference(next);
    try { await saveSessionLoadPreference(await repoForMeet(), meetKey, next); setError(''); setSaved('Load preference saved.'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const sessionControls = (format: EventFormat, change: (f: EventFormat) => void) => {
    const keys = format.kind === 'timed-final' ? ['session'] : format.kind === 'prelims-finals' ? ['prelims', 'finals'] : ['slowHeats', 'fastHeat'];
    return <>{keys.map(key => {
      const value = (format as unknown as Record<string, unknown>)[key] as SessionRef;
      const set = (part: Partial<SessionRef>) => change({ ...format, [key]: { ...value, ...part } } as EventFormat);
      return <label key={key}>{key} day <input aria-label={`${key} day`} type="number" min="1" value={value.day} onChange={e => set({ day: Number(e.target.value) })} /> <select aria-label={`${key} slot`} value={value.slot} onChange={e => set({ slot: e.target.value as SessionSlot })}>{slots.map(slot => <option key={slot}>{slot}</option>)}</select></label>;
    })}{format.kind === 'timed-final-split' && <><label>Fast heat size <input aria-label="Fast heat size" type="number" min="1" value={format.fastHeatSize.state === 'set' ? format.fastHeatSize.value : ''} onChange={e => change({ ...format, fastHeatSize: userPreference(Number(e.target.value)) })} /></label><label>Small field day <input aria-label="Small field day" type="number" min="1" value={format.smallFieldSession.state === 'set' ? format.smallFieldSession.value.day : ''} onChange={e => change({ ...format, smallFieldSession: userPreference({ day: Number(e.target.value), slot: format.smallFieldSession.state === 'set' ? format.smallFieldSession.value.slot : 'morning' }) })} /></label><label>Small field slot <select aria-label="Small field slot" value={format.smallFieldSession.state === 'set' ? format.smallFieldSession.value.slot : ''} onChange={e => change({ ...format, smallFieldSession: userPreference({ day: format.smallFieldSession.state === 'set' ? format.smallFieldSession.value.day : 1, slot: e.target.value as SessionSlot }) })}><option value="">Pending</option>{slots.map(slot => <option key={slot}>{slot}</option>)}</select></label></>}</>;
  };
  return <section className="osx-results" data-testid="session-planner-editor"><h2>Meet schedule and athlete load</h2>
    <label>Session preset <select aria-label="Choose session preset" value={ref ? refKey(ref) : ''} onChange={e => void selectPreset(e.target.value)}><option value="">Choose a session preset</option>{choices.map(c => <option key={refKey(c.ref)} value={refKey(c.ref)}>{c.label}</option>)}</select></label>
    {preset && <><ol>{preset.events.map((event, index) => <li key={`${event.eventKey}-${event.gender}-${index}`}><strong>{event.eventKey} ({event.gender})</strong> <button type="button" onClick={() => moveEvent(index, -1)} disabled={index === 0}>Move up</button> <button type="button" onClick={() => moveEvent(index, 1)} disabled={index === preset.events.length - 1}>Move down</button> <button type="button" onClick={() => setPreset(p => p && ({ ...p, events: p.events.filter((_, i) => i !== index) }))}>Remove event</button>
      <label>Event <select aria-label={`Event ${index + 1}`} value={event.eventKey} onChange={e => updateEvent(index, { eventKey: e.target.value as typeof event.eventKey })}>{availableEvents.map(row => <option key={row.eventKey} value={row.eventKey}>{row.eventKey}</option>)}</select></label>
      <label>Gender <select value={event.gender} onChange={e => updateEvent(index, { gender: e.target.value as typeof event.gender })}><option>both</option><option>Men</option><option>Women</option></select></label>
      <label>Format <select aria-label={`Format ${index + 1}`} value={event.format.kind} onChange={e => { const day = 1; const f = e.target.value === 'timed-final' ? { kind: 'timed-final', session: { day, slot: 'morning' } } as EventFormat : e.target.value === 'prelims-finals' ? { kind: 'prelims-finals', prelims: { day, slot: 'morning' }, finals: { day, slot: 'evening' } } as EventFormat : { kind: 'timed-final-split', slowHeats: { day, slot: 'morning' }, fastHeat: { day, slot: 'evening' }, fastHeatSize: { state: 'pending', question: 'Set fast heat size.', blocks: ['sessionLoad'] }, smallFieldSession: { state: 'pending', question: 'Set small field session.', blocks: ['sessionLoad'] } } as EventFormat; updateFormat(index, f); }}>{['timed-final', 'prelims-finals', 'timed-final-split'].map(k => <option key={k} value={k}>{k}</option>)}</select></label>
      {sessionControls(event.format, f => updateFormat(index, f))}</li>)}</ol>
      <label>Add event <select aria-label="Add event" defaultValue="" onChange={e => { const row = availableEvents.find(x => x.eventKey === e.target.value); if (row) setPreset(p => p && ({ ...p, events: [...p.events, { eventKey: row.eventKey, gender: row.gender, format: blankFormat() }] })); e.target.value = ''; }}><option value="">Choose an event</option>{availableEvents.map(row => <option key={`${row.eventKey}-${row.gender}`} value={row.eventKey}>{row.eventKey} ({row.gender})</option>)}</select></label>
      <button type="button" onClick={() => void savePreset()}>Save schedule</button></>}
    <fieldset><legend>Load preference</legend><label>Mode <select value={preference.mode} onChange={e => void savePreference(changeMode(preference, e.target.value as LoadPreference['mode']))}> {['respect','prefer','off'].map(x => <option key={x}>{x}</option>)}</select></label>{preference.mode !== 'off' && <><label>Max races per session <input type="number" min="1" value={preference.maxRacesPerSession.state === 'set' ? preference.maxRacesPerSession.value : ''} onChange={e => void savePreference({ ...preference, maxRacesPerSession: userPreference(Number(e.target.value)) })} /></label><label>Diving <select value={preference.diving.state === 'set' ? preference.diving.value : ''} onChange={e => void savePreference({ ...preference, diving: userPreference(e.target.value as 'counts'|'excluded') })}><option value="">Pending</option><option value="counts">Counts</option><option value="excluded">Excluded</option></select></label>{preference.mode === 'prefer' && <label>Penalty per extra race <input type="number" min="0" value={preference.penaltyPointsPerExtraRace.state === 'set' ? preference.penaltyPointsPerExtraRace.value : ''} onChange={e => void savePreference({ ...preference, penaltyPointsPerExtraRace: userPreference(Number(e.target.value)) })} /></label>}</>}</fieldset>
    {error && <p role="alert" data-testid="planner-error">{error}</p>}{saved && <p aria-live="polite">{saved}</p>}
  </section>;
}
