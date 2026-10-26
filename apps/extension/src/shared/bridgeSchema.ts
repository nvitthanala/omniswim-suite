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
import { z } from 'zod';
import { BRIDGE_SOURCE, BRIDGE_VERSION } from './protocol';

// Zod v4 can compile parsers with the Function constructor. MV3 content scripts
// and extension pages block that (D3 T-B7). Turn it off before any schema exists.
z.config({ jitless: true });

const id = z.union([z.string(), z.number()]);
const num = z.union([z.string(), z.number()]);

const team = z.object({
  id: z.number(),
  name: z.string(),
  abbr: z.string().nullish(),
  orgcode: num.nullish(),
});

const swimmer = z.object({
  id,
  teamId: z.number(),
  name: z.string().nullish(),
  display_name: z.string().nullish(),
  gender: z.string().nullish(),
  gradcollege: num.nullish(),
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
    swimmerId: id.nullable(),
    id,
    eventstroke: z.string(),
    eventdistance: num,
    eventcourse: z.string(),
    eventgender: z.string(),
    numlegs: num,
    eventtime: num,
    flystart: z.boolean().nullable().optional(),
    pointvalue: num.nullable(),
  })
  .refine((s) => s.kind === 'relay' || s.flystart !== undefined, { message: 'flystart is required unless kind is relay', path: ['flystart'] });

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
  swimmerId: id.nullable(),
  eventstroke: z.string(),
  eventdistance: num,
  eventcourse: z.string(),
  eventtime: num.nullable(),
  eventgender: z.string().nullish(),
  numlegs: num.nullish(),
  flystart: z.boolean().nullish(),
  pointvalue: num.nullish(),
  relay_id: id.nullish(),
  legposition: num.nullish(),
  points: z.number().nullish(),
  exhibition: z.union([z.boolean(), z.number(), z.string()]).nullish(),
});

const settings = z.object({
  seasonId: z.number().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  startSeason: z.string().nullable(),
  endSeason: z.string().nullable(),
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
  selectedShortcut: z.string().nullable(),
  inactiveSwimmers: z.array(id),
  /** The page's coach edits, as it holds them. The shape is not pinned by recon, so it passes through. */
  meetChanges: z.array(z.unknown()),
});

const totalScores = z.record(z.string(), z.object({ points: z.number(), place: z.number().nullable() }));

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
  swimmers: z.array(swimmer).nullable(),
  swims: z.array(swim).nullable(),
  /** From the store's `rosters`: the current rosters after coach edits (inactive swimmers removed). */
  rosters: roster.nullable(),
  settings,
  splashes: z.array(splash).nullable(),
  totalScores: totalScores.nullable(),
});
export type SimSnapshot = z.infer<typeof simSnapshotSchema>;

const header = { source: z.literal(BRIDGE_SOURCE), v: z.literal(BRIDGE_VERSION) };

export const bridgeMessageSchema = z.discriminatedUnion('kind', [
  z.object({ ...header, kind: z.literal('snapshot'), snapshot: simSnapshotSchema }),
  /** A raw `GET /api/teams/{id}/simulator/` response body, as the page received it. */
  z.object({
    ...header,
    kind: z.literal('response'),
    url: z.string().regex(/^\/api\/teams\/\d+\/simulator\/(\?.*)?$/),
    body: z.object({ swimmers: z.array(z.unknown()), relays: z.array(z.unknown()) }),
  }),
  z.object({ ...header, kind: z.literal('error'), code: z.string(), detail: z.string() }),
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

export type ParsedBridgeMessage = { ok: true; message: BridgeMessage } | { ok: false; reason: string };

/** Validate one `message` event payload. Never throws. */
export function parseBridgeMessage(data: unknown): ParsedBridgeMessage {
  const r = bridgeMessageSchema.safeParse(data);
  if (r.success) return { ok: true, message: r.data };
  const first = r.error.issues[0];
  return { ok: false, reason: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid' };
}
