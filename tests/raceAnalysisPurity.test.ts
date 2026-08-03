import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const bannedPatterns: readonly RegExp[] = [
  /\?\?\s*0(?:\.0+)?\b/,
  /\|\|\s*0\b/,
  /\?\?\s*1\b/,
  /\bMath\.(?!(?:abs|min|max|round)\b)/,
  /fatigue/,
];

function tsFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...tsFilesUnder(path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

describe('raceAnalysis purity', () => {
  it('does not contain prohibited fallback constants or synthetic velocity helpers', () => {
    const root = join(process.cwd(), 'packages/core/src/lib/raceAnalysis');
    const offenders: string[] = [];

    for (const file of tsFilesUnder(root)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of bannedPatterns) {
        if (pattern.test(text)) {
          offenders.push(`${file}: ${pattern.source}`);
        }
      }
    }

    expect(offenders).toStrictEqual([]);
  });
});
