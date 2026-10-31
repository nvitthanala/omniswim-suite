/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The shape of every message the bridge posts, as zod schemas.
 *
 * The page can forge any `postMessage` (D3 2.7, bridge trust rule), so the
 * overlay parses each message here and drops the ones that fail. The bridge
 * itself imports only types from this file, so zod stays out of its bundle.
 *
 * Field types follow the live payload as recorded in
 * `plans/2026-10-25/02-SIMULATOR-RECON.md` (Q5, Q13, Q14) and the sanitized
 * fixtures in `tests/fixtures/swimcloud/simulator/`. Where the recon does not
 * pin a type, the schema accepts string or number rather than dropping a real
 * snapshot.
 */
import * as z from 'zod/mini';
import en from 'zod/v4/locales/en.js';
import { BRIDGE_SOURCE, BRIDGE_VERSION } from './protocol';

// Zod v4 can compile parsers with the Function constructor. MV3 content scripts
// and extension pages block that (D3 T-B7). Turn it off before any schema exists.
// `zod/mini` ships no error text, so the English locale keeps the drop reasons readable
// ("expected string, received number", not "Invalid input"). Import the one file: `z.locales.en()`
// bundles all locales (about 387 KB more). README R55.
z.config({ jitless: true, ...en() });

const id = z.union([z.string(), z.number()]);
const num = z.union([z.string(), z.number()]);

const team = z.object({
  id: z.number(),
  name: z.string(),
  abbr: z.nullish(z.string()),
  orgcode: z.nullish(num),
});

const swimmer = z.object({
  id,
  teamId: z.number(),
  name: z.nullish(z.string()),
  display_name: z.nullish(z.string()),
  gender: z.nullish(z.string()),
  gradcollege: z.nullish(num),
});

/**
 * Absent is not empty. Recon Q5: every swim row carries id, eventstroke, eventdistance, eventcourse,
 * eventgender, numlegs, eventtime, flystart and pointvalue. A key is required here, so a row with a
 * hole is dropped. `null` is accepted only for `flystart` and `pointvalue`, which recon saw as null
 * on relay splits and relay rows.
 *
 * Exception, from the live store (2026-10-26, teams 48 and 58): a relay row (`kind: 'relay'`) has no
 * `flystart` key at all. Only a relay row may omit it; every other kind must carry it.
 */
const swim = z
  .object({
    kind: z.enum(['ind', 'split', 'leadoff', 'relay']),
    teamId: z.number(),
    swimmerId: z.nullable(id),
    id,
    eventstroke: z.string(),
    eventdistance: num,
    eventcourse: z.string(),
    eventgender: z.string(),
    numlegs: num,
    eventtime: num,
    flystart: z.optional(z.nullable(z.boolean())),
    pointvalue: z.nullable(num),
  })
  .check(
    z.refine((s) => s.kind === 'relay' || s.flystart !== undefined, {
      error: 'flystart is required unless kind is relay',
      path: ['flystart'],
    }),
  );

/**
 * One entry the page chose, from `simulatedMeet.splashes` (recon Q14). Recon saw the entry summaries,
 * not the splash objects. So `teamId` and the five keys the Q13 sort uses are required, and
 * `swimmerId` is null only for a relay-level splash (the bridge decides). `eventtime` may be null
 * (the page sorts "has a time" first). UNVERIFIED live, hence optional: `eventgender`, `numlegs`,
 * `flystart`, `pointvalue`, `relay_id`, `legposition`, `exhibition`. `points` is missing past the
 * point table and on relay legs (recon README: beyond the table).
 */
const splash = z.object({
  id,
  teamId: id,
  swimmerId: z.nullable(id),
  eventstroke: z.string(),
  eventdistance: num,
  eventcourse: z.string(),
  eventtime: z.nullable(num),
  eventgender: z.nullish(z.string()),
  numlegs: z.nullish(num),
  flystart: z.nullish(z.boolean()),
  pointvalue: z.nullish(num),
  relay_id: z.nullish(id),
  legposition: z.nullish(num),
  points: z.nullish(z.number()),
  exhibition: z.nullish(z.union([z.boolean(), z.number(), z.string()])),
});

