import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const bannedPatterns: readonly RegExp[] = [
  /\?\?\s*0(?:\.0+)?\b/,
  /\|\|\s*0\b/,
  /\?\?\s*1\b/,
  /\bMath\.(?!(?:abs|min|max|round)\b)/,
  /fatigue/,
  // Race analysis is pure (D2 E5): no UI, Node or filesystem import, in any import form
  // (`from`, bare `import`, dynamic `import()`, `require()`).
  /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:react(?:-dom)?|fs|path|node:[^'"]+)(?:\/[^'"]*)?['"]/,
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
    const root = join(process.cwd(), 'packages/engine/src/lib/raceAnalysis');
    const offenders: string[] = [];

    // A shim left behind in core would hold two lines and no named export. Scanning it would pass
    // for the wrong reason, so prove the scan reads the real implementation.
    const metrics = readFileSync(join(root, 'metrics.ts'), 'utf8');
    expect(metrics.length).toBeGreaterThan(1024);
    expect(metrics).toMatch(/export function /);

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
