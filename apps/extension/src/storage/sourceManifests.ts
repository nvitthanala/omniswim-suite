/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The primary-source manifests a `published` provenance may cite
 * (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.6 rule 4, and D2 finding F14).
 *
 * The three `data/**` `sources/manifest.json` files are imported as they are, so the list cannot
 * drift from the archive and nothing is typed by hand. `data/swimcloud-captures/simulator/manifest.json`
 * is not here on purpose: it says "Parity reference only, not published provenance", it is untracked,
 * and CI does not have it.
 */
import { BUILTIN_LCM_TO_SCY } from '@omniswim/engine';
import type { SourceRef } from '@omniswim/engine';
import cutlines from '../../../../data/cutlines/sources/manifest.json';
import relayPrograms from '../../../../data/relay-programs/sources/manifest.json';
import scoringRules from '../../../../data/scoring_rules/sources/manifest.json';

interface ManifestShape {
  readonly sources: readonly { readonly id: string; readonly sha256: string }[];
}

function sourceIndex(manifest: ManifestShape): ReadonlyMap<string, string> {
  return new Map(manifest.sources.map(s => [s.id, s.sha256]));
}

/** Repo path of a manifest, then source id to sha256. */
export const BUNDLED_SOURCE_MANIFESTS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ['data/cutlines/sources/manifest.json', sourceIndex(cutlines as ManifestShape)],
  ['data/relay-programs/sources/manifest.json', sourceIndex(relayPrograms as ManifestShape)],
  ['data/scoring_rules/sources/manifest.json', sourceIndex(scoringRules as ManifestShape)],
]);

/**
 * The tool archives a stored `tool-derived` provenance may cite: archive path, then sha256. The list is
 * read from the provenance of the engine's built-in sourcing presets, so it cannot drift from what the
 * engine ships. `tests/engineLcmToScy.test.ts` checks the sha256 against the file on disk. The SwimCloud
 * simulator archive is not here on purpose: the simulator preset is parity-only and is never stored.
 */
export const BUNDLED_TOOL_ARCHIVES: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const o = value as { kind?: unknown; archive?: { path?: unknown; sha256?: unknown } };
    if (o.kind === 'tool-derived' && typeof o.archive?.path === 'string' && typeof o.archive.sha256 === 'string') {
      out.set(o.archive.path, o.archive.sha256);
    }
    Object.values(value).forEach(walk);
  };
  walk(BUILTIN_LCM_TO_SCY);
  return out;
})();

/**
 * Why a `tool-derived` archive is not one a built-in cites, or `null` when it is. The path must be
 * listed and the sha256 must match.
 */
export function toolArchiveProblem(archive: { readonly path: string; readonly sha256: string }): string | null {
  const sha256 = BUNDLED_TOOL_ARCHIVES.get(archive.path);
  if (sha256 === undefined) return `tool archive "${archive.path}" is not one a built-in sourcing preset cites`;
  if (sha256 !== archive.sha256) return `tool archive "${archive.path}" sha256 does not match the built-in`;
  return null;
}

/**
 * Why a `published` source is not backed by a bundled manifest, or `null` when it is.
 * The manifest path must be a bundled one, the id must be listed in it, and the sha256 must match.
 */
export function publishedSourceProblem(source: SourceRef): string | null {
  const index = BUNDLED_SOURCE_MANIFESTS.get(source.manifest);
  if (!index) return `source manifest "${source.manifest}" is not a bundled data/**/sources/manifest.json`;
  const sha256 = index.get(source.sourceId);
  if (sha256 === undefined) return `source id "${source.sourceId}" is not listed in ${source.manifest}`;
  if (sha256 !== source.sha256) return `source "${source.sourceId}" sha256 does not match ${source.manifest}`;
  return null;
}
