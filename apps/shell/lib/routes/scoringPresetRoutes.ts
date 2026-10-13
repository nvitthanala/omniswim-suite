/**
 * Scoring-preset validation and CRUD routes.
 *
 * Built-in rule sets come from core, where they are generated from
 * NCAA_FORMAT_RULESETS at module load. User rule sets are JSON files under
 * `data/scoring_presets/`. A built-in ALWAYS wins its id: the write routes
 * reject a built-in id outright, so a user file with one can only be a stale
 * seed copy that predates this rule, and serving it would let the picker and
 * the engine disagree about what, say, "nsisc" means.
 *
 * Extracted from `server.ts`'s `startServer` (H2, code-health refactor,
 * 2026-09-25) with no behavior change: same paths, methods and error
 * handling as before. `registerScoringPresetRoutes` also runs the same
 * eager `refreshUserConferenceBindings()` call the inline code ran at this
 * point in `startServer`.
 */
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { apiError } from '../middleware/apiError.ts';
import {
  SCORING_PRESET_META_KEYS,
  HostPublishedTableRequiredError,
  builtInScoringPresetMeta,
  isBuiltInScoringPresetId,
  setUserConferencePresetBindings,
  settingsForBuiltInScoringPreset,
} from '../../../../packages/core/src/lib/scoringDefaults.ts';
import { NCAA_MEET_FORMATS, type NcaaMeetFormat } from '../../../../packages/core/src/lib/ncaaScoringRules.ts';
import { pointsTableSchema } from '../../../../packages/core/src/lib/scoringPlaceTables.ts';

/** Keys a stored preset carries about itself rather than about scoring. Defined once, in core. */
const PRESET_META_KEYS = new Set<string>(SCORING_PRESET_META_KEYS);

/** A saved preset id: lowercase, so two files cannot collide on a case-insensitive filesystem. */
const USER_PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** Thrown when an id that is not a valid saved-preset id reaches a file-path join. */
export class InvalidPresetIdError extends Error {
  constructor(presetId: string) {
    super(`${JSON.stringify(presetId)} is not a valid scoring preset id.`);
    this.name = 'InvalidPresetIdError';
  }
}

/**
 * The one place a preset id becomes a file path. The id is checked against
 * `USER_PRESET_ID_RE` here, not only in the request schema, so no caller can
 * join a raw id (`../x`, an absolute path, an empty string) into the presets
 * directory.
 */
export function userPresetFilePathIn(dir: string, presetId: string): string {
  if (typeof presetId !== 'string' || !USER_PRESET_ID_RE.test(presetId)) {
    throw new InvalidPresetIdError(String(presetId));
  }
  return path.resolve(dir, `${presetId}.json`);
}

function stripPresetMeta(raw: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PRESET_META_KEYS.has(k)) settings[k] = v;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Scoring-preset validation
// ---------------------------------------------------------------------------

// `pointsTableSchema` (finite, not negative, not increasing, at least one entry)
// lives in core so the shell and the workspace save share one definition.

const scorerAutoRulesSchema = z
  .object({
    abFinalTiers: z.array(z.enum(['A', 'B'])).optional(),
    includeRelayLegsInFinals: z.boolean().optional(),
    distanceFinalRequired: z.boolean().optional(),
    distanceEventPattern: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Strict on purpose. A misspelled key in a scoring rule set is exactly how a
 * silent wrong total is born: the engine ignores `relayPoint`, the coach sees
 * their table saved, and the relays score off the multiplier instead. Naming the
 * unknown key is far better than accepting it.
 */
const scoringSettingsSchema = z
  .object({
    scoringPoints: pointsTableSchema('scoringPoints'),
    relayMultiplier: z.number().finite().nonnegative(),
    halfRateRelaySwimmer: z.boolean(),
    maxIndividualScorersPerTeam: z.number().finite().nonnegative(),
    maxRelaysScoringPerTeam: z.number().finite().nonnegative(),
    aFinalBracketSize: z.number().int().positive().optional(),
    unscoredRounds: z.array(z.string()).optional(),
    scoredEventNumberMax: z.number().int().positive().optional(),
    scorerCapScope: z.enum(['meet', 'event']).optional(),
    diverScorerWeight: z.number().finite().positive().optional(),
    diverEventPattern: z.array(z.string().min(1)).optional(),
    relayEligibleFromScorerPool: z.boolean().optional(),
    scorerEligibilityMode: z.enum(['points_pool', 'roster']).optional(),
    usePdfPlacePoints: z.union([z.boolean(), z.literal('auto')]).optional(),
    scorerAutoRules: scorerAutoRulesSchema.optional(),
    maxIndividualEntriesPerSwimmer: z.number().int().nonnegative().optional(),
    maxRelayEntriesPerSwimmer: z.number().int().nonnegative().optional(),
    maxTotalEntriesPerSwimmer: z.number().int().nonnegative().optional(),
    entryCapCountsTimeTrials: z.boolean().optional(),
    entryCapCountsExhibition: z.boolean().optional(),
    relayLegsAllowTimeTrials: z.boolean().optional(),
    relayPoints: pointsTableSchema('relayPoints').optional(),
    divingPoints: pointsTableSchema('divingPoints').optional(),
    maxIndividualScorersPerTeamPerEvent: z.number().int().positive().optional(),
    divingMaxScorersPerTeamPerEvent: z.number().int().positive().optional(),
    overCapPlaceBehavior: z.enum(['holds-place', 'removed-from-consideration']).optional(),
    meetFormat: z
      .enum([...NCAA_MEET_FORMATS] as [NcaaMeetFormat, ...NcaaMeetFormat[]])
      .optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    // The engine refuses this pair at scoring time (see `resolveTeamPlaceCap`);
    // refusing it at the API boundary means a coach learns at save time, not
    // mid-meet.
    if (
      settings.maxIndividualScorersPerTeamPerEvent != null &&
      settings.scorerCapScope === 'meet' &&
      settings.maxIndividualScorersPerTeam < 999
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxIndividualScorersPerTeamPerEvent'],
        message:
          'A per-event place cap cannot be combined with a meet-wide scorer pool ' +
          "(scorerCapScope 'meet' with maxIndividualScorersPerTeam below 999). The two rules " +
          'disagree about whether a contestant who takes a place but scores nothing spends a ' +
          'pool slot, and the rulebook settles neither. Use one or the other.',
      });
    }
  });

