/**
 * Pins `packages/core/src/data/relayPrograms.ts` to the archived primary
 * source text under `data/relay-programs/sources/`.
 *
 * Lines the data relies on (GLVC 2026 Complete Results, `pdftotext` output,
 * one `Event N <Women|Men> <name>` header per event; the PDF drops the "fl"
 * ligature, so Butterfly reads "Butter ly"):
 *
 *   Event 1 Women 800 Yard Freestyle Relay        (page 1)
 *   Event 2 Men 800 Yard Freestyle Relay          (page 2)
 *   Event 10 Women 200 Yard Medley Relay          (page 15)
 *   Event 19 Women 400 Yard Medley Relay          (page 28)
 *   Event 30 Women 200 Yard Freestyle Relay       (page 45)
 *   Event 41 Women 400 Yard Freestyle Relay       (page 62)
 *   Event 42 Men 400 Yard Freestyle Relay         (page 63)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFERENCE_PROGRAMS,
  GLVC_2025_26_PROGRAM,
} from '../packages/core/src/data/relayPrograms';

const SOURCES_DIR = path.resolve(__dirname, '..', 'data', 'relay-programs', 'sources');

interface ManifestSource {
  id: string;
  season: string;
  url: string;
  filename: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
  pageCount: number;
  extractedText: { filename: string; sha256: string; pdfSha256: string };
}

function loadManifest(): ManifestSource[] {
  const raw = JSON.parse(readFileSync(path.join(SOURCES_DIR, 'manifest.json'), 'utf8')) as {
    sources: ManifestSource[];
  };
  return raw.sources;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(path.join(SOURCES_DIR, file))).digest('hex');
}

interface ParsedEvent {
  eventNumber: number;
  gender: string;
  name: string;
  page: number;
}

/**
 * First printing of each numbered championship event (1 to 42) in the text.
 * Time trials and swim-offs have numbers above 42 and are skipped by rule.
 * The text sometimes carries a record line after the name
 * ("200 Yard Medley Relay GLVC: 1:39.42 R ..."); the name is cut there.
 */
function parseProgram(text: string): ParsedEvent[] {
  const found = new Map<number, ParsedEvent>();
  text.split('\f').forEach((pageText, index) => {
    for (const match of pageText.matchAll(/^Event (\d+) (Women|Men) (.*?)\s*$/gm)) {
      const [, numberText = '', gender = '', rawName = ''] = match;
      const eventNumber = Number(numberText);
      if (eventNumber > 42 || found.has(eventNumber)) continue;
      const name = rawName.replace(/ GLVC: .*$/, '').replace('Butter ly', 'Butterfly');
      found.set(eventNumber, { eventNumber, gender, name, page: index + 1 });
    }
  });
  return [...found.values()].sort((a, b) => a.eventNumber - b.eventNumber);
}

describe('conference relay programs: GLVC 2025-26', () => {
  const source = loadManifest().find((s) => s.id === GLVC_2025_26_PROGRAM.sourceId);
  // The results PDF and its text name every athlete at the meet, so they stay local
  // (gitignored). The manifest and the data are tracked. Without the files the two
  // checks that read them skip; tests/skip-budget.json lists them.
  const HAVE_SOURCE =
    source !== undefined &&
    existsSync(path.join(SOURCES_DIR, source.filename)) &&
    existsSync(path.join(SOURCES_DIR, source.extractedText.filename));

  it('cites a source that is in the manifest with the same season', () => {
    expect(source).toBeDefined();
    expect(source?.season).toBe(GLVC_2025_26_PROGRAM.season);
    expect(source?.url).toMatch(/^https:\/\//);
    expect(source?.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it.skipIf(!HAVE_SOURCE)('archives files whose bytes match the manifest sha256', () => {
    expect(source).toBeDefined();
    if (!source) return;
    expect(sha256(source.filename)).toBe(source.sha256);
    expect(sha256(source.extractedText.filename)).toBe(source.extractedText.sha256);
    expect(source.extractedText.pdfSha256).toBe(source.sha256);
  });

  it.skipIf(!HAVE_SOURCE)('matches the archived text event for event, in order', () => {
    expect(source).toBeDefined();
    if (!source) return;
    const text = readFileSync(path.join(SOURCES_DIR, source.extractedText.filename), 'utf8');
    const parsed = parseProgram(text);
    expect(parsed).toHaveLength(42);
    expect(
      GLVC_2025_26_PROGRAM.events.map((e) => ({
        eventNumber: e.eventNumber,
        gender: e.gender,
        name: e.name,
        page: e.sourcePage,
      })),
    ).toEqual(parsed);
  });

  it('lists the five relays for both genders and opens with the 800 free relay', () => {
    const relays = GLVC_2025_26_PROGRAM.events.filter((e) => e.kind === 'relay');
    expect(relays.map((e) => `${e.eventNumber} ${e.gender} ${e.relayLabel}`)).toEqual([
      '1 Women 800 Free Relay SCY',
      '2 Men 800 Free Relay SCY',
      '10 Women 200 Medley Relay SCY',
      '11 Men 200 Medley Relay SCY',
      '19 Women 400 Medley Relay SCY',
      '20 Men 400 Medley Relay SCY',
      '30 Women 200 Free Relay SCY',
      '31 Men 200 Free Relay SCY',
      '41 Women 400 Free Relay SCY',
      '42 Men 400 Free Relay SCY',
    ]);
    expect(GLVC_2025_26_PROGRAM.events[0]?.kind).toBe('relay');
    // Every event named "Relay" is a relay, and nothing else is.
    for (const e of GLVC_2025_26_PROGRAM.events) {
      expect(e.kind === 'relay').toBe(/Relay$/.test(e.name));
      expect(e.relayLabel !== undefined).toBe(e.kind === 'relay');
    }
  });

  it('keeps diving events marked as diving and leaves out time trials', () => {
    const diving = GLVC_2025_26_PROGRAM.events.filter((e) => e.kind === 'diving');
    expect(diving.map((e) => e.eventNumber)).toEqual([3, 12, 21, 32]);
    expect(GLVC_2025_26_PROGRAM.events.every((e) => e.eventNumber <= 42)).toBe(true);
    expect(GLVC_2025_26_PROGRAM.events.some((e) => /Time Trial|Swim-off/i.test(e.name))).toBe(
      false,
    );
  });

  it('records a season on every program', () => {
    for (const program of CONFERENCE_PROGRAMS) {
      expect(program.season).toMatch(/^\d{4}-\d{4}$/);
    }
  });
});
