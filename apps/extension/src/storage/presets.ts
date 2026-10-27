/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Built-in presets (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.8).
 *
 * NSISC and generic ship as code and are addressed by `PresetRef {kind:'builtin', id, version}`.
 * They are never seeded into IndexedDB: a fix to the built-in table then reaches existing
 * installs. A user copy records `derivedFrom`. This file only reads the engine's registry and
 * the repo; it writes nothing.
 */
import { BUILTIN_RULE_PRESETS, BUILTIN_SESSION_PRESETS, builtinRulePreset, parseRulePreset } from '@omniswim/engine';
import type { RulePreset, SessionPreset } from '@omniswim/engine';
import type { StorageRepo } from './repo';
import type { PresetRef, RulePresetRecord, SessionPresetRecord } from './schema';

/** One row of a preset picker. Built-ins come first, then the user's presets by name. */
export type PresetChoice =
  | { readonly source: 'builtin'; readonly ref: Extract<PresetRef, { kind: 'builtin' }>; readonly label: string }
  | { readonly source: 'user'; readonly ref: Extract<PresetRef, { kind: 'user' }>; readonly label: string; readonly rev: number };

/**
 * The newest version of each built-in id, in registry order. A picker offers only these: an older
 * version (nsisc v1, whose points are pending) stays resolvable by its ref for anything saved
 * against it, and a user copy of it shows "v2 available" (D3 5.8).
 */
export function latestBuiltins<B extends { readonly id: string; readonly version: number }>(registry: readonly B[]): B[] {
  return registry.filter(b => !registry.some(o => o.id === b.id && o.version > b.version));
}

/** The newest version of every built-in rule preset, then every stored user rule preset. A fresh install lists only built-ins. */
export async function listRulePresetChoices(repo: StorageRepo): Promise<PresetChoice[]> {
  const builtins = latestBuiltins(BUILTIN_RULE_PRESETS).map((b): PresetChoice => ({ source: 'builtin', ref: { kind: 'builtin', id: b.id, version: b.version }, label: b.label }));
  const users = (await repo.list('rulePresets', undefined)) as RulePresetRecord[];
  return [...builtins, ...users.sort((a, b) => a.name.localeCompare(b.name)).map((u): PresetChoice => ({ source: 'user', ref: { kind: 'user', id: u.id }, label: u.name, rev: u.rev }))];
}

export async function listSessionPresetChoices(repo: StorageRepo): Promise<PresetChoice[]> {
  const builtins = latestBuiltins(BUILTIN_SESSION_PRESETS).map((b): PresetChoice => ({ source: 'builtin', ref: { kind: 'builtin', id: b.id, version: b.version }, label: b.label }));
  const users = (await repo.list('sessionPresets', undefined)) as SessionPresetRecord[];
  return [...builtins, ...users.sort((a, b) => a.name.localeCompare(b.name)).map((u): PresetChoice => ({ source: 'user', ref: { kind: 'user', id: u.id }, label: u.name, rev: u.rev }))];
}

export type ResolvedPreset<P> = { found: false } | { found: true; value: P; rev?: number };

/**
 * The preset a ref names. A missing user preset or an unknown built-in id or version gives
 * `{found:false}`: never another version, never an empty preset.
 */
export async function resolveRulePreset(repo: StorageRepo, ref: PresetRef): Promise<ResolvedPreset<RulePreset>> {
  if (ref.kind === 'builtin') {
    const value = builtinRulePreset(ref.id, ref.version);
    return value === undefined ? { found: false } : { found: true, value };
  }
  const got = await repo.get('rulePresets', ref.id);
  // A preset saved before payload v2 migrates on read, with `ties` pending, and one saved before payload v3
  // with `relayOverCap` pending: no rule is assumed, so it cannot score until someone sets it (D2 3.4, README R67).
  // A payload the parser refuses throws.
  return got.found ? { found: true, value: parseRulePreset(got.value.payload), rev: got.value.rev } : { found: false };
}

export async function resolveSessionPreset(repo: StorageRepo, ref: PresetRef): Promise<ResolvedPreset<SessionPreset>> {
  if (ref.kind === 'builtin') {
    const value = BUILTIN_SESSION_PRESETS.find(b => b.id === ref.id && b.version === ref.version)?.preset;
    return value === undefined ? { found: false } : { found: true, value };
  }
  const got = await repo.get('sessionPresets', ref.id);
  return got.found ? { found: true, value: got.value.payload, rev: got.value.rev } : { found: false };
}

/**
 * "Based on NSISC v1; v2 available": the newer built-in version a user copy could move to, or
 * `null` when the copy has no `derivedFrom`, the built-in is gone, or the copy is current.
 */
export function newerBuiltinVersion(
  kind: 'rule' | 'session',
  derivedFrom: { readonly builtinId: string; readonly builtinVersion: number } | undefined,
  /** The built-ins to compare with. Defaults to the engine's registry for `kind`. A test passes its own. */
  registry: readonly { readonly id: string; readonly version: number }[] = kind === 'rule' ? BUILTIN_RULE_PRESETS : BUILTIN_SESSION_PRESETS
): number | null {
  if (derivedFrom === undefined) return null;
  const versions = registry.filter(b => b.id === derivedFrom.builtinId).map(b => b.version);
  const newest = versions.length === 0 ? undefined : Math.max(...versions);
  return newest !== undefined && newest > derivedFrom.builtinVersion ? newest : null;
}
