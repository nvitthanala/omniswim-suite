/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure structural validation for an imported scoring-preset file
 * (`ScoringPresetManagerModal.tsx`'s `validateImportedPresetFile`). This is
 * the "do not trust file contents" gate: CLAUDE.md's provenance rule says a
 * malformed points table must never be silently coerced, so every case here
 * asserts BOTH that a bad file is rejected AND that the rejection names the
 * specific field that was wrong — a generic "invalid file" would satisfy a
 * looser test but not a coach trying to fix their file.
 */
import { describe, expect, it } from 'vitest';
import { slugify, validateImportedPresetFile } from '@omniswim/matrix/components/ScoringPresetManagerModal';

function valid() {
  return {
    omniswimScoringPreset: 1,
    id: 'my-dual-meet',
    label: 'My Dual Meet',
    description: 'A hand-authored dual meet rule set.',
    conferenceMatches: ['GSC'],
    settings: {
      scoringPoints: [9, 4, 3, 2, 1],
      relayPoints: [11, 4, 2],
      relayMultiplier: 2,
      halfRateRelaySwimmer: true,
      maxIndividualScorersPerTeam: 999,
      maxRelaysScoringPerTeam: 999,
    },
  };
}

describe('validateImportedPresetFile', () => {
  it('accepts a well-formed export', () => {
    const result = validateImportedPresetFile(valid());
    expect('file' in result).toBe(true);
    if ('file' in result) {
      expect(result.file.id).toBe('my-dual-meet');
      expect(result.file.settings.relayPoints).toStrictEqual([11, 4, 2]);
    }
  });

  it('rejects a non-object', () => {
    const result = validateImportedPresetFile('not json');
    expect(result).toStrictEqual({ error: 'The file does not contain a JSON object.' });
  });

  it('rejects a file missing the format marker', () => {
    const { omniswimScoringPreset: _drop, ...rest } = valid();
    const result = validateImportedPresetFile(rest);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/omniswimScoringPreset/);
  });

  it('rejects a missing label', () => {
    const file = valid() as Record<string, unknown>;
    delete file.label;
    const result = validateImportedPresetFile(file);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/label/);
  });

  it('rejects settings.scoringPoints that is not an array of numbers — the field, named', () => {
    const file = valid();
    (file.settings as Record<string, unknown>).scoringPoints = ['nine', 'four'];
    const result = validateImportedPresetFile(file);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('"settings.scoringPoints" must be an array of numbers.');
  });

  it('rejects a relayPoints value that is not an array at all', () => {
    const file = valid();
    (file.settings as Record<string, unknown>).relayPoints = 'eleven-four-two';
    const result = validateImportedPresetFile(file);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('"settings.relayPoints" must be an array of numbers when present.');
  });

  it('rejects a relayPoints array whose entries are not numbers — an array shape alone is not enough', () => {
    const file = valid();
    (file.settings as Record<string, unknown>).relayPoints = ['eleven', 'four', 'two'];
    const result = validateImportedPresetFile(file);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('"settings.relayPoints" must be an array of numbers when present.');
  });

  it('rejects a malformed divingPoints table', () => {
    const file = valid();
    (file.settings as Record<string, unknown>).divingPoints = [1, 'two', 3];
    const result = validateImportedPresetFile(file);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('"settings.divingPoints" must be an array of numbers when present.');
  });

  it('falls back to a slugified id when the file id is absent or invalid, rather than failing', () => {
    const file = valid() as Record<string, unknown>;
    file.id = 'Not An Id!!';
    const result = validateImportedPresetFile(file);
    expect('file' in result).toBe(true);
    if ('file' in result) expect(result.file.id).toBe(slugify('My Dual Meet'));
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('My Dual Meet (copy)')).toBe('my-dual-meet-copy');
  });

  it('falls back to a timestamped id when the label collapses to nothing usable', () => {
    expect(slugify('!!!')).toMatch(/^preset-\d+$/);
  });
});
