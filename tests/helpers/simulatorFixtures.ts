/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared builders for the sanitized simulator fixtures in `tests/fixtures/swimcloud/simulator/`
 * (see the README there). Two tests read them: `extensionBridge.test.ts` (the store the bridge
 * reads) and the simulator parity tests (the snapshot the adapter reads).
 *
 * The fixtures keep swim rows as positional arrays. `inflateRoster` turns them into the object
 * shape the live page holds. `inflateSplashes` turns a config's `results` into the page's chosen
 * entries. The fixtures themselves are never edited.
 *
 * Relay legs. The fixture records each relay entry as four swimmer ids and the relay time, with no
 * per-leg time. The live page does hold one. Its aggregate-relay builder (`kf` in the archived
 * bundle `simulator.1792676876.js`, offset about 525700, sha256 93f6be65...69c6da) copies a swim row
 * into each leg splash: the leg's stroke and distance, `flystart`, and `eventtime`. `pageLegs`
 * rebuilds those leg rows by the page's own rule: leg 1 is the fastest individual or leadoff row
 * (flystart false), legs 2 to 4 are the fastest relay split (flystart true), and a free relay is
 * reordered afterwards, so the flat-start swimmer can sit at any position. `pageLegs` demands that
 * the four leg times sum to the relay time the fixture recorded, and that exactly one position
 * explains it. A relay that no position explains throws; nothing is fitted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { simSnapshotSchema } from '../../apps/extension/src/shared/bridgeSchema';
import type { SimSnapshot } from '../../apps/extension/src/shared/bridgeSchema';

export type Obj = Record<string, unknown>;
export type ConfigName = 'A' | 'B' | 'C' | 'D';

export const FIXTURES = path.join(__dirname, '..', 'fixtures', 'swimcloud', 'simulator');
export const fixture = (name: string): Obj => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Obj;

export type Row = [string, number, string, string, string | null, boolean | null];

let rowCounter = 0;
/** Recon Q5: every row carries id, eventstroke, eventdistance, eventcourse, eventgender, numlegs, eventtime, flystart, pointvalue. */
export const rowToObject = (r: Row): Obj => ({
  id: `row-${(rowCounter += 1)}`, // the fixtures strip ids; this is a test-only stand-in
  numlegs: r[0] === '6' || r[0] === '7' ? 4 : 1,
  eventstroke: r[0],
  eventdistance: r[1],
  eventcourse: r[2],
  eventtime: r[3],
  pointvalue: r[4],
  flystart: r[5],
  eventgender: 'M',
});

/** One roster as the page holds it: swim rows carry `swimmer` and `team` back-references (a cyclic graph). */
export function inflateRoster(file: string, team: Obj): Obj {
  const raw = fixture(file) as { swimmers: Obj[]; relays: Row[] };
  const swimmers = raw.swimmers.map((s) => {
    const swimmer: Obj = { id: s.sid, name: s.sid, gender: s.gender, gradcollege: s.gradcollege };
    const wrap = (rows: Row[]) => rows.map((r) => ({ ...rowToObject(r), swimmer, team }));
    swimmer.indrecords = wrap(s.indrecords as Row[]);
    swimmer.relaysplits = wrap(s.relaysplits as Row[]);
    swimmer.relayleadoffs = wrap(s.relayleadoffs as Row[]);
    return swimmer;
  });
  // Live store, 2026-10-26 (teams 48 and 58): a relay row has no `flystart` key at all. The fixture's
  // positional null is only the array format, so drop the key here to match the page.
  const relays = raw.relays.map((r) => {
    const { flystart: _absent, ...row } = rowToObject(r);
    return { ...row, team };
  });
  return { swimmers, relays };
}

/**
 * The page's `gf` sets `points` to a table lookup, which is `undefined` past the last place. JSON shows
 * that as `null` in the fixture. Leg splashes never go through `gf`, so they have no `points` key at all.
 */
export const pointsOf = (fixturePoints: unknown): unknown => fixturePoints ?? undefined;

/** The fields a leg splash takes from the swim row the page copied into it. */
export interface LegRow {
  readonly sid: string;
  readonly eventstroke: string;
  readonly eventdistance: number;
  readonly eventtime: string;
  readonly flystart: boolean;
}

/** What `inflateSplashes` tells the leg builder about one relay entry. */
export interface RelayEntryInfo {
  readonly eventKey: string;
  readonly teamId: number;
  readonly eventstroke: string;
  readonly eventdistance: number;
  readonly relayTime: number;
  readonly legSids: readonly string[];
}