const scoringPresetWriteSchema = z
  .object({
    id: z.string().regex(USER_PRESET_ID_RE, {
      message:
        'A preset id must be lowercase letters, digits, hyphens or underscores, start with a ' +
        'letter or digit, and be at most 80 characters.',
    }),
    label: z.string().trim().min(1, 'A preset needs a label.').max(120),
    description: z.string().max(1000).optional(),
    conferenceMatches: z.array(z.string().trim().min(1)).max(50).optional(),
    settings: scoringSettingsSchema,
  })
  .strict();

type ScoringPresetWriteBody = z.infer<typeof scoringPresetWriteSchema>;

function zodDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
}

export interface ScoringPresetRoutesDeps {
  scoringPresetsDir: string;
}

export function registerScoringPresetRoutes(app: Express, deps: ScoringPresetRoutesDeps): void {
  const SCORING_PRESETS_DIR = deps.scoringPresetsDir;

  function userPresetFilePath(presetId: string): string {
    return userPresetFilePathIn(SCORING_PRESETS_DIR, presetId);
  }

  function loadScoringPresetFile(presetId: string): Record<string, unknown> | null {
    const safeId = presetId.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(SCORING_PRESETS_DIR, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  }

  type UserPresetFile = { id: string; file: string; raw: Record<string, unknown> };

  /** Every user preset on disk. Throws on an unreadable file rather than hiding it. */
  function readUserPresetFiles(): UserPresetFile[] {
    if (!fs.existsSync(SCORING_PRESETS_DIR)) return [];
    const out: UserPresetFile[] = [];
    for (const file of fs.readdirSync(SCORING_PRESETS_DIR)) {
      if (!file.endsWith('.json')) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(SCORING_PRESETS_DIR, file), 'utf-8'));
      } catch (err) {
        throw new Error(
          `data/scoring_presets/${file} is not readable JSON: ${String(err)}. A scoring rule ` +
            `set that cannot be parsed is not a rule set — fix or remove the file.`
        );
      }
      const id = typeof raw.id === 'string' && raw.id ? raw.id : file.replace(/\.json$/, '');
      out.push({ id, file, raw });
    }
    return out;
  }

  function userPresetMeta(entry: UserPresetFile) {
    return {
      id: entry.id,
      label: typeof entry.raw.label === 'string' && entry.raw.label ? entry.raw.label : entry.id,
      description: typeof entry.raw.description === 'string' ? entry.raw.description : undefined,
      builtIn: false,
      group: 'Saved rule sets',
      conferenceMatches: Array.isArray(entry.raw.conferenceMatches)
        ? (entry.raw.conferenceMatches as string[])
        : undefined,
    };
  }

  /** Teach core's `presetIdForConference` about the saved rule sets. Built-ins still match first. */
  function refreshUserConferenceBindings(): void {
    try {
      setUserConferencePresetBindings(
        readUserPresetFiles()
          .filter(e => !isBuiltInScoringPresetId(e.id))
          .map(e => userPresetMeta(e))
      );
    } catch (err) {
      console.warn('[scoring-presets] conference bindings not refreshed:', String(err));
    }
  }
  refreshUserConferenceBindings();

  app.get('/api/scoring-presets', (_req, res) => {
    try {
      const onDisk = readUserPresetFiles();
      const shadowed = onDisk.filter(e => isBuiltInScoringPresetId(e.id));
      if (shadowed.length) {
        console.warn(
          `[scoring-presets] ignoring ${shadowed.map(e => e.file).join(', ')} — ` +
            `built-in rule sets are served from core and cannot be overridden on disk.`
        );
      }
      res.json([
        ...builtInScoringPresetMeta(),
        ...onDisk.filter(e => !isBuiltInScoringPresetId(e.id)).map(userPresetMeta),
      ]);
    } catch (err) {
      apiError(res, 500, 'PRESET_LIST_FAILED', 'Failed to list scoring presets', String(err));
    }
  });

  app.get('/api/scoring-presets/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltInScoringPresetId(id)) {
      try {
        return res.json(settingsForBuiltInScoringPreset(id));
      } catch (err) {
        if (err instanceof HostPublishedTableRequiredError) {
          // Absent, not empty. Rule 7-4 leaves the table to the host, so there is
          // nothing to return and nothing may be invented in its place.
          // err.message is the preset's own description, written for display (see apiError).
          return apiError(res, 409, 'HOST_PUBLISHED_TABLE_REQUIRED', err.message, undefined, {
            citation: err.citation,
            requiresHostPublishedTable: true,
          });
        }
        return apiError(res, 500, 'PRESET_READ_FAILED', 'Failed to read preset', String(err));
      }
    }
    const raw = loadScoringPresetFile(id);
    if (!raw) return apiError(res, 404, 'PRESET_NOT_FOUND', 'Preset not found');
    res.json(stripPresetMeta(raw));
  });

  /** The flat on-disk shape: meta keys beside the settings, exactly as GET /:id serves it. */
  function presetFileContents(body: ScoringPresetWriteBody): Record<string, unknown> {
    return {
      id: body.id,
      label: body.label,
      ...(body.description ? { description: body.description } : {}),
      ...(body.conferenceMatches?.length ? { conferenceMatches: body.conferenceMatches } : {}),
      ...body.settings,
    };
  }

  function parsePresetWrite(req: import('express').Request, res: import('express').Response, urlId?: string) {
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    if (urlId != null) {
      if (body.id != null && body.id !== urlId) {
        apiError(
          res,
          400,
          'PRESET_ID_MISMATCH',
          `Body id "${String(body.id)}" does not match the URL id "${urlId}".`
        );
        return null;
      }
      body.id = urlId;
    }
    const parsed = scoringPresetWriteSchema.safeParse(body);
    if (!parsed.success) {
      apiError(res, 400, 'INVALID_PRESET', 'Invalid scoring preset', zodDetails(parsed.error));
      return null;
    }
    if (isBuiltInScoringPresetId(parsed.data.id)) {
      apiError(
        res,
        409,
        'PRESET_BUILT_IN',
        `"${parsed.data.id}" is a built-in rule set. Built-ins are generated from the ` +
          `published rulebook and are immutable; save this under a different id.`
      );
      return null;
    }
    return parsed.data;
  }

  app.post('/api/scoring-presets', (req, res) => {
    const body = parsePresetWrite(req, res);
    if (!body) return;
    const filePath = userPresetFilePath(body.id);
    if (fs.existsSync(filePath)) {
      return apiError(res, 409, 'PRESET_EXISTS', `A scoring preset with id "${body.id}" already exists.`);
    }
    try {
      fs.mkdirSync(SCORING_PRESETS_DIR, { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(presetFileContents(body), null, 2)}\n`, 'utf-8');
      refreshUserConferenceBindings();
      res.status(201).json({
        id: body.id,
        label: body.label,
        description: body.description,
        builtIn: false,
        group: 'Saved rule sets',
        conferenceMatches: body.conferenceMatches,
      });
    } catch (err) {
      apiError(res, 500, 'PRESET_SAVE_FAILED', 'Failed to save the scoring preset', String(err));
    }
  });

  app.put('/api/scoring-presets/:id', (req, res) => {
    const body = parsePresetWrite(req, res, req.params.id);
    if (!body) return;
    const filePath = userPresetFilePath(body.id);
    if (!fs.existsSync(filePath)) {
      return apiError(res, 404, 'PRESET_NOT_FOUND', `No scoring preset with id "${body.id}".`);
    }
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(presetFileContents(body), null, 2)}\n`, 'utf-8');
      refreshUserConferenceBindings();
      res.json({
        id: body.id,
        label: body.label,
        description: body.description,
        builtIn: false,
        group: 'Saved rule sets',
        conferenceMatches: body.conferenceMatches,
      });
    } catch (err) {
      apiError(res, 500, 'PRESET_SAVE_FAILED', 'Failed to save the scoring preset', String(err));
    }
  });

  app.delete('/api/scoring-presets/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltInScoringPresetId(id)) {
      return apiError(res, 409, 'PRESET_BUILT_IN', `"${id}" is a built-in rule set and cannot be deleted.`);
    }
    if (!USER_PRESET_ID_RE.test(id)) {
      return apiError(res, 400, 'INVALID_PRESET_ID', `"${id}" is not a valid preset id.`);
    }
    const filePath = userPresetFilePath(id);
    if (!fs.existsSync(filePath)) {
      return apiError(res, 404, 'PRESET_NOT_FOUND', `No scoring preset with id "${id}".`);
    }
    try {
      fs.unlinkSync(filePath);
      refreshUserConferenceBindings();
      res.json({ success: true });
    } catch (err) {
      apiError(res, 500, 'PRESET_DELETE_FAILED', 'Failed to delete the scoring preset', String(err));
    }
  });
}

export type { ScoringPresetWriteBody };
export { scoringPresetWriteSchema, USER_PRESET_ID_RE };
