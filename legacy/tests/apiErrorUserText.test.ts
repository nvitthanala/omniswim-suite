/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two always-sent `apiError` fields, `userMessage` and `fieldErrors`, and
 * the clients that read them. In production `details` is dropped, so a client
 * that reads only `details` shows no field list and no size hint.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePsychApiResponse } from '../packages/matrix/src/components/opsModuleHelpers';
import {
  createScoringPreset,
  ScoringPresetApiError,
  type ScoringPresetWriteInput,
} from '../../packages/core/src/lib/scoringPresets';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePsychApiResponse reads userMessage', () => {
  const body = (extra: Record<string, unknown>) => JSON.stringify({ error: 'PDF too large', code: 'PDF_TOO_LARGE', ...extra });

  it('shows the size hint from userMessage when details is absent, as in production', () => {
    const out = parsePsychApiResponse(body({ userMessage: 'The PDF upload is limited to 10 MB.' }), 413, false);
    expect(out).toEqual({ error: 'PDF too large — The PDF upload is limited to 10 MB.' });
  });

  it('prefers userMessage over details', () => {
    const out = parsePsychApiResponse(body({ userMessage: 'user text', details: 'dev text' }), 413, false);
    expect(out).toEqual({ error: 'PDF too large — user text' });
  });

  it('falls back to details when there is no userMessage', () => {
    const out = parsePsychApiResponse(body({ details: 'dev text' }), 413, false);
    expect(out).toEqual({ error: 'PDF too large — dev text' });
  });

  it('shows the error alone when neither is sent', () => {
    expect(parsePsychApiResponse(body({}), 413, false)).toEqual({ error: 'PDF too large' });
  });
});

describe('scoring preset client reads fieldErrors', () => {
  const input = { label: 'x', settings: {} } as unknown as ScoringPresetWriteInput;

  const reply = (payload: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => payload }) as Response)
    );

  it('reads fieldErrors when details is absent, as in production', async () => {
    reply({
      error: 'Invalid scoring preset',
      code: 'INVALID_PRESET',
      fieldErrors: [{ path: 'settings.scoringPoints', message: 'Expected array' }],
    });
    const err = await createScoringPreset(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScoringPresetApiError);
    expect((err as ScoringPresetApiError).details).toEqual([
      { path: 'settings.scoringPoints', message: 'Expected array' },
    ]);
  });

  it('falls back to details from an older server', async () => {
    reply({ error: 'Invalid scoring preset', details: [{ path: 'label', message: 'Required' }] });
    const err = await createScoringPreset(input).catch((e: unknown) => e);
    expect((err as ScoringPresetApiError).details).toEqual([{ path: 'label', message: 'Required' }]);
  });

  it('has an empty list when neither is sent', async () => {
    reply({ error: 'Invalid scoring preset' });
    const err = await createScoringPreset(input).catch((e: unknown) => e);
    expect((err as ScoringPresetApiError).details).toEqual([]);
  });
});
