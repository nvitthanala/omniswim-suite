/**
 * Zod schemas for runtime validation at the API boundary.
 *
 * Most of these stay permissive (`.loose()` / optional) so they validate
 * shape without rejecting forward-compatible fields. The two workspace write
 * bodies are the exception: `createWorkspaceSchema` and `updateWorkspaceSchema`
 * are allowlists that strip what they do not name (a Zod object strips unknown
 * keys by default). They mirror the TypeScript interfaces in `../types` but are
 * the source of truth for server-side request validation.
 */
import { z } from 'zod';
import type { Workspace } from '../types';
import { storedPlaceTableSchema } from '../lib/scoringPlaceTables';

/**
 * A number that, like `z.number()` in Zod 3, accepts +Infinity and -Infinity and
 * refuses NaN and every non-number. Zod 4's `z.number()` refuses infinities, and a
 * body of `{"createdAt": 1e999}` parses to Infinity, so a plain `z.number()` would
 * start rejecting an input this API has always accepted. Use it only where the
 * Zod 3 schema was a bare `z.number()`; a field that was `.finite()` or `.int()`
 * stays `z.number()`, which rejects infinities in both versions.
 */
const numberAllowingInfinity = z.custom<number>(
  value => typeof value === 'number' && !Number.isNaN(value),
  'Invalid input: expected number'
);

export const genderSchema = z.enum(['Men', 'Women']);

export const swimmerResultSchema = z
  .object({
    id: z.string(),
    rank: numberAllowingInfinity,
    name: z.string(),
    classYear: z.string(),
    team: z.string(),
    time: z.string(),
    points: z.union([numberAllowingInfinity, z.string()]),
    event: z.string(),
  })
  .loose();

export const recruitSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    team: z.string(),
    event: z.string(),
    time: z.string(),
    gender: genderSchema,
    classYear: z.string(),
    timeType: z.enum(['SCY', 'LCM', 'SCM']),
  })
  .loose();

export const historicalSwimSchema = z
  .object({
    name: z.string(),
    team: z.string(),
    gender: genderSchema,
    event: z.string(),
    time: z.string(),
    source: z.enum(['pdf', 'paste', 'ocr', 'csv', 'manual', 'swimcloud']),
  })
  .loose();

/** Full workspace document as persisted. */
export const workspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    menResults: z.array(swimmerResultSchema).default([]),
    womenResults: z.array(swimmerResultSchema).default([]),
    recruits: z.array(recruitSchema).default([]),
    createdAt: numberAllowingInfinity,
  })
  .loose();

/**
 * One element of a workspace collection: an object, nothing more. Deliberately NOT
 * `swimmerResultSchema` and friends — those require fields (`rank`, `classYear`,
 * `points`) that real saved rows lack, and a stricter element schema would turn a
 * valid save into a 400. The element's own fields pass through untouched.
 */
const rowSchema = z.object({}).loose();
const rowsSchema = z.array(rowSchema);
const recordSchema = z.object({}).loose();

/**
 * A workspace's scoring settings: a record, plus a light check on its three place
 * tables (finite, not negative, not null, at least one entry each). A `null` cell
 * is how a UI draft spells "blank"; it must never reach a stored table, where it
 * would read as a place worth nothing. The non-increasing rule a preset obeys is
 * deliberately NOT applied: a legacy table must always save. Nothing else is
 * checked here, so every other settings key passes through untouched.
 */
const scoringSettingsSchema = z
  .object({
    scoringPoints: storedPlaceTableSchema('scoringSettings.scoringPoints').optional(),
    relayPoints: storedPlaceTableSchema('scoringSettings.relayPoints').optional(),
    divingPoints: storedPlaceTableSchema('scoringSettings.divingPoints').optional(),
  })
  .loose();

/**
 * Fields of a workspace a PUT may set: an ALLOWLIST. `id`, `createdAt` and
 * `version` are not in it, so they are stripped, and so is anything else the
 * client invents. The server owns identity, creation time and the revision counter.
 *
 * Why each is the shape it is:
 * - Collections are arrays of objects, so `"menResults": {}` or `[1, 2]` is a 400
 *   instead of a document the next read cannot map over.
 * - `activeEntryIds` is the one collection of strings, not objects.
 * - Keys left out of a patch stay out: nothing here has a default, because a default
 *   would write `[]` over a collection the patch never mentioned.
 */
export const workspacePatchShape = {
  name: z.string(),
  menResults: rowsSchema,
  womenResults: rowsSchema,
  sourceMenResults: rowsSchema,
  sourceWomenResults: rowsSchema,
  recruits: rowsSchema,
  scoringSettings: scoringSettingsSchema,
  conference: z.string(),
  deletedSwimmers: rowsSchema,
  scorerRosterOverrides: rowsSchema,
  officialTeamScores: recordSchema,
  relayLegOverrides: rowsSchema,
  loadedMeet: recordSchema,
  psychMenResults: rowsSchema,
  psychWomenResults: rowsSchema,
  loadedPsych: recordSchema,
  meetEntryPlans: rowsSchema,
  entryPlanMode: z.enum(['overlay', 'plan_sheet']),
  scoringView: z.enum(['merged', 'pdf_only']),
  activeEntryIds: z.array(z.string()),
  athleteHistory: rowsSchema,
  raceAnalyses: rowsSchema,
  historySources: rowsSchema,
  relayLegCredits: rowsSchema,
  athleteAliases: rowsSchema,
} as const;

