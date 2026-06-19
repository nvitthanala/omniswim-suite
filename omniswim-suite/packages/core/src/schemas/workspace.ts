/**
 * Zod schemas for runtime validation at the API boundary.
 *
 * These intentionally stay permissive (`.passthrough()` / optional) so they
 * validate shape without rejecting forward-compatible fields. They mirror the
 * TypeScript interfaces in `../types` but are the source of truth for
 * server-side request validation.
 */
import { z } from 'zod';

export const genderSchema = z.enum(['Men', 'Women']);

export const swimmerResultSchema = z
  .object({
    id: z.string(),
    rank: z.number(),
    name: z.string(),
    classYear: z.string(),
    team: z.string(),
    time: z.string(),
    points: z.union([z.number(), z.string()]),
    event: z.string(),
  })
  .passthrough();

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
  .passthrough();

export const historicalSwimSchema = z
  .object({
    name: z.string(),
    team: z.string(),
    gender: genderSchema,
    event: z.string(),
    time: z.string(),
    source: z.enum(['pdf', 'paste', 'ocr', 'csv', 'manual']),
  })
  .passthrough();

/** Full workspace document as persisted. */
export const workspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    menResults: z.array(swimmerResultSchema).default([]),
    womenResults: z.array(swimmerResultSchema).default([]),
    recruits: z.array(recruitSchema).default([]),
    createdAt: z.number(),
  })
  .passthrough();

/** Body accepted by POST /api/workspaces (server fills defaults). */
export const createWorkspaceSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

/** Body accepted by PUT /api/workspaces/:id (partial patch). */
export const updateWorkspaceSchema = z.object({}).passthrough();

/** Body accepted by POST /api/parse-pdf. */
export const parsePdfSchema = z.object({
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
  .passthrough();

/** Body accepted by POST /api/import-csv. */
export const importCsvSchema = z.object({
  csv: z.string().min(1, 'CSV content required'),
  team: z.string().optional(),
  gender: z.union([genderSchema, z.string()]).optional(),
});

export type WorkspaceInput = z.infer<typeof workspaceSchema>;
