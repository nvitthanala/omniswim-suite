/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * useWorkspaceScoring debounce regression tests. Runs the hook through a
 * real React tree (happy-dom, no Worker global so the synchronous fallback
 * path is exercised deterministically) and checks:
 *  - `scoringSettled` flips false synchronously the moment a watched
 *    dependency changes — NOT after the debounce delay. This is the
 *    correctness guard ScenarioSnapshotsPanel's Save gate depends on.
 *  - a burst of rapid changes collapses into exactly ONE recompute.
 *  - `scoringSettled` returns to true once the debounced recompute for the
 *    *last* change in the burst resolves, and the resolved snapshot matches
 *    building fresh from that final state (not an intermediate one).
 */
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import React from 'react';
import { createRoot } from 'react-dom/client';

globalThis.React = React;

function installDom() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  // Node 26 defines `globalThis.navigator` as a getter-only accessor, so a
  // plain assignment throws. Redefine the property instead.
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator,
    configurable: true,
    writable: true,
  });
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  return window;
}

const domWindow = installDom();

// No `Worker` global exists in this Node/happy-dom environment, so
// `useWorkspaceScoring` deterministically takes its synchronous-fallback
// path — the one requirement #2 says must be debounced too.
assert.equal(typeof globalThis.Worker, 'undefined', 'test relies on no Worker global being present');

const { useWorkspaceScoring, SCORING_DEBOUNCE_MS } = await import(
  '../packages/core/src/lib/useWorkspaceScoring.ts'
);
const { buildScoringSnapshot } = await import('../packages/core/src/lib/scoringEngine.ts');
const { Gender } = await import('../packages/core/src/types.ts');
const { NSISC_PRESET_SETTINGS } = await import('../packages/core/src/lib/scoringDefaults.ts');

assert.ok(
  SCORING_DEBOUNCE_MS >= 150 && SCORING_DEBOUNCE_MS <= 250,
  `SCORING_DEBOUNCE_MS should be a ~150-250ms trailing debounce, got ${SCORING_DEBOUNCE_MS}`
);

function indResult(id, name, classYear, time) {
  return {
    id,
    rank: 1,
    name,
    classYear,
    team: 'Team A',
    time,
    points: 0,
    event: '50 Freestyle',
    gender: Gender.MEN,
  };
}

const BASE_WORKSPACE = {
  id: 'w',
  name: 'debounce-test',
  createdAt: 1,
  menResults: [
    indResult('jr1', 'Jordan Reed', 'JR', '20.00'),
    indResult('so1', 'Sam Ortiz', 'SO', '20.50'),
    indResult('sr1', 'Sasha Reyes', 'SR', '21.00'),
  ],
  womenResults: [],
  recruits: [],
  scoringSettings: { ...NSISC_PRESET_SETTINGS },
};

/**
 * Number of scored swims in the projected bundle.
 *
 * Deliberately NOT team point totals: a single-team fixture scores 0 points
 * under the NSISC preset regardless of `removeSeniors`, so totals cannot tell
 * the two states apart. The scored-swim count can — dropping seniors removes
 * the SR swimmer, so this goes 3 -> 2. That is the signal this test needs.
 */
function scoredCount(bundle) {
  return bundle.projected.allScored.length;
}

// Ground truth computed directly from the (un-debounced) engine, so the test
// isn't just checking the hook against itself.
const groundTruthKeepSeniors = buildScoringSnapshot(BASE_WORKSPACE, Gender.MEN, false);
const groundTruthDropSeniors = buildScoringSnapshot(BASE_WORKSPACE, Gender.MEN, true);
assert.notEqual(
  scoredCount(groundTruthKeepSeniors),
  scoredCount(groundTruthDropSeniors),
  'fixture must be set up so removeSeniors actually changes the projected bundle'
);

async function flushEffects(rounds = 2) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let latestResult = null;
const projectedRefs = new Set();
const consoleErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map(String).join(' '));
  originalConsoleError(...args);
};

function Fixture({ removeSeniors }) {
  const result = useWorkspaceScoring({
    workspace: BASE_WORKSPACE,
    gender: Gender.MEN,
    removeSeniors,
    scoringRefreshKey: 0,
  });
  latestResult = result;
  projectedRefs.add(result.projected);
  return null;
}

const container = document.body.appendChild(document.createElement('div'));
const root = createRoot(container);

// --- mount: first computation runs synchronously, no recompute scheduled ---
root.render(React.createElement(Fixture, { removeSeniors: false }));
await flushEffects(3);
assert.equal(latestResult.scoringSettled, true, 'initial mount should be settled (isFirstRun skip)');
assert.equal(projectedRefs.size, 1, 'mount should produce exactly one snapshot');

// --- burst: 6 rapid toggles of `removeSeniors`, ~20ms apart (<< debounce) ---
const BURST_STEPS = [true, false, true, false, true, true]; // final value: true
for (const removeSeniors of BURST_STEPS) {
  root.render(React.createElement(Fixture, { removeSeniors }));
  await flushEffects(2);
  // Regression guard: settled must flip false the instant the effect runs
  // for this change, synchronously — not after SCORING_DEBOUNCE_MS.
  assert.equal(
    latestResult.scoringSettled,
    false,
    'settled must go false immediately on a watched-field change, before the debounce elapses'
  );
  assert.equal(
    projectedRefs.size,
    1,
    'no recompute should have happened yet mid-burst — only the debounced timer may recompute'
  );
  await wait(20);
}

// Still within the debounce window of the *last* burst step.
assert.equal(latestResult.scoringSettled, false, 'still unsettled right after the burst');
assert.equal(projectedRefs.size, 1, 'burst must not have triggered any recompute yet');

// --- past the debounce window: exactly one recompute, using the final state ---
await wait(SCORING_DEBOUNCE_MS + 150);
await flushEffects(4);

assert.equal(latestResult.scoringSettled, true, 'settled must return to true once the debounced recompute resolves');
assert.equal(
  projectedRefs.size,
  2,
  'a burst of 6 rapid changes must collapse into exactly ONE additional recompute (mount snapshot + 1)'
);
assert.equal(
  scoredCount(latestResult),
  scoredCount(groundTruthDropSeniors),
  'resolved snapshot must reflect the LAST burst value (removeSeniors=true), not an intermediate one'
);

// --- unmount cleanup: a pending debounced recompute must not fire after unmount ---
root.render(React.createElement(Fixture, { removeSeniors: false }));
await flushEffects(2);
assert.equal(latestResult.scoringSettled, false, 'settled flips false for the post-burst change too');
root.unmount();
await wait(SCORING_DEBOUNCE_MS + 150);
assert.equal(consoleErrors.length, 0, `expected no console.error after unmount, got: ${consoleErrors.join(' | ')}`);

console.error = originalConsoleError;
domWindow.close();

console.log('workspace scoring debounce tests passed');
