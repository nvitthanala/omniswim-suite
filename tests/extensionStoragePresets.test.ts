/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 5.8, T-P1: built-in presets live in code and are never copied into IndexedDB.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_RULE_PRESETS, BUILTIN_SESSION_PRESETS, builtinRulePreset, requireComplete } from '@omniswim/engine';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import {
  latestBuiltins,
  listRulePresetChoices,
  listSessionPresetChoices,
  newerBuiltinVersion,
  resolveRulePreset,
  resolveSessionPreset,
} from '../apps/extension/src/storage/presets';
import type { RulePresetRecord } from '../apps/extension/src/storage/schema';
import { dumpDb, freshFactory, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, withoutRev } from './helpers/extensionRecords';

async function fresh() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: () => 'install-1' });
  return { db, repo: createStorageRepo(db, { now: steppingClock() }) };
}

describe('built-in presets are code, not data (D3 5.8)', () => {
  it('T-P1: on a fresh database list("rulePresets") is empty and the picker still offers NSISC', async () => {
    const { db, repo } = await fresh();
    expect(await repo.list('rulePresets')).toEqual([]);
    expect(await repo.list('sessionPresets')).toEqual([]);

    const choices = await listRulePresetChoices(repo);
    expect(choices.map(c => c.label)).toEqual(['NSISC', 'Generic NCAA championship']);
    // The picker offers the newest version of each built-in only (nsisc v5, R42; generic v2, Rule 5-7-1-g); older versions stay resolvable by ref.
    expect(choices[0]).toEqual({ source: 'builtin', ref: { kind: 'builtin', id: 'nsisc', version: 5 }, label: 'NSISC' });
    expect(choices.every(c => c.source === 'builtin')).toBe(true);
    const sessions = await listSessionPresetChoices(repo);
    expect(sessions.map(c => c.ref)).toEqual([{ kind: 'builtin', id: 'nsisc-table-c', version: 1 }]);

    // Listing and resolving write nothing: the preset stores and the change counter stay as they were.
    const resolved = await resolveRulePreset(repo, { kind: 'builtin', id: 'nsisc', version: 1 });
    expect(resolved).toEqual({ found: true, value: builtinRulePreset('nsisc', 1) });
    const dump = await dumpDb(db);
    for (const store of ['rulePresets', 'sessionPresets', 'settings', 'meets', 'tags', 'lineups']) expect(dump.stores[store]?.records, store).toEqual([]);
    expect(dump.stores.meta?.records.map(r => (r as { key: string }).key)).toEqual(['db']);
    db.close();
  });

  it('the picker lists built-ins first, then the user presets by name; a ref resolves to the right preset', async () => {
    const { db, repo } = await fresh();
    const base = withoutRev(fixtureRecord<RulePresetRecord>('rulePresets', 0));
    await repo.put('rulePresets', { ...base, id: 'u-b', name: 'Zeta' }, 'new');
    await repo.put('rulePresets', { ...base, id: 'u-a', name: 'Alpha' }, 'new');
    const choices = await listRulePresetChoices(repo);
    expect(choices.map(c => c.label)).toEqual(['NSISC', 'Generic NCAA championship', 'Alpha', 'Zeta']);
    expect(choices[2]).toEqual({ source: 'user', ref: { kind: 'user', id: 'u-a' }, label: 'Alpha', rev: 1 });
    expect(await resolveRulePreset(repo, { kind: 'user', id: 'u-a' })).toMatchObject({ found: true, rev: 1 });
    db.close();
  });

  it('a stored v1 user preset resolves as payload v3 with ties and relayOverCap pending, never a guessed rule', async () => {
    const { db, repo } = await fresh();
    const base = withoutRev(fixtureRecord<RulePresetRecord>('rulePresets', 0));
    expect((base.payload as { payloadVersion: number }).payloadVersion).toBe(1);
    await repo.put('rulePresets', { ...base, id: 'u-v1' }, 'new');
    const got = await resolveRulePreset(repo, { kind: 'user', id: 'u-v1' });
    expect(got.found).toBe(true);
    if (!got.found) throw new Error('expected the stored preset');
    expect(got.value.payloadVersion).toBe(3);
    expect(got.value.scoring.ties.state).toBe('pending');
    expect(got.value.scorers.relayOverCap.state).toBe('pending');
    // Every other setting is carried over unchanged.
    const { ties: _ties, ...scoring } = got.value.scoring;
    const { relayOverCap: _relayOverCap, ...scorers } = got.value.scorers;
    const stored = base.payload as unknown as RulePresetRecord['payload'];
    expect(scoring).toEqual(stored.scoring);
    expect(scorers).toEqual(stored.scorers);
    expect(() => requireComplete(got.value)).toThrow(/scoring.ties/);
    db.close();
  });

  it('a stored v2 user preset resolves as payload v3 with relayOverCap pending and its ties kept', async () => {
    const { db, repo } = await fresh();
    const base = withoutRev(fixtureRecord<RulePresetRecord>('rulePresets', 0));
    const v1 = base.payload as unknown as { scoring: Record<string, unknown> };
    const ties = {
      state: 'set',
      value: 'split',
      provenance: { kind: 'user-stated', statedOn: '2026-10-26', wording: 'Ties split.', where: 'plans/2026-10-25/README.md:69', verbatim: false },
    };
    const payload = { ...v1, payloadVersion: 2, scoring: { ...v1.scoring, ties } };
    await repo.put('rulePresets', { ...base, id: 'u-v2', payload } as unknown as RulePresetRecord, 'new');
    const got = await resolveRulePreset(repo, { kind: 'user', id: 'u-v2' });
    if (!got.found) throw new Error('expected the stored preset');
    expect(got.value.payloadVersion).toBe(3);
    expect(got.value.scoring.ties).toEqual(ties);
    expect(got.value.scorers.relayOverCap.state).toBe('pending');
    const { relayOverCap: _relayOverCap, ...scorers } = got.value.scorers;
    expect(scorers).toEqual((v1 as unknown as RulePresetRecord['payload']).scorers);
    db.close();
  });

  it('an unknown ref resolves to {found:false}: no fallback version, no empty preset', async () => {
    const { db, repo } = await fresh();
    expect(await resolveRulePreset(repo, { kind: 'builtin', id: 'nsisc', version: 99 })).toEqual({ found: false });
    // An older version is not offered by the picker but still resolves to itself, never to v2.
    expect(await resolveRulePreset(repo, { kind: 'builtin', id: 'nsisc', version: 1 })).toEqual({ found: true, value: builtinRulePreset('nsisc', 1) });
    expect(await resolveRulePreset(repo, { kind: 'builtin', id: 'nope', version: 1 })).toEqual({ found: false });
    expect(await resolveRulePreset(repo, { kind: 'user', id: 'gone' })).toEqual({ found: false });
    expect(await resolveSessionPreset(repo, { kind: 'builtin', id: 'nsisc-table-c', version: 1 })).toMatchObject({ found: true });
    expect(await resolveSessionPreset(repo, { kind: 'user', id: 'gone' })).toEqual({ found: false });
    db.close();
  });

  it('a user copy is flagged when its built-in has a newer version, and only then', () => {
    const registry = [
      { id: 'nsisc', version: 1 },
      { id: 'nsisc', version: 2 },
      { id: 'generic', version: 1 },
    ];
    expect(newerBuiltinVersion('rule', { builtinId: 'nsisc', builtinVersion: 1 }, registry)).toBe(2);
    expect(newerBuiltinVersion('rule', { builtinId: 'nsisc', builtinVersion: 2 }, registry)).toBeNull();
    expect(newerBuiltinVersion('rule', { builtinId: 'generic', builtinVersion: 1 }, registry)).toBeNull();
    expect(newerBuiltinVersion('rule', { builtinId: 'removed', builtinVersion: 1 }, registry)).toBeNull();
    expect(newerBuiltinVersion('rule', undefined, registry)).toBeNull();
    // Against the engine's own registry: a copy of the newest version of each built-in is current.
    for (const b of latestBuiltins(BUILTIN_RULE_PRESETS)) expect(newerBuiltinVersion('rule', { builtinId: b.id, builtinVersion: b.version })).toBeNull();
    for (const b of latestBuiltins(BUILTIN_SESSION_PRESETS)) expect(newerBuiltinVersion('session', { builtinId: b.id, builtinVersion: b.version })).toBeNull();
    // A copy of nsisc v1 (points pending), v2 (relayOverCap pending), v3 (total cap 8, corrected by R73) or v4 (no R42 relay check) is told that v5 exists.
    expect(newerBuiltinVersion('rule', { builtinId: 'nsisc', builtinVersion: 1 })).toBe(5);
    expect(newerBuiltinVersion('rule', { builtinId: 'nsisc', builtinVersion: 2 })).toBe(5);
    expect(newerBuiltinVersion('rule', { builtinId: 'nsisc', builtinVersion: 3 })).toBe(5);
    expect(newerBuiltinVersion('rule', { builtinId: 'nsisc', builtinVersion: 4 })).toBe(5);
    expect(newerBuiltinVersion('rule', { builtinId: 'generic', builtinVersion: 1 })).toBe(2);
  });

  it('latestBuiltins keeps the newest version of each id, in registry order', () => {
    const registry = [
      { id: 'a', version: 1 },
      { id: 'b', version: 1 },
      { id: 'a', version: 3 },
      { id: 'a', version: 2 },
    ];
    expect(latestBuiltins(registry)).toEqual([{ id: 'b', version: 1 }, { id: 'a', version: 3 }]);
    expect(latestBuiltins(BUILTIN_RULE_PRESETS).map(b => `${b.id}@${b.version}`)).toEqual(['nsisc@5', 'generic@2']);
  });

  it('no storage code seeds a built-in: only presets.ts reads the registries, and it never writes', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'extension', 'src', 'storage');
    const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
    expect(files).toContain('presets.ts');
    const users = files.filter(f => /BUILTIN_(RULE|SESSION)_PRESETS|builtinRulePreset/.test(readFileSync(path.join(dir, f), 'utf8')));
    expect(users).toEqual(['presets.ts']);
    expect(readFileSync(path.join(dir, 'presets.ts'), 'utf8')).not.toMatch(/\.(put|add|putCache|delete)\(/);
  });
});
