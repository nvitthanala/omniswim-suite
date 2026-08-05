/**
 * Working-copy change counter regression tests.
 */
import assert from 'node:assert/strict';
import { Gender } from '../packages/core/src/types.ts';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits.ts';
import { countWorkingCopyChanges, listRevertibleChanges } from '../packages/core/src/lib/workingCopyChanges.ts';

const baseWorkspace = {
  id: 'w',
  name: 't',
  createdAt: 1,
  menResults: [],
  womenResults: [],
  recruits: [],
};

// Pristine workspace: no optional collections at all → all zero.
{
  const counts = countWorkingCopyChanges(baseWorkspace, Gender.MEN);
  assert.deepEqual(counts, {
    recruits: 0,
    removals: 0,
    rosterOverrides: 0,
    relayLegOverrides: 0,
    unresolvedRelayLegOverrides: 0,
    plannedEntries: 0,
    total: 0,
  });
}

// Pristine workspace with present-but-empty collections → still all zero.
{
  const ws = {
    ...baseWorkspace,
    recruits: [],
    deletedSwimmers: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    meetEntryPlans: [],
  };
  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.total, 0);
}

// Each category increments the total independently.
{
  const ws = {
    ...baseWorkspace,
    recruits: [
      { id: 'r1', name: 'Rec One', team: 'Team A', event: '50 Freestyle', time: '20.00', gender: Gender.MEN, classYear: 'FR', timeType: 'SCY' },
    ],
  };
  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.recruits, 1);
  assert.equal(counts.total, 1);
}

{
  const ws = {
    ...baseWorkspace,
    deletedSwimmers: [{ name: 'Gone Swimmer', gender: Gender.MEN, mode: 'hidden' }],
  };
  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.removals, 1);
  assert.equal(counts.total, 1);
}

{
  const ws = {
    ...baseWorkspace,
    scorerRosterOverrides: [{ name: 'Scorer One', team: 'Team A', gender: Gender.MEN, isScorer: true }],
  };
  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.rosterOverrides, 1);
  assert.equal(counts.total, 1);
}

// Relay leg overrides carry no gender field, so they are attributed by matching
// `relayEntryKey` against each gender's own result rows. Counting them wholesale
// would report a women's relay edit while the user is looking at the men's roster.
{
  const menRelay = {
    id: 'r1', rank: 1, name: 'Team A Relay', team: 'Team A', time: '1:25.00', points: 0,
    event: '200 Free Relay', gender: Gender.MEN, roundSwam: '',
  };
  const key = relayEntryKey(menRelay);
  const ws = {
    ...baseWorkspace,
    menResults: [menRelay],
    relayLegOverrides: [{ relayEntryKey: key, legIndex: 0, assigneeName: 'Someone' }],
  };

  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.relayLegOverrides, 1, 'override resolves to the mens relay entry');
  assert.equal(counts.unresolvedRelayLegOverrides, 0);
  assert.equal(counts.total, 1);

  // Same workspace viewed as women: the override belongs to the men's entry, so
  // it must NOT be counted here, and it is resolved (not unresolved).
  const countsWomen = countWorkingCopyChanges(ws, Gender.WOMEN);
  assert.equal(countsWomen.relayLegOverrides, 0, 'mens relay override must not count for women');
  assert.equal(countsWomen.unresolvedRelayLegOverrides, 0);
  assert.equal(countsWomen.total, 0);
}

// A stale override matching no row in either gender is reported separately and
// deliberately kept out of `total` — absent is not the same as zero.
{
  const ws = {
    ...baseWorkspace,
    relayLegOverrides: [{ relayEntryKey: 'Nobody|999 Free Relay||1|9:99.99', legIndex: 0, assigneeName: 'Someone' }],
  };
  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.relayLegOverrides, 0);
  assert.equal(counts.unresolvedRelayLegOverrides, 1);
  assert.equal(counts.total, 0, 'unresolved overrides must not inflate the displayed total');
}

{
  const ws = {
    ...baseWorkspace,
    meetEntryPlans: [
      { id: 'p1', name: 'Planned One', team: 'Team A', gender: Gender.MEN, event: '100 Freestyle', time: '48.00', source: 'manual' },
    ],
  };
  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.plannedEntries, 1);
  assert.equal(counts.total, 1);
}

// Gender scoping excludes the other gender's entries.
{
  const ws = {
    ...baseWorkspace,
    recruits: [
      { id: 'r1', name: 'Men Rec', team: 'Team A', event: '50 Freestyle', time: '20.00', gender: Gender.MEN, classYear: 'FR', timeType: 'SCY' },
      { id: 'r2', name: 'Women Rec', team: 'Team A', event: '50 Freestyle', time: '22.00', gender: Gender.WOMEN, classYear: 'FR', timeType: 'SCY' },
    ],
    deletedSwimmers: [
      { name: 'Men Gone', gender: Gender.MEN, mode: 'hidden' },
      { name: 'Women Gone', gender: Gender.WOMEN, mode: 'hidden' },
    ],
    scorerRosterOverrides: [
      { name: 'Men Scorer', team: 'Team A', gender: Gender.MEN, isScorer: true },
      { name: 'Women Scorer', team: 'Team A', gender: Gender.WOMEN, isScorer: true },
    ],
    meetEntryPlans: [
      { id: 'p1', name: 'Men Plan', team: 'Team A', gender: Gender.MEN, event: '100 Freestyle', time: '48.00', source: 'manual' },
      { id: 'p2', name: 'Women Plan', team: 'Team A', gender: Gender.WOMEN, event: '100 Freestyle', time: '55.00', source: 'manual' },
    ],
  };
  const men = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(men.recruits, 1);
  assert.equal(men.removals, 1);
  assert.equal(men.rosterOverrides, 1);
  assert.equal(men.plannedEntries, 1);
  assert.equal(men.total, 4);

  const women = countWorkingCopyChanges(ws, Gender.WOMEN);
  assert.equal(women.recruits, 1);
  assert.equal(women.removals, 1);
  assert.equal(women.rosterOverrides, 1);
  assert.equal(women.plannedEntries, 1);
  assert.equal(women.total, 4);
}