/**
 * The page's chosen entries (config `results`), as splash objects. Relay legs get a `relay_id`.
 * Without `legsOf`, a leg splash repeats the relay's event fields and has `eventtime: null` (the
 * fixture has no per-leg times). With it, each leg takes the row `legsOf` names, as the live page does.
 */
export function inflateSplashes(
  config: { results: Record<string, unknown[][]> },
  teams: Map<number, Obj>,
  legsOf?: (relay: RelayEntryInfo) => readonly LegRow[],
): Obj[] {
  const splashes: Obj[] = [];
  for (const [key, entries] of Object.entries(config.results)) {
    const parts = key.split('|');
    const dive = parts[0] === 'H';
    const event = dive
      ? { eventstroke: 'H', eventdistance: Number(parts[1]), eventcourse: '' }
      : { eventstroke: parts[0], eventdistance: Number(parts[1]), eventcourse: parts[2] };
    for (const entry of entries) {
      const team = teams.get(entry[0] as number);
      const who = entry[1] as string;
      if (who.startsWith('relay:')) {
        const relayId = `${key}#${entry[0]}#${who}`;
        splashes.push({ ...event, id: relayId, team, points: pointsOf(entry[3]), eventtime: entry[2] });
        const sids = entry[4] as string[];
        const legs = legsOf
          ? legsOf({
              eventKey: key,
              teamId: entry[0] as number,
              eventstroke: event.eventstroke as string,
              eventdistance: event.eventdistance,
              relayTime: entry[2] as number,
              legSids: sids,
            })
          : null;
        sids.forEach((sid, i) => {
          const leg = legs?.[i];
          splashes.push(
            leg
              ? {
                  id: `${relayId}#${i + 1}`,
                  team,
                  swimmer: { id: sid },
                  relay_id: relayId,
                  legposition: i + 1,
                  eventstroke: leg.eventstroke,
                  eventdistance: leg.eventdistance,
                  eventcourse: event.eventcourse,
                  eventtime: leg.eventtime,
                  flystart: leg.flystart,
                }
              : { ...event, id: `${relayId}#${i + 1}`, team, swimmer: { id: sid }, relay_id: relayId, legposition: i + 1, eventtime: null },
          );
        });
      } else {
        splashes.push({ ...event, id: `${key}#${entry[0]}#${who}`, team, swimmer: { id: who }, points: pointsOf(entry[3]), eventtime: entry[2] });
      }
    }
  }
  return splashes;
}

// ---- the page's aggregate-relay legs -------------------------------------------------------

type RawSwimmer = { sid: string; indrecords: Row[]; relaysplits: Row[]; relayleadoffs: Row[] };

const MEDLEY_ORDER = ['2', '3', '4', '1'];
const hundredths = (seconds: string | number): number => Math.round(Number(seconds) * 100);
const seconds = (h: number): string => (h / 100).toFixed(2);

/** The four leg rows of one aggregate relay, in the position order the fixture lists the swimmers. */
export function pageLegs(relay: RelayEntryInfo, swimmers: ReadonlyMap<string, RawSwimmer>): LegRow[] {
  const legDistance = relay.eventdistance / 4;
  const medley = relay.eventstroke === '7';
  const fastest = (rows: readonly Row[], stroke: string): number | null => {
    const times = rows.filter((r) => r[0] === stroke && r[1] === legDistance).map((r) => hundredths(r[3]));
    return times.length === 0 ? null : Math.min(...times);
  };
  const get = (sid: string): RawSwimmer => {
    const s = swimmers.get(sid);
    if (!s) throw new Error(`fixture relay names ${sid}, who is on no team file`);
    return s;
  };
  const flatTime = (s: RawSwimmer, stroke: string) => fastest([...s.indrecords, ...s.relayleadoffs], stroke);
  const flyTime = (s: RawSwimmer, stroke: string) => fastest(s.relaysplits, stroke);
  const strokeAt = (i: number) => (medley ? (MEDLEY_ORDER[i] as string) : '1');
  const target = hundredths(relay.relayTime);

  // A medley relay keeps its positions: leg 1 is the flat start. A free relay is reordered by time, so
  // any position can be the flat start. Try each; exactly one may reproduce the recorded time.
  const flatCandidates = medley ? [0] : [0, 1, 2, 3];
  const found: LegRow[][] = [];
  for (const flatAt of flatCandidates) {
    const legs: LegRow[] = [];
    let total = 0;
    let ok = true;
    for (let i = 0; i < 4; i += 1) {
      const sid = relay.legSids[i] as string;
      const stroke = strokeAt(i);
      const flat = i === flatAt;
      const h = flat ? flatTime(get(sid), stroke) : flyTime(get(sid), stroke);
      if (h === null) {
        ok = false;
        break;
      }
      total += h;
      legs.push({ sid, eventstroke: stroke, eventdistance: legDistance, eventtime: seconds(h), flystart: !flat });
    }
    if (ok && total === target) found.push(legs);
  }
  if (found.length !== 1) {
    throw new Error(
      `relay ${relay.eventKey} team ${relay.teamId} (${relay.legSids.join(',')}) time ${relay.relayTime}: ` +
        `${found.length} leg assignments reproduce it; need exactly 1`,
    );
  }
  return found[0] as LegRow[];
}