/** Body accepted by PUT /api/workspaces/:id (partial patch). Unknown and protected keys are dropped. */
export const updateWorkspaceSchema = z.object(workspacePatchShape).partial();

/**
 * Body accepted by POST /api/workspaces (the server fills defaults for what is absent).
 *
 * The same ALLOWLIST and the same collection checks as a patch, plus the three keys
 * a create may name: `id` (a restore keeps its id), `name` and `createdAt`. It was
 * `.passthrough()`, which stored whatever the client sent: a `menResults` that was
 * not an array, or a key no code reads. Now a malformed value is a 400, and an
 * unknown key is dropped, the same as on PUT.
 *
 * `version` is not in the allowlist: the store owns it. A restored workspace arrives
 * carrying the revision it had, and it is stripped here, never trusted.
 * `workspacePatchCoversWorkspace` below makes `tsc` fail if `Workspace` gains a field
 * this does not accept, so a field cannot be silently dropped on create either.
 */
export const createWorkspaceSchema = z
  .object({
    id: z.string(),
    createdAt: numberAllowingInfinity,
    ...workspacePatchShape, // includes `name`
  })
  .partial();

/**
 * Compile-time guard: every `Workspace` field except `id` and `createdAt` is in the
 * allowlist, and nothing else is. Add a field to `Workspace` without adding it to
 * `workspacePatchShape` and `tsc` fails here, instead of the field silently never
 * saving. (e2e alone would not catch a field the UI sends rarely.)
 */
type PatchKeys = keyof typeof workspacePatchShape;
type WorkspacePatchableKeys = Exclude<keyof Workspace, 'id' | 'createdAt'>;
export type WorkspacePatchCoversWorkspace = [WorkspacePatchableKeys] extends [PatchKeys]
  ? [PatchKeys] extends [WorkspacePatchableKeys]
    ? true
    : { error: 'workspacePatchShape has a key Workspace does not'; extra: Exclude<PatchKeys, WorkspacePatchableKeys> }
  : { error: 'Workspace has a field workspacePatchShape does not'; missing: Exclude<WorkspacePatchableKeys, PatchKeys> };
export const workspacePatchCoversWorkspace: WorkspacePatchCoversWorkspace = true;

/** Body accepted by POST /api/parse-pdf. */
export const parsePdfSchema = z.object({
  base64: z.string().min(1, 'No base64 PDF data provided'),
  format: z.string().optional(),
});

/** Body accepted by POST /api/parse-psych-pdf. */
export const parsePsychPdfSchema = z.object({
  base64: z.string().min(1, 'No base64 PDF data provided'),
  format: z.string().optional(),
});

/** Body accepted by POST /api/parse-athlete-history. */
export const parseAthleteHistorySchema = z
  .object({
    text: z.string().optional(),
    imageBase64: z.string().optional(),
    team: z.string().optional(),
    gender: z.union([genderSchema, z.string()]).optional(),
    swimmerName: z.string().optional(),
    division: z.string().optional(),
  })
  .loose();

/** Body accepted by POST /api/import-csv. */
export const importCsvSchema = z.object({
  csv: z.string().min(1, 'CSV content required'),
  team: z.string().optional(),
  gender: z.union([genderSchema, z.string()]).optional(),
});

// ====================== Roster Catalog ======================

export const catalogGenderSchema = z.enum(['Men', 'Women']);
export const catalogTimeTypeSchema = z.enum(['SCY', 'LCM', 'SCM']);
export const catalogSourceSchema = z.enum(['paste', 'csv', 'ocr', 'manual', 'pdf', 'json']);

export const rosterTeamCreateSchema = z.object({
  name: z.string().min(1, 'Team name required'),
  gender: catalogGenderSchema,
  shortName: z.string().optional(),
  division: z.string().optional(),
  color: z.string().optional(),
  notes: z.string().optional(),
});

export const rosterTeamUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  shortName: z.string().optional(),
  division: z.string().optional(),
  color: z.string().optional(),
  notes: z.string().optional(),
});

export const rosterAthleteUpsertSchema = z.object({
  teamId: z.string().min(1),
  fullName: z.string().min(1),
  nameKey: z.string().optional(),
  classYear: z.string().optional(),
  gender: catalogGenderSchema,
});

export const rosterEventTimeUpsertSchema = z.object({
  athleteId: z.string().min(1),
  event: z.string().min(1),
  timeText: z.string().min(1),
  timeType: catalogTimeTypeSchema,
  source: catalogSourceSchema.default('manual'),
  swimcloudBadge: z.string().optional().nullable(),
  meetLabel: z.string().optional().nullable(),
  swimDate: z.string().optional().nullable(),
  isEligible: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

export const rosterEligibilityToggleSchema = z.object({
  timeId: z.string().min(1),
  isEligible: z.boolean(),
});

export const rosterBulkImportSchema = z.object({
  // Canonical JSON format used by the manager wizard.
  // Optional on purpose: Zod 3 accepted a body with no `json` key, Zod 4 would not.
  json: z.unknown().optional(),
});

export const rosterPasteImportSchema = z.object({
  teamId: z.string().min(1),
  text: z.string().min(1),
  format: z.enum(['auto', 'personal_bests', 'roster']).default('auto'),
  gender: catalogGenderSchema,
  division: z.string().optional(),
  // Optional explicit name resolution; mapped via nameKey in the wizard.
  swimmerOverrides: z
    .array(
      z.object({
        detectedName: z.string(),
        fullName: z.string().min(1),
        classYear: z.string().optional(),
      })
    )
    .optional(),
});

export type WorkspaceInput = z.infer<typeof workspaceSchema>;
