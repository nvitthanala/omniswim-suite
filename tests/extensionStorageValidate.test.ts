/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 5.4 and 5.6 rule 3: what a record must be before it reaches IndexedDB, through
 * `put`, `putCache` or `importData`. T-E5 and T-E6 (import path) live in extensionStorageExport.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { validateRecord } from '../apps/extension/src/storage/validate';
import { BUNDLED_SOURCE_MANIFESTS, publishedSourceProblem } from '../apps/extension/src/storage/sourceManifests';
import { EDITED_STORES, SETTINGS_DEFAULTS, STORE_NAMES, USER_STORES, toSwimCloudId } from '../apps/extension/src/storage/schema';
import type { UserStore } from '../apps/extension/src/storage/schema';
import { fixtureRecord, fixtureRecords, removeAt, setAt } from './helpers/extensionRecords';

const paths = (store: UserStore, record: unknown): string[] => validateRecord(store, record).map(i => i.path);

describe('extension storage validation (D3 5.4)', () => {
  it('accepts every record in the v1 fixture, in every store', () => {
    let seen = 0;
    for (const store of USER_STORES) {
      for (const record of fixtureRecords(store)) {
        expect(validateRecord(store, record), `${store} fixture record`).toEqual([]);
        seen += 1;
      }
    }
    expect(seen).toBe(13);
  });

  it('lists the stores and splits them into user, edited and cache stores', () => {
    expect([...STORE_NAMES]).toHaveLength(9);
    expect([...USER_STORES]).toEqual(STORE_NAMES.filter(s => s !== 'meta'));
    expect([...EDITED_STORES]).toEqual(USER_STORES.filter(s => s !== 'swimmerHistory' && s !== 'rosters'));
  });

  describe('a missing cap is never unlimited', () => {
    const preset = () => fixtureRecord('rulePresets', 0);
    it('rejects a cap setting with no value', () => {
      const bad = removeAt(preset(), ['payload', 'entries', 'maxTotalPerSwimmer', 'value']);
      expect(paths('rulePresets', bad)).toEqual(['$.payload.entries.maxTotalPerSwimmer.value']);
    });
    it('rejects a cap that is null, undefined-as-missing, a numeric string, negative, or 999 and up', () => {
      for (const cap of [null, '8', -1, 999, 1000, 2.5, 'Unlimited']) {
        const bad = setAt(preset(), ['payload', 'entries', 'maxTotalPerSwimmer', 'value'], cap);
        expect(validateRecord('rulePresets', bad), String(cap)).toHaveLength(1);
      }
    });
    it('keeps "unlimited" a string, and 0 a real cap', () => {
      expect(validateRecord('rulePresets', setAt(preset(), ['payload', 'entries', 'maxTotalPerSwimmer', 'value'], 'unlimited'))).toEqual([]);
      expect(validateRecord('rulePresets', setAt(preset(), ['payload', 'entries', 'maxTotalPerSwimmer', 'value'], 0))).toEqual([]);
    });
    it('rejects a per-event cap with no cap, and a lineup snapshot built under such a preset', () => {
      const noCap = setAt(preset(), ['payload', 'scorers', 'perEventScorerCap', 'value'], { overCap: 'holds-place' });
      expect(validateRecord('rulePresets', noCap)).toHaveLength(1);
      const lineup = removeAt(fixtureRecord('lineups', 0), ['builtUnder', 'rulePresetValues', 'entries', 'maxTotalPerSwimmer', 'value']);
      expect(paths('lineups', lineup)).toEqual(['$.builtUnder.rulePresetValues.entries.maxTotalPerSwimmer.value']);
    });
  });

  describe('provenance is never invented or upgraded', () => {
    it('rejects provenance kind "legacy" anywhere in a rule preset', () => {
      const bad = setAt(fixtureRecord('rulePresets', 0), ['payload', 'scoring', 'aFinalBracketSize', 'provenance'], { kind: 'legacy' });
      const issues = validateRecord('rulePresets', bad);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toMatch(/legacy/);
    });
    it('rejects "legacy" inside a user-edited chain and in a session preset', () => {
      const chain = setAt(fixtureRecord('rulePresets', 1), ['payload', 'entries', 'maxTotalPerSwimmer', 'provenance', 'previous'], { kind: 'legacy' });
      expect(validateRecord('rulePresets', chain)).toHaveLength(1);
      const session = setAt(fixtureRecord('sessionPresets', 0), ['payload', 'provenance'], { kind: 'legacy' });
      expect(validateRecord('sessionPresets', session)).toHaveLength(1);
    });
    it('rejects a published source that no bundled manifest lists, a wrong manifest path and a wrong sha256', () => {
      const where = ['payload', 'scoring', 'individualPoints', 'provenance', 'source'];
      const good = fixtureRecord<{ payload: { scoring: { individualPoints: { provenance: { source: Record<string, string> } } } } }>('rulePresets', 1);
      const source = good.payload.scoring.individualPoints.provenance.source;
      expect(validateRecord('rulePresets', good)).toEqual([]);
      const cases: [string, Record<string, string>][] = [
        ['unknown id', { ...source, sourceId: 'not-in-any-manifest' }],
        ['unbundled manifest', { ...source, manifest: 'data/swimcloud-captures/simulator/manifest.json' }],
        ['wrong sha256', { ...source, sha256: '0'.repeat(64) }],
      ];
      for (const [label, replaced] of cases) {
        const issues = validateRecord('rulePresets', setAt(good, where, replaced));
        expect(issues, label).toHaveLength(1);
        expect(issues[0]?.path, label).toBe(`$.${where.join('.')}`);
      }
    });
    it('rejects an unknown published source in the previous link of a user-edited value', () => {
      const bad = setAt(fixtureRecord('rulePresets', 1), ['payload', 'entries', 'maxTotalPerSwimmer', 'provenance', 'previous'], {
        kind: 'published',
        source: { sourceId: 'made-up', manifest: 'data/cutlines/sources/manifest.json', sha256: 'a'.repeat(64), url: 'https://example.com', publisher: 'x' },
      });
      expect(paths('rulePresets', bad)).toEqual(['$.payload.entries.maxTotalPerSwimmer.provenance.previous.source']);
    });
    it('knows the three bundled manifests and accepts a source each lists', () => {
      expect([...BUNDLED_SOURCE_MANIFESTS.keys()].sort()).toEqual([
        'data/cutlines/sources/manifest.json',
        'data/relay-programs/sources/manifest.json',
        'data/scoring_rules/sources/manifest.json',
      ]);
      for (const [manifest, index] of BUNDLED_SOURCE_MANIFESTS) {
        expect(index.size, manifest).toBeGreaterThan(0);
        const [sourceId, sha256] = [...index.entries()][0] as [string, string];
        expect(publishedSourceProblem({ sourceId, manifest, sha256, url: 'https://example.com', publisher: 'x' })).toBeNull();
      }
    });
  });

  describe('absent is not empty', () => {
    it('rejects a swimmer history with an empty payload', () => {
      for (const payload of [null, {}, []]) {
        const bad = setAt(fixtureRecord('swimmerHistory'), ['payload'], payload);
        expect(paths('swimmerHistory', bad), JSON.stringify(payload)).toEqual(['$.payload']);
      }
    });
    it('rejects a roster with no members', () => {
      expect(paths('rosters', setAt(fixtureRecord('rosters'), ['memberIds'], []))).toEqual(['$.memberIds']);
    });
    it('rejects a meet with no teams', () => {
      expect(paths('meets', setAt(fixtureRecord('meets'), ['teamIds'], []))).toEqual(['$.teamIds']);
    });
    it('has no tag role "auto": auto is the absence of a record', () => {
      expect(paths('tags', setAt(fixtureRecord('tags'), ['role'], 'auto'))).toEqual(['$.role']);
    });
    it('has no default for flyoverAllowanceSec or accent, and only the three stated defaults', () => {
      expect(SETTINGS_DEFAULTS).toEqual({ theme: 'light', cutCloseThresholdPct: 1.0, fetchPosture: 'off' });
      expect('flyoverAllowanceSec' in SETTINGS_DEFAULTS).toBe(false);
      expect('accent' in SETTINGS_DEFAULTS).toBe(false);
    });
    it('accepts a flyover setting only as a number the user set, never 0 by default', () => {
      const base = { key: 'flyoverAllowanceSec', rev: 1, updatedAt: '2026-10-26T12:00:00.000Z' };
      expect(validateRecord('settings', { ...base, value: 0.3 })).toEqual([]);
      expect(validateRecord('settings', { ...base, value: null })).toHaveLength(1);
      expect(validateRecord('settings', { ...base, value: '0.3' })).toHaveLength(1);
      expect(validateRecord('settings', { ...base, value: Number.NaN })).toHaveLength(1);
    });
  });

  describe('records are strict JSON', () => {
    it('rejects an unknown key, a missing key and an undefined-valued key', () => {
      expect(paths('meets', { ...fixtureRecord('meets'), extra: 1 })).toEqual(['$.extra']);
      expect(paths('meets', removeAt(fixtureRecord('meets'), ['name']))).toEqual(['$.name']);
      expect(paths('meets', { ...fixtureRecord('meets'), simulatorQuery: undefined })).toEqual(['$.simulatorQuery']);
    });
    it('rejects Date, Map, Set, Infinity and class instances', () => {
      const meet = fixtureRecord('meets');
      for (const value of [new Date(0), new Map(), new Set(), Number.POSITIVE_INFINITY, new (class X {})()]) {
        expect(validateRecord('meets', { ...meet, name: value }), String(value)).toHaveLength(1);
      }
      expect(validateRecord('swimmerHistory', { ...fixtureRecord('swimmerHistory'), payload: { when: new Date(0) } })).toHaveLength(1);
    });
    it('rejects a payloadVersion this build does not read', () => {
      expect(paths('rulePresets', setAt(fixtureRecord('rulePresets'), ['payloadVersion'], 2))).toEqual(['$.payloadVersion']);
      expect(paths('lineups', setAt(fixtureRecord('lineups'), ['payload', 'payloadVersion'], 2))).toEqual(['$.payload.payloadVersion']);
    });
  });

  describe('SwimCloud ids are strings of digits (T-E8 in the export tests covers toSwimCloudId)', () => {
    it('rejects a numeric id, a leading zero and an empty id in tags, rosters and meets', () => {
      for (const id of [123, '0123', '', '12a', ' 12']) {
        expect(validateRecord('tags', { ...fixtureRecord('tags'), swimmerId: id }), String(id)).toHaveLength(1);
        expect(validateRecord('rosters', { ...fixtureRecord('rosters'), memberIds: [id] }), String(id)).toHaveLength(1);
        expect(validateRecord('meets', { ...fixtureRecord('meets'), teamIds: [id] }), String(id)).toHaveLength(1);
      }
      expect(toSwimCloudId('48')).toBe('48');
    });
  });

  describe('lineups', () => {
    it('rejects results on a plain lineup, null results on a snapshot, and a meetKey that differs from the payload', () => {
      expect(paths('lineups', { ...fixtureRecord('lineups', 0), results: { x: 1 } })).toEqual(['$.results']);
      expect(paths('lineups', { ...fixtureRecord('lineups', 1), results: null })).toEqual(['$.results']);
      expect(paths('lineups', setAt(fixtureRecord('lineups', 0), ['meetKey'], 'm-2'))).toEqual(['$.payload.meetKey']);
    });
    it('rejects a relay with the wrong number of legs and an entry time that disagrees with its text', () => {
      const relay = fixtureRecord<{ payload: { entries: { legs?: unknown[] }[] } }>('lineups', 0);
      relay.payload.entries[1]?.legs?.pop();
      expect(paths('lineups', relay)).toEqual(['$.payload.entries[1].legs']);
      const time = setAt(fixtureRecord('lineups', 0), ['payload', 'display', 'entryTimes', 'i|48|1001|100 Freestyle|Women', 'hundredths'], 5001);
      expect(validateRecord('lineups', time)).toHaveLength(1);
    });
  });
});