// ---- a SimSnapshot, as the bridge would post it --------------------------------------------

const TEAM_FILE: Record<number, string> = { 58: 'team-58.json', 48: 'team-48.json', 412: 'team-412.json' };

/** Flatten like the bridge does: `ind`, `split` and `leadoff` rows per swimmer, relay rows with `swimmerId: null`. */
function flattenRosters(origRosters: Record<number, Obj>): { swimmers: Obj[]; swims: Obj[] } {
  const swimmers: Obj[] = [];
  const swims: Obj[] = [];
  const kinds = [
    ['ind', 'indrecords'],
    ['split', 'relaysplits'],
    ['leadoff', 'relayleadoffs'],
  ] as const;
  for (const [tid, roster] of Object.entries(origRosters)) {
    const teamId = Number(tid);
    for (const s of (roster as { swimmers: Obj[] }).swimmers) {
      swimmers.push({ id: s.id, name: s.name, gender: s.gender, gradcollege: s.gradcollege, teamId });
      for (const [kind, key] of kinds) {
        for (const w of s[key] as Obj[]) {
          const { swimmer: _s, team: _t, ...row } = w;
          swims.push({ ...row, kind, teamId, swimmerId: s.id });
        }
      }
    }
    for (const w of (roster as { relays: Obj[] }).relays) {
      const { team: _t, ...row } = w;
      swims.push({ ...row, kind: 'relay', teamId, swimmerId: null });
    }
  }
  return { swimmers, swims };
}

const SPLASH_KEYS = 'id eventstroke eventdistance eventcourse eventtime eventgender numlegs flystart pointvalue relay_id legposition points exhibition'.split(' ');

export interface BuiltSnapshot {
  readonly config: Obj & { results: Record<string, unknown[][]>; totalScores: Record<string, { points: number; place: number | null }> };
  readonly snapshot: SimSnapshot;
}

/**
 * The snapshot the bridge would post for one recorded config, parsed through `simSnapshotSchema`
 * (so a shape the overlay would drop fails here too).
 */
export function buildSnapshot(name: ConfigName): BuiltSnapshot {
  const config = fixture(`config-${name}.json`) as BuiltSnapshot['config'] & { teams: Obj[]; settings: Obj; inputs: string[] };
  const teamById = new Map((config.teams as Obj[]).map((t) => [t.id as number, t]));
  const origRosters: Record<number, Obj> = {};
  const raw = new Map<string, RawSwimmer>();
  for (const file of config.inputs) {
    const id = Number(/team-(\d+)\.json/.exec(file)?.[1]);
    if (TEAM_FILE[id] !== file) throw new Error(`config ${name} names an unknown team file ${file}`);
    origRosters[id] = inflateRoster(file, teamById.get(id) as Obj);
    for (const s of (fixture(file) as { swimmers: RawSwimmer[] }).swimmers) raw.set(s.sid, s);
  }
  const { swimmers, swims } = flattenRosters(origRosters);

  const splashes = inflateSplashes(config, teamById, (relay) => pageLegs(relay, raw)).map((x) => {
    const pick = Object.fromEntries(SPLASH_KEYS.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
    const isRelayLevel = !x.swimmer && !x.relay_id && (x.eventstroke === '6' || x.eventstroke === '7');
    return { ...pick, teamId: (x.team as Obj).id, swimmerId: isRelayLevel ? null : (x.swimmer as Obj).id };
  });

  const settings: Obj = { ...(config.settings as Obj), seasonId: null };
  delete settings.presetId; // derived by the page, not a store key
  const parsed = simSnapshotSchema.safeParse({
    teams: config.teams,
    swimmers,
    swims,
    rosters: { swimmers, swims },
    settings,
    splashes,
    totalScores: config.totalScores,
  });
  if (!parsed.success) throw new Error(`fixture ${name} is not a valid SimSnapshot: ${JSON.stringify(parsed.error.issues[0])}`);
  return { config, snapshot: parsed.data };
}
