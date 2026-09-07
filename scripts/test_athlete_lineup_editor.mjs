/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Characterization tests for AthleteLineupEditorPanel (packages/manager).
 *
 * Status: this file is in scripts/run-tests.mjs and runs green. The original
 * "UNVERIFIED — NEVER EXECUTED" banner (it was authored in a worktree with no
 * `node_modules`) is retired as of the 2026-08-30 test audit.
 *
 * It remains a CHARACTERIZATION test: it pins what the component DOES, not what
 * it ought to do. If an assertion fails after an intentional behaviour change,
 * update the assertion. If one fails after a refactor that was meant to preserve
 * behaviour, the refactor is wrong.
 *
 * This file exists to pin the drawer's OBSERVABLE behaviour before it is split
 * into smaller components. It deliberately asserts only what the panel renders
 * and what it emits through its props — never internal state, never a hook, and
 * never the identity of the component that happens to own a subtree today. A
 * refactor that preserves behaviour must leave every assertion below untouched.
 *
 * What is pinned:
 *  1. The four collapsible section headings exist.
 *  2. "Individual entries" is expanded on mount; the other three are collapsed
 *     (asserted through aria-expanded AND through the body node being rendered
 *     or absent — no component state is inspected).
 *  3. Clicking a collapsed heading reveals its body; clicking again hides it.
 *  4. `editable` gates the entry-editing controls: the active checkbox, the
 *     event <select>, the remove button and the paste affordance are present
 *     only when editable, and the inline time button is disabled when not.
 *  5. Activating the close control calls `onClose`.
 *  6. Toggling an entry's active checkbox calls `onUpdate` exactly once with a
 *     patch of shape { meetEntryPlans, activeEntryIds }.
 */
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// The repo's .tsx files compile with the classic JSX runtime, so components in
// packages/ui reference a bare `React` at render time. Same line as
// test_chart_render.mjs and test_workspace_scoring_debounce.mjs.
globalThis.React = React;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const window = new Window({ url: 'http://localhost/' });
  const globals = globalThis;
  globals.window = window;
  globals.document = window.document;
  globals.HTMLElement = window.HTMLElement;
  globals.SVGElement = window.SVGElement;
  globals.Element = window.Element;
  globals.Node = window.Node;
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  // Node 26 defines `globalThis.navigator` as a getter-only accessor, so a
  // plain assignment throws. Redefine the property instead.
  Object.defineProperty(globals, 'navigator', {
    value: window.navigator,
    configurable: true,
    writable: true,
  });
  globals.requestAnimationFrame = cb => setTimeout(cb, 0);
  globals.cancelAnimationFrame = id => clearTimeout(id);
  return window;
}

const domWindow = installDom();

const AthleteLineupEditorPanel = (
  await import('../packages/manager/src/components/AthleteLineupEditorPanel.tsx')
).default;
const { Gender } = await import('../packages/core/src/types.ts');
const { NSISC_PRESET_SETTINGS } = await import('../packages/core/src/lib/scoringDefaults.ts');
const { ALL_PLAN_EVENTS } = await import('../packages/core/src/lib/eventCatalog.ts');
const { scorerRosterKey } = await import('../packages/core/src/lib/scorerRoster.ts');

// ---------------------------------------------------------------------------
// Fixture: one team, one athlete, two individual swims, one relay leg (so the
// relay section has content), one planned entry and one history row.
// ---------------------------------------------------------------------------

const TEAM = 'Test University';
const ATHLETE_NAME = 'Jordan Reed';
const EVENT = ALL_PLAN_EVENTS[0];
const PLAN_ID = 'plan-1';
const PLAN_TIME = '21.10';

function individual(id, event, time, points) {
  return {
    id,
    rank: 1,
    name: ATHLETE_NAME,
    classYear: 'JR',
    team: TEAM,
    time,
    points,
    event,
    gender: Gender.MEN,
  };
}

const RELAY_LEG = {
  id: 'relay-leg-1',
  rank: 1,
  name: ATHLETE_NAME,
  classYear: 'JR',
  team: TEAM,
  time: '1:25.00',
  points: 40,
  event: '200 Freestyle Relay',
  gender: Gender.MEN,
  isRelay: true,
  relayLegIndex: 0,
  relayLegSplit: '21.30',
  roundSwam: 'Finals',
};

const SCORED_RESULTS = [
  individual('ind-1', '50 Freestyle', '20.90', 20),
  individual('ind-2', '100 Freestyle', '45.80', 17),
  RELAY_LEG,
];

const PLANNED_ENTRY = {
  id: PLAN_ID,
  name: ATHLETE_NAME,
  team: TEAM,
  gender: Gender.MEN,
  classYear: 'JR',
  event: EVENT,
  time: PLAN_TIME,
  timeType: 'SCY',
  source: 'manual',
  active: true,
};

const HISTORY_ROW = {
  id: 'hist-1',
  name: ATHLETE_NAME,
  team: TEAM,
  gender: Gender.MEN,
  event: '200 Freestyle',
  time: '1:41.20',
  timeType: 'SCY',
  meetLabel: 'Winter Invite',
  source: 'manual',
};

