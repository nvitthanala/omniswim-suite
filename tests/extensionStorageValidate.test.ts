/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 5.4 and 5.6 rule 3: what a record must be before it reaches IndexedDB, through
 * `put`, `putCache` or `importData`. T-E5 and T-E6 (import path) live in extensionStorageExport.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { builtinRulePreset } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { validateLineup, validateRecord } from '../apps/extension/src/storage/validate';
import { BUNDLED_SOURCE_MANIFESTS, BUNDLED_TOOL_ARCHIVES, publishedSourceProblem, toolArchiveProblem } from '../apps/extension/src/storage/sourceManifests';
import { EDITED_STORES, SETTINGS_DEFAULTS, STORE_NAMES, USER_STORES, toSwimCloudId } from '../apps/extension/src/storage/schema';
import type { UserStore } from '../apps/extension/src/storage/schema';
import { fixtureRecord, fixtureRecords, hasFixtureStore, removeAt, setAt } from './helpers/extensionRecords';
import { withNumericSwimmerIds } from './helpers/numericSnapshot';
import { buildSnapshot } from './helpers/simulatorFixtures';

const paths = (store: UserStore, record: unknown): string[] => validateRecord(store, record).map(i => i.path);

describe('extension storage validation (D3 5.4)', () => {
  it('accepts every record in the v1 fixture, in every store it has', () => {
    let seen = 0;
    for (const store of USER_STORES) {
      // The class-year store is new in v2, so the v1 fixture has no list for it.
      if (!hasFixtureStore(store, 1)) continue;
      for (const record of fixtureRecords(store)) {
        expect(validateRecord(store, record), `${store} fixture record`).toEqual([]);
        seen += 1;
      }
    }
    expect(seen).toBe(13);
  });

  it('accepts every record in the v2 fixture, in every store: a draft meet, a verified-empty roster, class years and an override', () => {
    let seen = 0;
    for (const store of USER_STORES) {
      for (const record of fixtureRecords(store, 2)) {
        expect(validateRecord(store, record), `${store} fixture record`).toEqual([]);
        seen += 1;
      }
    }
    expect(seen).toBe(17);
  });

  it('lists the stores and splits them into user, edited and cache stores', () => {
    expect([...STORE_NAMES]).toHaveLength(10);
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
    it('accepts a tool-derived value only when it cites an archive a built-in cites, with the same sha256', () => {
      const where = ['payload', 'scoring', 'individualPoints', 'provenance'];
      const [path, sha256] = [...BUNDLED_TOOL_ARCHIVES.entries()][0] as [string, string];
      const toolDerived = (archive: unknown) => ({
        kind: 'tool-derived',
        tool: { name: 'SwimSwam Swimming Time Conversion Tool', url: 'https://swimswam.com/swimming-times-conversion-tool/' },
        archive,
        capturedOn: '2026-10-26',
        basis: 'inferred-from-tool-outputs',
      });
      expect(validateRecord('rulePresets', setAt(fixtureRecord('rulePresets', 1), where, toolDerived({ path, sha256 })))).toEqual([]);
      const cases: [string, unknown][] = [
        ['unknown archive', { path: 'data/conversions/made-up.json', sha256 }],
        // The simulator preset is parity-only: a stored value may never cite its archive.
        ['simulator archive', { path: 'data/swimcloud-captures/simulator/simulator.1792676876.js', sha256: '93f6be650c703f41b3ac5f01d1614cfcfe2160b2bf0b3220e140f1987b69c6da' }],
        ['wrong sha256', { path, sha256: '0'.repeat(64) }],
      ];
      for (const [label, archive] of cases) {
        expect(paths('rulePresets', setAt(fixtureRecord('rulePresets', 1), where, toolDerived(archive))), label).toEqual([`$.${where.join('.')}.archive`]);
      }
    });
    it('reads the tool archives from the engine built-ins: the SwimSwam LCM to SCY capture only', () => {
      expect([...BUNDLED_TOOL_ARCHIVES.keys()]).toEqual(['data/conversions/swimswam/lcm-to-scy-2026-10-26.json']);
      for (const [path, sha256] of BUNDLED_TOOL_ARCHIVES) expect(toolArchiveProblem({ path, sha256 })).toBeNull();
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

  describe('display entry times: a dive score is points, a swim time is a clock time', () => {
    const DIVE_KEY = 'i|48|1001|1-Meter Diving|Women';
    const SWIM_KEY = 'i|48|1001|100 Freestyle|Women';
    /** The first fixture lineup with one more entry, a 1-meter dive by the same swimmer, and the given display texts. */
    const withTimes = (times: Record<string, { text: string; hundredths: number }>): unknown => {
      const base = fixtureRecord<{ payload: { entries: unknown[]; display: { entryTimes: Record<string, unknown> } } }>('lineups', 0);
      base.payload.entries.push({ kind: 'individual', teamId: '48', swimmerId: '1001', eventKey: '1-Meter Diving', gender: 'Women', seedSwimId: null });
      base.payload.display.entryTimes = { [SWIM_KEY]: { text: '50.00', hundredths: 5000 }, ...times };
      return base;
    };
    it('accepts a dive score of three digits on a diving entry, as the adapter writes it', () => {
      expect(validateRecord('lineups', withTimes({ [DIVE_KEY]: { text: '504.60', hundredths: 50460 } }))).toEqual([]);
      expect(validateRecord('lineups', withTimes({ [DIVE_KEY]: { text: '95.05', hundredths: 9505 } }))).toEqual([]);
    });
    it('refuses a dive score that disagrees with its hundredths, or is not points with two decimals', () => {
      expect(validateRecord('lineups', withTimes({ [DIVE_KEY]: { text: '504.60', hundredths: 50461 } }))).toHaveLength(1);
      expect(validateRecord('lineups', withTimes({ [DIVE_KEY]: { text: '504.6', hundredths: 50460 } }))).toHaveLength(1);
      expect(validateRecord('lineups', withTimes({ [DIVE_KEY]: { text: '8:24.60', hundredths: 50460 } }))).toHaveLength(1);
      expect(validateRecord('lineups', withTimes({ [DIVE_KEY]: { text: 'NT', hundredths: 0 } }))).toHaveLength(1);
    });
    it('refuses a score-form text on a swim entry: 75.00 is not a swim time', () => {
      expect(validateRecord('lineups', withTimes({ [SWIM_KEY]: { text: '75.00', hundredths: 7500 } }))).toHaveLength(1);
      expect(validateRecord('lineups', withTimes({ [SWIM_KEY]: { text: '1:15.00', hundredths: 7500 } }))).toEqual([]);
    });
    it('keeps the time rule for a display key that matches no entry, even when it names a dive', () => {
      expect(validateRecord('lineups', withTimes({ 'i|48|9999|1-Meter Diving|Women': { text: '504.60', hundredths: 50460 } }))).toHaveLength(1);
    });
    it('accepts the display of every recorded simulator config (each has a dive entry)', () => {
      for (const name of ['A', 'B', 'C', 'D'] as const) {
        const adapted = adaptSimulatorSnapshot(withNumericSwimmerIds(buildSnapshot(name).snapshot), { meetKey: `m-${name}`, snapshotId: 'x' });
        if (adapted.kind !== 'ready') throw new Error(`config ${name} did not adapt: ${adapted.kind}`);
        const lineup = adapted.adapted.lineup;
        expect(Object.values(lineup.display?.entryTimes ?? {}).some((t) => Number(t.text.split('.')[0]) > 59), `config ${name} has a dive score`).toBe(true);
        expect(() => validateLineup(lineup, '$'), `config ${name}`).not.toThrow();
      }
    });
  });

  describe('rule payload version 3 (README R67)', () => {
    // A user copy of NSISC v3 is the first thing the preset editor saves. JSON round-trip: storage holds plain data.
    const v3 = JSON.parse(JSON.stringify(builtinRulePreset('nsisc', 3))) as { payloadVersion: number; scorers: Record<string, unknown> };
    it('the NSISC v3 built-in is a version 3 payload with relayOverCap set', () => {
      expect(v3.payloadVersion).toBe(3);
      expect(v3.scorers.relayOverCap).toMatchObject({ state: 'set', value: 'exhibition' });
    });
    it('accepts a version 3 payload as a stored rule preset and as a lineup snapshot', () => {
      expect(validateRecord('rulePresets', setAt(fixtureRecord('rulePresets', 1), ['payload'], v3))).toEqual([]);
      expect(validateRecord('lineups', setAt(fixtureRecord('lineups', 0), ['builtUnder', 'rulePresetValues'], v3))).toEqual([]);
    });
    it('rejects a version 3 payload with an unknown relayOverCap value', () => {
      const bad = setAt(v3, ['scorers', 'relayOverCap', 'value'], 'drop');
      expect(validateRecord('rulePresets', setAt(fixtureRecord('rulePresets', 1), ['payload'], bad))).toHaveLength(1);
    });
  });
});
