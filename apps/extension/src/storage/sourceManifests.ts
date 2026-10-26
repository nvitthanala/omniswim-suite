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
