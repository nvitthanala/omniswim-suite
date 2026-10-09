/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An optimizer Undo must expire when the coach fills a relay leg after the run.
 *
 * The defect: the Undo fingerprint covered the three optimizer-owned arrays and nothing else. The
 * optimizer writes scorer flags (`scorerRosterOverrides`). A coach who fills a relay leg with a
 * swimmer the run made a scorer left the fingerprint "clean". Undo then flipped the swimmer back to
 * non-scorer and kept the fill. That is the state `applyScorerOffRelayPatch` prunes when a coach
 * toggles a scorer off by hand, and it has a cost: a relay that is not an A or B final scores only
 * when every leg is a scorer (`relayEntryRosterEligible`), so the relay silently scored 0.
 *
 * Fixture: the real 2026 NSISC meet (relayLegEventMatching.test.ts). Reid Remmert (HSU men) swam only
 * C finals, so the auto rules do not make him a scorer. HSU's 400 Free Relay B is re-labelled a
 * prelims relay here so that its eligibility depends on its legs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender, type RelayLegOverride, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { simulateRoster } from '../packages/core/src/lib/utils';
import { buildScorerRosterLookup, relayEntryRosterEligible } from '../packages/core/src/lib/scorerRoster';
import { mergeScoringSettings, NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import {
  buildOptimizerUndo,
  optimizerArraysOf,
  optimizerUndoState,
  optimizerUndoTargetReached,
} from '../packages/manager/src/components/optimizerUndo';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const REID = 'Reid Remmert';
const settings = mergeScoringSettings(NSISC_PRESET_SETTINGS, { conference: 'NSISC' });

const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-leg-event-matching.json'), 'utf8')
) as { menResults: SwimmerResult[] };
const results = fixture.menResults.map(r =>
  r.isRelay && r.team === HSU && r.rank === 10 ? { ...r, roundSwam: 'Preliminaries' } : r
);
const template = results.find(
  r => r.isRelay && r.team === HSU && r.rank === 10 && r.event.includes('Freestyle Relay')
)!;
const fill: RelayLegOverride = {
  relayEntryKey: relayEntryKey(template),
  legIndex: 3,
  assigneeName: REID,
  source: 'manual',
};
const reidOn = { team: HSU, gender: Gender.MEN, name: REID, isScorer: true };

/** What the HSU relay looks like under the given scorer flags, with Colton Bennett's anchor leg filled by `fill`. */
function relayUnder(scorerRosterOverrides: Array<typeof reidOn>) {
  const lookup = buildScorerRosterLookup(results, settings, scorerRosterOverrides, Gender.MEN);
  const out = simulateRoster(results, [], false, new Set(['colton bennett']), [fill]);
  const group = out.filter(r => r.isRelay && r.team === HSU && r.event === template.event && r.rank === 10);
  return {
    anchor: group.find(r => r.relayLegIndex === 3)?.name,
    eligible: relayEntryRosterEligible(group, settings, lookup),
    reidIsScorer: lookup.isScorer(REID, HSU, Gender.MEN),
  };
}

/** The optimizer marks Reid a scorer: the run's arrays differ from the pre-run arrays only in that flag. */
const before = { scorerRosterOverrides: [], meetEntryPlans: [], activeEntryIds: [] };
const applied = { scorerRosterOverrides: [reidOn], meetEntryPlans: [], activeEntryIds: [] };
const undo = buildOptimizerUndo({
  label: 'HSU',
  workspaceId: 'ws-hsu',
  before: { ...optimizerArraysOf(before), relayOverrides: [] },
  applied,
});

describe('optimizer Undo and relay leg fills', () => {
  it('fixture precondition: Undo flips Reid to a non-scorer, and the relay then scores nothing with him on it', () => {
    expect(relayUnder(applied.scorerRosterOverrides)).toEqual({ anchor: REID, eligible: true, reidIsScorer: true });
    expect(relayUnder(before.scorerRosterOverrides)).toEqual({ anchor: REID, eligible: false, reidIsScorer: false });
  });

  it('is clean right after the run', () => {
    expect(optimizerUndoState(undo, optimizerArraysOf(applied))).toBe('clean');
  });

  it('is not clean once a relay leg is filled after the run', () => {
    const afterFill = { ...applied, relayLegOverrides: [fill] };
    expect(optimizerUndoState(undo, optimizerArraysOf(afterFill))).toBe('changed');
  });

  it('never lets an Undo through that leaves a relay fill naming a non-scorer', () => {
    const afterFill = { ...applied, relayLegOverrides: [fill] };
    const guardAllowsUndo = optimizerUndoState(undo, optimizerArraysOf(afterFill)) === 'clean';
    const afterUndo = relayUnder(before.scorerRosterOverrides);
    const fillNamesNonScorer = afterUndo.anchor === REID && !afterUndo.reidIsScorer;
    expect(guardAllowsUndo && fillNamesNonScorer).toBe(false);
  });

  it('relay overrides that were already there before the run do not block the Undo', () => {
    const existing = { relayLegOverrides: [fill] };
    const armed = buildOptimizerUndo({
      label: 'HSU',
      workspaceId: 'ws-hsu',
      before: { ...optimizerArraysOf({ ...before, ...existing }) },
      applied,
    });
    const live = { ...applied, ...existing } as unknown as Workspace;
    expect(optimizerUndoState(armed, optimizerArraysOf(live))).toBe('clean');
    // After Undo writes the pre-run arrays, the unchanged relay overrides must read as "target reached".
    const undone = { ...armed.patch, ...existing } as unknown as Workspace;
    expect(optimizerUndoTargetReached(armed, optimizerArraysOf(undone))).toBe(true);
    expect(optimizerUndoState(armed, optimizerArraysOf(undone))).toBe('apply_not_saved');
  });
});
