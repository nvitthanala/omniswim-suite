/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the OmniSwim extension in memory with the exact options the CLI uses
 * (`apps/extension/build.config.mjs`). Shared by tests/extensionBuildFreshness.test.ts
 * and tests/extensionBundleBoundaries.test.ts so neither keeps its own copy of the options.
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
// @ts-expect-error -- plain .mjs config, deliberately untyped; see its header.
import * as config from '../../apps/extension/build.config.mjs';

export interface ExtensionEntry {
  readonly name: string;
  readonly in: string;
  readonly format: string;
  readonly loader: Record<string, string>;
}

export interface StaticFile {
  readonly from: string;
  readonly to: string;
}

export interface BuiltFile {
  /** File name relative to `dist/`, with forward slashes. */
  readonly name: string;
  readonly text: string;
}

export interface BuiltEntry {
  readonly entry: ExtensionEntry;
  readonly files: readonly BuiltFile[];
  readonly metafile: esbuild.Metafile;
}

export const entries = config.entries as readonly ExtensionEntry[];
export const staticFiles = config.staticFiles as readonly StaticFile[];
export const extensionRoot = config.extensionRoot as string;
export const outDir = config.outDir as string;
export const repoRoot = path.resolve(extensionRoot, '..', '..');

/** Build one entry in memory. Never writes to disk. `harness: true` is the dist-harness/ build with the test probe on. */
export async function buildEntry(entry: ExtensionEntry, opts: { harness?: boolean } = {}): Promise<BuiltEntry> {
  const options = config.entryBuildOptions(entry, { harness: opts.harness ?? false }) as esbuild.BuildOptions;
  const result = await esbuild.build({ ...options, write: false, logLevel: 'silent' });
  const files = result.outputFiles!.map((f) => ({
    name: path.relative(options.outdir!, f.path).split(path.sep).join('/'),
    text: f.text,
  }));
  return { entry, files, metafile: result.metafile! };
}

export function buildAll(): Promise<BuiltEntry[]> {
  return Promise.all(entries.map((entry) => buildEntry(entry)));
}

/** A metafile input path as a repo-root-relative path with forward slashes. */
export function inputFromRepoRoot(input: string): string {
  return path.relative(repoRoot, path.resolve(extensionRoot, input)).split(path.sep).join('/');
}
