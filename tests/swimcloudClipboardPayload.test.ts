/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `packages/swimcloud/src/clipboardPayload.ts`, the app-side reader
 * for what `extensions/swimcloud-companion/content.js` writes to the
 * clipboard.
 *
 * `content.js` cannot be imported here (it's a Manifest V3 content script, no
 * bundler, no Node environment for `document`/`navigator`), so this suite
 * validates the *shape contract* between the two: every payload shape below
 * is copy-pasted from what `buildPayload()` in that file actually produces,
 * not reconstructed from memory. If the extension's payload shape ever
 * changes, update both `content.js` and the fixtures here together — see the
 * extension's README, "Payload shape".
 */
import { describe, expect, it } from 'vitest';
import { readSwimCloudClipboardPayload } from '@omniswim/swimcloud';

/** Exactly what content.js's buildPayload() produces, as JSON text. */
function realisticPayloadText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    omniswimSwimCloudCapture: 1,
    sourceUrl: 'https://www.swimcloud.com/team/633/',
    retrievedAt: '2026-09-07T12:34:56.000Z',
    track: 'browser-extension',
    html: '<!doctype html><html><body>fixture</body></html>',
    ...overrides,
  });
}

describe('readSwimCloudClipboardPayload — the happy path', () => {
  it('accepts a well-formed payload and builds a ready-to-use parse context', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText());
    if (!result.ok) throw new Error(`expected ok, got rejected: ${result.reason} — ${result.message}`);

    expect(result.payload.sourceUrl).toBe('https://www.swimcloud.com/team/633/');
    expect(result.payload.html).toContain('fixture');
    expect(result.context).toEqual({
      sourceUrl: 'https://www.swimcloud.com/team/633/',
      retrievedAt: '2026-09-07T12:34:56.000Z',
      track: 'browser-extension',
    });
  });

  it('tolerates leading/trailing whitespace around the clipboard text (a paste often carries it)', () => {
    const result = readSwimCloudClipboardPayload(`\n  ${realisticPayloadText()}  \n`);
    expect(result.ok).toBe(true);
  });
});

describe('readSwimCloudClipboardPayload — rejects loudly, never silently guesses', () => {
  it('rejects empty clipboard content', () => {
    const result = readSwimCloudClipboardPayload('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('rejects whitespace-only clipboard content the same way as truly empty', () => {
    const result = readSwimCloudClipboardPayload('   \n\t  ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('rejects non-JSON text (e.g. someone copied a URL, not the extension output)', () => {
    const result = readSwimCloudClipboardPayload('https://www.swimcloud.com/team/633/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-json');
  });

  it('rejects valid JSON that is not an object (an array, a bare string, a number)', () => {
    for (const text of ['[1,2,3]', '"just a string"', '42', 'null']) {
      const result = readSwimCloudClipboardPayload(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('wrong-shape');
    }
  });

  it('rejects a payload missing the version marker entirely', () => {
    const { omniswimSwimCloudCapture: _drop, ...rest } = JSON.parse(realisticPayloadText());
    const result = readSwimCloudClipboardPayload(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported-version');
  });

  it('rejects a payload from a future, incompatible extension version rather than guessing at its shape', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ omniswimSwimCloudCapture: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-version');
      expect(result.message).toContain('2');
    }
  });

  it('rejects a payload missing a required field', () => {
    for (const field of ['sourceUrl', 'retrievedAt', 'track', 'html']) {
      const full = JSON.parse(realisticPayloadText());
      delete full[field];
      const result = readSwimCloudClipboardPayload(JSON.stringify(full));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('wrong-shape');
    }
  });

  it('rejects a payload whose fields are the wrong type', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ sourceUrl: 12345 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });

  it('rejects a payload with the wrong track value (this reader is Track A only)', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ track: 'playwright' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });

  it('rejects a payload whose captured html is empty — a real capture is never nothing', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ html: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });
});
