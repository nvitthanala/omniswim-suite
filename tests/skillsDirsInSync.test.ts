/**
 * H7: `.agents/skills/` is the canonical copy of the vendored UI skills and
 * `.claude/skills/` mirrors it. Git symlinks are off on the Windows checkout
 * (core.symlinks=false), so the mirror is a plain copy. This test fails when
 * the two drift. To fix a failure, edit `.agents/skills/` and copy the file to
 * `.claude/skills/`. Skills that exist only under `.claude/skills/` are the
 * project's own and are not checked.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const CANONICAL = path.join(ROOT, '.agents', 'skills');
const MIRROR = path.join(ROOT, '.claude', 'skills');

function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full, base) : [path.relative(base, full)];
  });
}

function text(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

describe('skills directories stay in sync', () => {
  const files = filesUnder(CANONICAL);

  it('finds the canonical skill files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s matches its .claude/skills copy', (rel) => {
    expect(text(path.join(MIRROR, rel))).toBe(text(path.join(CANONICAL, rel)));
  });
});
