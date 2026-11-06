/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P2 exit gate (plans/2026-10-25/01-REDESIGN-PLAN.md, section 3.3 "Parity check, built in"):
 * the engine re-scores each recorded simulator configuration and reproduces SwimCloud's own scores.
 *
 * Each recorded config (A to D, `tests/fixtures/swimcloud/simulator/`) becomes a `SimSnapshot` through
 * the real zod schema. The adapter reads it, the preset comes from the snapshot's own SwimCloud settings
 * (tie rule `'ordered'`: places by position, a tie broken by entry order), the lineup is the page's
 * own entries, and `scoreMeet` scores it.
 *
 * Every config is strict: no pinned divergence. Team totals equal `totalScores`, every entry the page
 * stated has the points the page recorded, and the engine's not-scored reasons agree with what the page
 * recorded (a recorded 0 is an over-cap entry, an unset entry is past the point table).
 */
import { describe, expect, it } from 'vitest';
import { rescoreSimulator } from '@omniswim/swimcloud/browser';
import type { ParityReport } from '@omniswim/swimcloud/browser';
import { buildSnapshot, type ConfigName } from './helpers/simulatorFixtures';

const NAMES: readonly ConfigName[] = ['A', 'B', 'C', 'D'];

const cache = new Map<ConfigName, ReturnType<typeof compute>>();
/** Lazy and memoized: a throw lands in the test that asked, not at collection time. */
function score(name: ConfigName) {
  let hit = cache.get(name);
  if (!hit) {
    hit = compute(name);
    cache.set(name, hit);
  }
  return hit;
}

function compute(name: ConfigName) {
  const { config, snapshot } = buildSnapshot(name);
  const outcome = rescoreSimulator(snapshot, { meetKey: `parity-${name}`, snapshotId: `fixture-${name}` });
  if (outcome.kind !== 'scored') throw new Error(`config ${name}: expected a scored outcome, got ${outcome.kind}`);
  if (outcome.parity.kind !== 'compared') throw new Error(`config ${name}: the snapshot carried no totals`);
  return { config, outcome, parity: outcome.parity as Extract<ParityReport, { kind: 'compared' }> };
}

describe('simulator parity: engine equals SwimCloud, configs A to D', () => {
  for (const name of NAMES) {
    describe(`config ${name}`, () => {
      it('teams[].points equal the recorded totals', () => {
        const { config, outcome } = score(name);
        const recorded = Object.entries(config.totalScores);
        expect(outcome.results.teams).toHaveLength(recorded.length);
        for (const [teamId, total] of recorded) {
          expect(outcome.results.teams.find((t) => t.teamId === teamId)?.points, `team ${teamId}`).toBe(total.points);
        }
      });

      it('every stated entry has the points SwimCloud recorded, and the parity report says so', () => {
        const { parity } = score(name);
        expect(parity.differingEvents.map((e) => e.eventKey)).toEqual([]);
        expect(parity.teams.every((t) => t.match && t.difference === 0)).toBe(true);
        expect(parity.matches).toBe(true);
        const rows = parity.events.flatMap((e) => e.rows);
        expect(rows.filter((r) => r.status === 'match').length).toBeGreaterThan(0);
      });

      it('an entry the page left unset is past the point table, and the engine scores it 0 with that reason', () => {
        const { parity } = score(name);
        for (const r of parity.events.flatMap((e) => e.rows).filter((x) => x.observed === null)) {
          expect(r.status, r.entryKey).toBe('not_stated');
          expect(r.engine).toBe(0);
          expect(r.engineReason).toBe('outside_point_table');
        }
      });

      it('an entry the page recorded as 0 is over the per-team cap, and the engine says so', () => {
        const { parity } = score(name);
        for (const e of parity.events) {
          for (const r of e.rows.filter((x) => x.observed === 0)) {
            const relay = r.swimmerId === null;
            expect(r.engineReason, `${name} ${r.entryKey}`).toBe(relay ? 'relay_scorer_cap' : 'event_scorer_cap');
          }
        }
      });

      it('an entry the page scored carries no not-scored reason', () => {
        const { parity } = score(name);
        for (const r of parity.events.flatMap((e) => e.rows).filter((x) => (x.observed ?? 0) > 0)) {
          expect(r.engineReason, `${name} ${r.entryKey}`).toBeUndefined();
        }
      });
    });
  }

  it('the configs reach what they claim: unset entries in B, capped entries in D, relays and dives everywhere', () => {
    const rows = (name: ConfigName) => score(name).parity.events.flatMap((e) => e.rows);
    expect(rows('B').filter((r) => r.observed === null).length).toBeGreaterThan(0);
    expect(rows('D').filter((r) => r.observed === 0).length).toBeGreaterThan(0);
    for (const name of NAMES) {
      const keys = score(name).parity.events.map((e) => e.eventKey);
      expect(keys.some((k) => k.endsWith('Relay')), `${name} relays`).toBe(true);
      expect(keys.some((k) => /Diving/.test(k)), `${name} diving`).toBe(true);
    }
  });

  it('the two events that carried tied times in B, C and D are in the compared set', () => {
    for (const name of ['B', 'C', 'D'] as const) {
      const keys = score(name).parity.events.map((e) => e.eventKey);
      expect(keys).toContain('100 Breaststroke');
      expect(keys).toContain('100 Freestyle');
    }
  });
});