const settings = z.object({
  seasonId: z.nullable(z.number()),
  startDate: z.nullable(z.string()),
  endDate: z.nullable(z.string()),
  startSeason: z.nullable(z.string()),
  endSeason: z.nullable(z.string()),
  dateToUse: z.string(),
  pointSystem: z.string(),
  gender: z.string(),
  timeToUse: z.string(),
  eventCourse: z.string(),
  eventIds: z.array(z.string()),
  maxScorersPerTeam: z.number(),
  maxIndrecordsPerAthlete: z.number(),
  maxIndrecordsPerTeam: z.number(),
  maxRelaysPerAthlete: z.number(),
  maxRelaysPerTeam: z.number(),
  maxTotalPerAthlete: z.number(),
  freeRelayStrategy: z.string(),
  relayDataSource: z.string(),
  selectedShortcut: z.nullable(z.string()),
  inactiveSwimmers: z.array(id),
  /** The page's coach edits, as it holds them. The shape is not pinned by recon, so it passes through. */
  meetChanges: z.array(z.unknown()),
});

const totalScores = z.record(z.string(), z.object({ points: z.number(), place: z.nullable(z.number()) }));

/**
 * What the simulator page holds, copied out of its Redux store.
 *
 * `swimmers`, `swims`, `rosters`, `splashes` and `totalScores` are `null` while the page
 * has not loaded team data. `null` means not loaded. It never means an empty
 * list. `totalScores` is SwimCloud's own score, kept for parity checks.
 */
const roster = z.object({ swimmers: z.array(swimmer), swims: z.array(swim) });

export const simSnapshotSchema = z.object({
  teams: z.array(team),
  /** From the store's `origRosters`: the team data as parsed, before coach edits. */
  swimmers: z.nullable(z.array(swimmer)),
  swims: z.nullable(z.array(swim)),
  /** From the store's `rosters`: the current rosters after coach edits (inactive swimmers removed). */
  rosters: z.nullable(roster),
  settings,
  splashes: z.nullable(z.array(splash)),
  totalScores: z.nullable(totalScores),
});
export type SimSnapshot = z.infer<typeof simSnapshotSchema>;

const header = { source: z.literal(BRIDGE_SOURCE), v: z.literal(BRIDGE_VERSION) };
const writableSettings = z.strictObject({
  pointSystem: z.optional(z.string()),
  maxScorersPerTeam: z.optional(z.number()),
  maxIndrecordsPerAthlete: z.optional(z.number()),
  maxIndrecordsPerTeam: z.optional(z.number()),
  maxRelaysPerAthlete: z.optional(z.number()),
  maxRelaysPerTeam: z.optional(z.number()),
  maxTotalPerAthlete: z.optional(z.number()),
}).check(z.refine((s) => Object.keys(s).length > 0, { error: 'at least one supported setting is required' }));

export const bridgeMessageSchema = z.discriminatedUnion('kind', [
  z.object({ ...header, kind: z.literal('snapshot'), snapshot: simSnapshotSchema }),
  /** A raw `GET /api/teams/{id}/simulator/` response body, as the page received it. */
  z.object({
    ...header,
    kind: z.literal('response'),
    url: z.string().check(z.regex(/^\/api\/teams\/\d+\/simulator\/(\?.*)?$/)),
    body: z.object({ swimmers: z.array(z.unknown()), relays: z.array(z.unknown()) }),
  }),
  z.object({ ...header, kind: z.literal('error'), code: z.string(), detail: z.string() }),
  z.object({ ...header, kind: z.literal('write-result'), token: z.string(), status: z.literal('error'), detail: z.string() }),
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;
export type SimulatorWriteSettings = Partial<Record<'pointSystem' | 'maxScorersPerTeam' | 'maxIndrecordsPerAthlete' | 'maxIndrecordsPerTeam' | 'maxRelaysPerAthlete' | 'maxRelaysPerTeam' | 'maxTotalPerAthlete', string | number>>;
export const simulatorWriteSettingsSchema = writableSettings;

export type ParsedBridgeMessage = { ok: true; message: BridgeMessage } | { ok: false; reason: string };

/** Validate one `message` event payload. Never throws. */
export function parseBridgeMessage(data: unknown): ParsedBridgeMessage {
  const r = bridgeMessageSchema.safeParse(data);
  if (r.success) return { ok: true, message: r.data };
  const first = r.error.issues[0];
  return { ok: false, reason: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid' };
}