const WORKSPACE = {
  id: 'w-athlete-editor',
  name: 'athlete-editor-characterization',
  createdAt: 1,
  menResults: SCORED_RESULTS,
  womenResults: [],
  recruits: [],
  scoringSettings: { ...NSISC_PRESET_SETTINGS },
  meetEntryPlans: [PLANNED_ENTRY],
  activeEntryIds: [PLAN_ID],
  athleteHistory: [HISTORY_ROW],
  athleteAliases: [],
};

const ATHLETE = {
  key: scorerRosterKey(TEAM, Gender.MEN, ATHLETE_NAME),
  name: ATHLETE_NAME,
  team: TEAM,
  gender: Gender.MEN,
  classYear: 'JR',
  athleteRole: 'swimmer',
  isScorer: true,
  source: 'auto',
};

const SECTION_TITLES = [
  'Individual entries',
  'Relay involvement',
  'Credited swims',
  'Supplemental history',
];

// A body-text marker per section: something the section renders when open and
// which appears nowhere else in the drawer. Used so "is it open?" is answered
// by the DOM contents, not by a state flag.
const SECTION_MARKER = {
  'Individual entries': PLAN_TIME,
  'Relay involvement': 'leg 1',
  'Credited swims': `Credited swims — ${ATHLETE_NAME}`,
  'Supplemental history': 'Supplemental bests',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function mount(overrides = {}) {
  const calls = { update: [], close: 0 };
  const props = {
    workspace: WORKSPACE,
    settings: { ...NSISC_PRESET_SETTINGS },
    gender: Gender.MEN,
    athlete: ATHLETE,
    issues: [],
    scoredResults: SCORED_RESULTS,
    allResults: SCORED_RESULTS,
    editable: true,
    onUpdate: patch => calls.update.push(patch),
    onClose: () => {
      calls.close += 1;
    },
    autoIsScorer: true,
    ...overrides,
  };
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AthleteLineupEditorPanel, props));
  });
  return {
    container,
    calls,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(el) {
  await act(async () => {
    el.click();
  });
}

/** The collapsible heading button for a section, found by its visible title. */
function sectionHeading(container, title) {
  const hit = Array.from(container.querySelectorAll('button[aria-expanded]')).find(b =>
    b.textContent.includes(title)
  );
  assert.ok(hit, `expected a collapsible heading titled "${title}"`);
  return hit;
}

/**
 * The section's body node, or null when collapsed. `Section` renders the body
 * as a sibling of the heading inside the section wrapper, so "collapsed" is
 * observable as the wrapper having only the heading child.
 */
function sectionBody(container, title) {
  const wrapper = sectionHeading(container, title).parentElement;
  return wrapper.children.length > 1 ? wrapper.children[1] : null;
}

function assertSectionOpen(container, title, expectedOpen, context) {
  const heading = sectionHeading(container, title);
  assert.equal(
    heading.getAttribute('aria-expanded'),
    String(expectedOpen),
    `${context}: "${title}" aria-expanded should be ${expectedOpen}`
  );
  const body = sectionBody(container, title);
  if (expectedOpen) {
    assert.ok(body, `${context}: "${title}" should render a body when expanded`);
    assert.ok(
      body.textContent.includes(SECTION_MARKER[title]),
      `${context}: expanded "${title}" should contain ${JSON.stringify(SECTION_MARKER[title])}`
    );
  } else {
    assert.equal(body, null, `${context}: "${title}" should render no body when collapsed`);
    assert.ok(
      !container.textContent.includes(SECTION_MARKER[title]),
      `${context}: collapsed "${title}" content should not be in the DOM`
    );
  }
}

/** The inline, click-to-edit time control for the planned entry. */
function entryTimeButton(container) {
  return Array.from(container.querySelectorAll('button')).find(
    b => b.textContent.trim() === PLAN_TIME
  );
}

// ---------------------------------------------------------------------------
// 1 + 2. Section headings, and their default open/closed state.
// ---------------------------------------------------------------------------

const editableMount = await mount({ editable: true });
const { container } = editableMount;

for (const title of SECTION_TITLES) {
  sectionHeading(container, title);
}

assertSectionOpen(container, 'Individual entries', true, 'on mount');
assertSectionOpen(container, 'Relay involvement', false, 'on mount');
assertSectionOpen(container, 'Credited swims', false, 'on mount');
assertSectionOpen(container, 'Supplemental history', false, 'on mount');

// ---------------------------------------------------------------------------
// 3. Toggling a collapsed section reveals then re-hides its body.
// ---------------------------------------------------------------------------

for (const title of ['Relay involvement', 'Credited swims', 'Supplemental history']) {
  await click(sectionHeading(container, title));
  assertSectionOpen(container, title, true, `after opening "${title}"`);
  await click(sectionHeading(container, title));
  assertSectionOpen(container, title, false, `after re-closing "${title}"`);
}

// Opening a section must not disturb the one that was open by default.
assertSectionOpen(container, 'Individual entries', true, 'after toggling siblings');

// ---------------------------------------------------------------------------
// 4a. editable: true — the entry-editing controls are present and enabled.
// ---------------------------------------------------------------------------

assert.ok(
  container.querySelector(`input[aria-label="Active ${EVENT}"]`),
  'editable: the per-entry active checkbox should render'
);
assert.ok(
  container.querySelector(`button[aria-label="Remove ${EVENT}"]`),
  'editable: the per-entry remove button should render'
);
assert.ok(
  Array.from(container.querySelectorAll('button')).some(b => b.textContent.includes('Paste')),
  'editable: the paste affordance should render'
);
assert.ok(
  Array.from(container.querySelectorAll('select')).some(s => s.value === EVENT),
  'editable: the entry event should render as a <select>'
);

const editableTimeButton = entryTimeButton(container);
assert.ok(editableTimeButton, 'editable: the inline time control should render');
assert.equal(editableTimeButton.disabled, false, 'editable: the time control should be enabled');

const scorerCheckbox = container.querySelector('input[type="checkbox"]');
assert.ok(scorerCheckbox, 'the scorer checkbox should render');
assert.equal(scorerCheckbox.disabled, false, 'editable: the scorer checkbox should be enabled');

// ---------------------------------------------------------------------------
// 4b. editable: false — the same controls are absent, and the time control is
//     rendered but disabled.
// ---------------------------------------------------------------------------

const readOnlyMount = await mount({ editable: false });
const roContainer = readOnlyMount.container;

// The section contract is identical in read-only mode.
assertSectionOpen(roContainer, 'Individual entries', true, 'read-only mount');
assertSectionOpen(roContainer, 'Relay involvement', false, 'read-only mount');

assert.equal(
  roContainer.querySelector(`input[aria-label="Active ${EVENT}"]`),
  null,
  'read-only: the per-entry active checkbox must not render'
);
assert.equal(
  roContainer.querySelector(`button[aria-label="Remove ${EVENT}"]`),
  null,
  'read-only: the per-entry remove button must not render'
);
assert.equal(
  Array.from(roContainer.querySelectorAll('button')).some(b => b.textContent.includes('Paste')),
  false,
  'read-only: the paste affordance must not render'
);
assert.equal(
  roContainer.querySelector('select'),
  null,
  'read-only: no entry editing <select> should render'
);

const readOnlyTimeButton = entryTimeButton(roContainer);
assert.ok(readOnlyTimeButton, 'read-only: the time value should still render');
assert.equal(readOnlyTimeButton.disabled, true, 'read-only: the time control must be disabled');

const readOnlyScorer = roContainer.querySelector('input[type="checkbox"]');
assert.ok(readOnlyScorer, 'read-only: the scorer checkbox should still render');
assert.equal(readOnlyScorer.disabled, true, 'read-only: the scorer checkbox must be disabled');

await readOnlyMount.unmount();

// ---------------------------------------------------------------------------
// 5. The close control calls onClose.
// ---------------------------------------------------------------------------

const closeButton = container.querySelector('button[aria-label="Close athlete editor"]');
assert.ok(closeButton, 'the drawer should expose a close control');
assert.equal(editableMount.calls.close, 0, 'onClose should not fire before the control is used');
await click(closeButton);
assert.equal(editableMount.calls.close, 1, 'activating the close control should call onClose once');

// ---------------------------------------------------------------------------
// 6. Toggling an entry's active checkbox emits one patch of the expected shape.
// ---------------------------------------------------------------------------

assert.equal(editableMount.calls.update.length, 0, 'no patch should have been emitted yet');

const activeCheckbox = container.querySelector(`input[aria-label="Active ${EVENT}"]`);
assert.equal(activeCheckbox.checked, true, 'the fixture entry starts active');
await click(activeCheckbox);

assert.equal(editableMount.calls.update.length, 1, 'toggling active should emit exactly one patch');
const patch = editableMount.calls.update[0];
assert.deepEqual(
  Object.keys(patch).sort(),
  ['activeEntryIds', 'meetEntryPlans'],
  'the patch should carry only meetEntryPlans and activeEntryIds'
);
assert.ok(Array.isArray(patch.meetEntryPlans), 'patch.meetEntryPlans should be an array');
assert.equal(
  patch.meetEntryPlans.length,
  WORKSPACE.meetEntryPlans.length,
  'the patch replaces the plan array rather than trimming it'
);
const patchedEntry = patch.meetEntryPlans.find(p => p.id === PLAN_ID);
assert.ok(patchedEntry, 'the toggled entry should survive in the patch');
assert.equal(patchedEntry.active, false, 'toggling an active entry should set active: false');
assert.ok(Array.isArray(patch.activeEntryIds), 'patch.activeEntryIds should be an array');
assert.ok(
  !patch.activeEntryIds.includes(PLAN_ID),
  'a deactivated entry id should be dropped from activeEntryIds'
);

// The panel is controlled: it must not have mutated the workspace it was given.
assert.equal(
  WORKSPACE.meetEntryPlans[0].active,
  true,
  'the panel must not mutate the workspace prop in place'
);

await editableMount.unmount();
domWindow.close();

console.log('athlete lineup editor characterization tests passed');
