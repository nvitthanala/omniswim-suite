/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure-detector tests for the `PUT /api/workspaces/:id` data-loss guard.
 *
 * On 2026-09-22 a workspace held 550 men's meet results at 14:05 and 0
 * afterwards, and nothing warned the user. A startup backup existed but was
 * never surfaced. These tests pin the detection rule agreed for the fix:
 * warn on a sharp drop (previous >= 20 and next is 0 or less than half of
 * previous), and never flag a collection the patch did not touch.
 */
import { describe, expect, it } from 'vitest';
import {
  collectionCounts,
  detectSharpDrops,
  isSharpDrop,
  type CollectionCounts,
} from '../apps/shell/lib/dataLossGuard';

describe('isSharpDrop', () => {
  it('flags a full wipe of a large collection', () => {
    expect(isSharpDrop(550, 0)).toBe(true);
  });

  it('flags a large non-zero drop past half of the previous count', () => {
    // NOTE: 550 -> 300 does NOT qualify under this rule (300 > 275, the
    // halfway point of 550) -- 300 retains 55% of the collection. Using
    // 550 -> 200 instead, which is unambiguously past half.
    expect(isSharpDrop(550, 200)).toBe(true);
  });

  it('does not flag a small trim that stays above half', () => {
    expect(isSharpDrop(30, 20)).toBe(false);
  });

  it('does not flag a wipe of a collection that was already small', () => {
    expect(isSharpDrop(10, 0)).toBe(false);
  });

  it('does not flag growth', () => {
    expect(isSharpDrop(550, 600)).toBe(false);
  });

  it('flags exactly at the previous >= 20 boundary', () => {
    expect(isSharpDrop(20, 0)).toBe(true);
    expect(isSharpDrop(19, 0)).toBe(false);
  });

  it('flags exactly at the half boundary (< half, not <=)', () => {
    expect(isSharpDrop(20, 10)).toBe(false); // exactly half — not "less than half"
    expect(isSharpDrop(20, 9)).toBe(true);
  });
});

describe('detectSharpDrops', () => {
  it('reports a men\'s-results wipe (550 -> 0)', () => {
    const previous: CollectionCounts = { menResults: 550, womenResults: 400 };
    const incoming: CollectionCounts = { menResults: 0 };
    expect(detectSharpDrops(previous, incoming)).toEqual([
      { collection: 'menResults', from: 550, to: 0 },
    ]);
  });

  it('reports a men\'s-results drop past half (550 -> 200)', () => {
    const previous: CollectionCounts = { menResults: 550 };
    const incoming: CollectionCounts = { menResults: 200 };
    expect(detectSharpDrops(previous, incoming)).toEqual([
      { collection: 'menResults', from: 550, to: 200 },
    ]);
  });

  it('does not report a small trim (30 -> 20)', () => {
    const previous: CollectionCounts = { menResults: 30 };
    const incoming: CollectionCounts = { menResults: 20 };
    expect(detectSharpDrops(previous, incoming)).toEqual([]);
  });

  it('does not report a wipe of an already-small collection (10 -> 0)', () => {
    const previous: CollectionCounts = { menResults: 10 };
    const incoming: CollectionCounts = { menResults: 0 };
    expect(detectSharpDrops(previous, incoming)).toEqual([]);
  });

  it('does not report growth', () => {
    const previous: CollectionCounts = { menResults: 550 };
    const incoming: CollectionCounts = { menResults: 900 };
    expect(detectSharpDrops(previous, incoming)).toEqual([]);
  });

  it('never reports a collection the patch did not touch', () => {
    // Previous womenResults was 500 but the incoming patch says nothing about
    // it (e.g. a scoringSettings-only save) — it must not appear as a drop
    // even though, read on its own, "500 -> 0" would qualify.
    const previous: CollectionCounts = { menResults: 550, womenResults: 500 };
    const incoming: CollectionCounts = { menResults: 0 };
    const drops = detectSharpDrops(previous, incoming);
    expect(drops).toEqual([{ collection: 'menResults', from: 550, to: 0 }]);
    expect(drops.some(d => d.collection === 'womenResults')).toBe(false);
  });

  it('judges each collection independently in the same patch', () => {
    const previous: CollectionCounts = { menResults: 550, womenResults: 400, athleteHistory: 200 };
    const incoming: CollectionCounts = { menResults: 0, womenResults: 390, athleteHistory: 5 };
    const drops = detectSharpDrops(previous, incoming);
    expect(drops).toEqual([
      { collection: 'menResults', from: 550, to: 0 },
      { collection: 'athleteHistory', from: 200, to: 5 },
    ]);
  });

  it('treats a missing previous count as 0 (new collection, no drop possible)', () => {
    const previous: CollectionCounts = {};
    const incoming: CollectionCounts = { menResults: 0 };
    expect(detectSharpDrops(previous, incoming)).toEqual([]);
  });
});

describe('collectionCounts', () => {
  it('counts arrays present on the source', () => {
    expect(
      collectionCounts({
        menResults: [1, 2, 3] as never,
        womenResults: [] as never,
      })
    ).toEqual({ menResults: 3, womenResults: 0 });
  });

  it('omits collections the source does not carry at all', () => {
    expect(collectionCounts({ menResults: [1] as never })).toEqual({ menResults: 1 });
  });

  it('returns an empty object for null/undefined', () => {
    expect(collectionCounts(undefined)).toEqual({});
    expect(collectionCounts(null)).toEqual({});
  });

  it('ignores a non-array value under a watched key', () => {
    expect(collectionCounts({ menResults: 'not-an-array' } as never)).toEqual({});
  });
});
