/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Second E1 fingerprint file for the engine extraction (plans/2026-10-25/D2-ENGINE-API.md, 2.5 E1).
 * It covers the first E1 bullet for the theoretical-meet fixtures. The main file is
 * `tests/engineExtractionFingerprint.test.ts`. Both files must stay green with unchanged hashes
 * at every extraction step.
 *
 * `tests/fixtures/theoretical-meet/` holds a capture store, not a workspace. The workspace is
 * built by `legacy/scripts/gen_engine_fingerprint_workspace.ts`. That script runs the chain and
 * the parameters of `legacy/tests/theoreticalMeetGolden.test.ts` (`runChain`, lines 94-102; the
 * constants at lines 59-67): SCY, conference `NSISC`, the NSISC preset, workspace id
 * `ws-theoretical-golden`, `createdAt` 1_760_000_000_000, no event order, no relays. It writes
 * `tests/fixtures/engineExtractionFingerprintTheoretical.workspace.json`.
 *
 * This test reads that JSON file and nothing from `legacy/`. It calls `buildScoringBundle` and
 * `buildScoringSnapshot` through `packages/core/src` paths (so after the move, through the shims)
 * for both genders, with `applyWhatIf` on and off. The canonical form, the hash and the run-twice
 * check are the same as in the main file. Hashes are in
 * `tests/fixtures/engineExtractionFingerprintTheoretical.json`. Do not edit them.
 *
 * Set `ENGINE_FINGERPRINT_OUT=<file>` to write the computed hashes to that file instead of comparing.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Gender } from '../packages/core/src/types';
import type { Workspace } from '../packages/core/src/types';
import { buildScoringBundle, buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const HASH_FILE = join(root, 'tests', 'fixtures', 'engineExtractionFingerprintTheoretical.json');
const WORKSPACE_FILE = join(root, 'tests', 'fixtures', 'engineExtractionFingerprintTheoretical.workspace.json');
const OUT_PATH = process.env.ENGINE_FINGERPRINT_OUT;

/* Canonical form and hash: identical to tests/engineExtractionFingerprint.test.ts. */

const DROPPED_KEYS: ReadonlySet<string> = new Set(['id', 'createdAt', 'updatedAt', 'importedAt', 'generated']);

function canonical(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : `<number:${String(value)}>`;
    case 'undefined':
      return null;
    case 'bigint':
      return `<bigint:${value.toString()}>`;
    case 'function':
    case 'symbol':
      throw new Error(`fingerprint: ${typeof value} at ${path}`);
    default:
      break;
  }
  if (Array.isArray(value)) return value.map((item, i) => canonical(item, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`fingerprint: non-plain object (${(value as object).constructor?.name ?? 'unknown'}) at ${path}`);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (DROPPED_KEYS.has(key)) continue;
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    out[key] = canonical(child, `${path}.${key}`);
  }
  return out;
}

function sha256Of(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value, '$'))).digest('hex');
}

const theoreticalWorkspace = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8')) as Workspace;
const clone = <T>(value: T): T => structuredClone(value);
const GENDERS = [Gender.MEN, Gender.WOMEN] as const;

type FingerprintCase = { id: string; run: () => unknown };
const cases: FingerprintCase[] = [];
for (const gender of GENDERS) {
  for (const applyWhatIf of [true, false]) {
    cases.push({
      id: `buildScoringBundle|theoretical-meet|${gender}|applyWhatIf=${applyWhatIf}`,
      run: () => {
        const workspace = clone(theoreticalWorkspace);
        return buildScoringBundle({
          workspace,
          gender,
          removeSeniors: false,
          applyWhatIf,
          scorerRosterOverrides: workspace.scorerRosterOverrides,
        });
      },
    });
  }
  cases.push({
    id: `buildScoringSnapshot|theoretical-meet|${gender}`,
    run: () => buildScoringSnapshot(clone(theoreticalWorkspace), gender, false),
  });
}

const expected: Record<string, string> =
  OUT_PATH === undefined
    ? ((JSON.parse(readFileSync(HASH_FILE, 'utf8')) as { cases: Record<string, string> }).cases)
    : {};

describe('engine extraction fingerprint, theoretical meet (D2 E1)', () => {
  it('has unique case ids', () => {
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  });

  if (OUT_PATH !== undefined) {
    it('writes the computed hashes', () => {
      const computed: Record<string, string> = {};
      for (const c of cases) {
        const first = sha256Of(c.run());
        const second = sha256Of(c.run());
        expect(second, c.id).toBe(first);
        computed[c.id] = first;
      }
      writeFileSync(OUT_PATH, `${JSON.stringify({ cases: computed }, null, 2)}\n`);
    });
    return;
  }

  it('covers exactly the committed case ids', () => {
    expect(cases.map(c => c.id).sort()).toStrictEqual(Object.keys(expected).sort());
  });

  for (const c of cases) {
    it(c.id, () => {
      const first = sha256Of(c.run());
      const second = sha256Of(c.run());
      expect(second, 'two runs of one case differ: a clock or random value leaked').toBe(first);
      expect(first).toBe(expected[c.id]);
    });
  }

  it('is not vacuous', () => {
    expect(theoreticalWorkspace.menResults?.length ?? 0).toBeGreaterThan(0);
    expect(theoreticalWorkspace.womenResults?.length ?? 0).toBeGreaterThan(0);
    for (const gender of GENDERS) {
      const bundle = buildScoringBundle({
        workspace: clone(theoreticalWorkspace),
        gender,
        removeSeniors: false,
        applyWhatIf: true,
        scorerRosterOverrides: theoreticalWorkspace.scorerRosterOverrides,
      });
      expect(bundle.sortedTeams.length, gender).toBeGreaterThan(0);
    }
  });
});