// Undefined collections are 0, not a crash, even when mixed with present ones.
{
  const ws = {
    ...baseWorkspace,
    recruits: [
      { id: 'r1', name: 'Rec One', team: 'Team A', event: '50 Freestyle', time: '20.00', gender: Gender.MEN, classYear: 'FR', timeType: 'SCY' },
    ],
    // deletedSwimmers, scorerRosterOverrides, relayLegOverrides, meetEntryPlans intentionally absent.
  };
  const counts = countWorkingCopyChanges(ws, Gender.MEN);
  assert.equal(counts.removals, 0);
  assert.equal(counts.rosterOverrides, 0);
  assert.equal(counts.relayLegOverrides, 0);
  assert.equal(counts.plannedEntries, 0);
  assert.equal(counts.total, 1);
}

// --- listRevertibleChanges -------------------------------------------------

// Empty workspace: no revertible changes.
{
  const changes = listRevertibleChanges(baseWorkspace, Gender.MEN);
  assert.deepEqual(changes, []);
}

// Recruits are listed with a human label/detail and gender-scoped.
{
  const ws = {
    ...baseWorkspace,
    recruits: [
      { id: 'r1', name: 'Alan Gonzalez', team: 'Team A', event: '200 Freestyle', time: '1:44.93', gender: Gender.MEN, classYear: 'FR', timeType: 'SCY' },
      { id: 'r2', name: 'Women Rec', team: 'Team B', event: '50 Freestyle', time: '22.00', gender: Gender.WOMEN, classYear: 'FR', timeType: 'SCY' },
    ],
  };
  const men = listRevertibleChanges(ws, Gender.MEN);
  assert.equal(men.length, 1);
  assert.equal(men[0].kind, 'recruit');
  assert.equal(men[0].id, 'r1');
  assert.equal(men[0].label, 'Alan Gonzalez');
  assert.equal(men[0].detail, '200 Freestyle · 1:44.93 · Team A');

  const women = listRevertibleChanges(ws, Gender.WOMEN);
  assert.equal(women.length, 1);
  assert.equal(women[0].id, 'r2');
}

// A 'hidden' removal never stripped source rows, so it is always fully restorable.
{
  const ws = {
    ...baseWorkspace,
    deletedSwimmers: [{ name: 'Gone Swimmer', gender: Gender.MEN, mode: 'hidden' }],
  };
  const changes = listRevertibleChanges(ws, Gender.MEN);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'removal');
  assert.equal(changes[0].mode, 'hidden');
  assert.equal(changes[0].fullyRestorable, true);
  assert.equal(changes[0].detail, 'removed from the projection');
}

// A 'removed' swimmer WITH matching rows in the frozen source copy is fully restorable.
{
  const sourceRow = {
    id: 's1', rank: 1, name: 'Stripped Swimmer', classYear: 'SO', team: 'Team A',
    time: '20.00', points: 0, event: '50 Freestyle', gender: Gender.MEN,
  };
  const ws = {
    ...baseWorkspace,
    sourceMenResults: [sourceRow],
    menResults: [], // rows were stripped from the working copy
    deletedSwimmers: [{ name: 'Stripped Swimmer', gender: Gender.MEN, mode: 'removed' }],
  };
  const changes = listRevertibleChanges(ws, Gender.MEN);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].mode, 'removed');
  assert.equal(changes[0].fullyRestorable, true);
  assert.equal(changes[0].detail, 'removed from the roster');
}

// A 'removed' swimmer with NO source copy at all cannot be rebuilt — getSourceResults
// would fall back to the already-stripped working rows, so restoring would silently
// clear the tombstone and bring back nothing. Must report fullyRestorable: false.
{
  const ws = {
    ...baseWorkspace,
    menResults: [], // no sourceMenResults present, and working rows already stripped
    deletedSwimmers: [{ name: 'Unrecoverable Swimmer', gender: Gender.MEN, mode: 'removed' }],
  };
  const changes = listRevertibleChanges(ws, Gender.MEN);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].mode, 'removed');
  assert.equal(changes[0].fullyRestorable, false);
}

// A 'removed' swimmer WITH a source copy but no matching rows in it is also
// not fully restorable — the source copy exists but has nothing to rebuild from.
{
  const ws = {
    ...baseWorkspace,
    sourceMenResults: [
      { id: 's2', rank: 1, name: 'Someone Else', classYear: 'SO', team: 'Team A', time: '20.00', points: 0, event: '50 Freestyle', gender: Gender.MEN },
    ],
    menResults: [],
    deletedSwimmers: [{ name: 'Not In Source', gender: Gender.MEN, mode: 'removed' }],
  };
  const changes = listRevertibleChanges(ws, Gender.MEN);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].fullyRestorable, false);
}

console.log('working copy change counter tests passed');
