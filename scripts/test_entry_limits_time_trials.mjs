/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the A TIME TRIAL IS NOT AN ENTRY rule in per-swimmer entry counting.
 *
 * THE RULING (user, 2026-09-21): a time trial does not count against a
 * swimmer's entry limit. It is not part of the meet's program, so it does not
 * consume one of their entries — whatever event it was swum in.
 *
 * THE BUG IT CLOSES: `entryCapKey` keys on the raw HyTek event label, which is
 * `docs/INVARIANTS.md` item 3. That collapses a prelims row onto its final,
 * because HyTek prints the identical label for both. A time trial arrives with
 * its OWN event number and a trailing " Time Trial", so it never collapsed:
 *
 *     Event 26  Men 100 Yard Breaststroke
 *     Event 100 Men 100 Yard Breaststroke Time Trial
 *
 * One swimmer, one 100 Breaststroke in the program, two entries charged.
 *
 * Measured against the real meet in `data/meets.json` before the fix: 13
 * athletes were flagged over the NSISC 7-event cap and 8 of them were not over
 * it. Roughly 62% of the compliance warnings a coach saw were false. The same
 * count gates `canAcceptAnotherEntry`, so those swimmers were also blocked from
 * adding a legitimate entry.
 *
 * WHY THE FIX SITS IN `countSwimmerEntries` AND NOT IN `entryCapKey`: keying
 * through `canonicalProgramEvent` would also work for the case above, but it
 * would still charge an entry for a time trial of an event the swimmer did not
 * otherwise swim. The ruling is that a time trial never costs an entry, so the
 * row is skipped outright.
 *
 * The rest of the codebase already agreed: `canonicalProgramEvent` returns null
 * for a time trial, `buildMeetEventLabelIndex` skips one, `computeVisibleEvents`
 * hides one, and one scores zero. Entry counting was the only holdout.
 */
import assert from 'node:assert/strict';
import { countSwimmerEntries } from '../packages/core/src/lib/swimmerEntryLimits.ts';

const TEAM = 'Test University';
const MEN = 'Men';

function ind(event, extra = {}) {
  return { id: `${event}`, name: 'Test Swimmer', team: TEAM, gender: MEN, event, isRelay: false, ...extra };
}
function relay(event, extra = {}) {
  return { id: `${event}`, name: 'Test Swimmer', team: TEAM, gender: MEN, event, isRelay: true, ...extra };
}

const count = rows => countSwimmerEntries(rows, TEAM, MEN, 'Test Swimmer');

/* -------------------------------------------------------------------------- */
/* 1. The real shape: a time trial of an event already swum                    */
/* -------------------------------------------------------------------------- */
{
  const rows = [
    ind('Event 26 Men 100 Yard Breaststroke'),
    ind('Event 100 Men 100 Yard Breaststroke Time Trial', { isTimeTrial: true }),
  ];
  const c = count(rows);
  assert.equal(c.individual, 1, 'a time trial of an event already swum must not add an entry');
  assert.equal(c.total, 1);
}

/* -------------------------------------------------------------------------- */
/* 2. A time trial of an event NOT otherwise swum still costs nothing          */
/* -------------------------------------------------------------------------- */
{
  // This is the case that distinguishes the ruling from the narrower
  // "collapse it onto the real swim" fix. The ruling is that a time trial is
  // never an entry, so this swimmer has one entry, not two.
  const rows = [
    ind('Event 26 Men 100 Yard Breaststroke'),
    ind('Event 101 Men 200 Yard Butterfly Time Trial', { isTimeTrial: true }),
  ];
  const c = count(rows);
  assert.equal(c.individual, 1, 'a time trial of an unswum event must not add an entry either');
  assert.equal(c.total, 1);
}

/* -------------------------------------------------------------------------- */
/* 3. Relay time trials are excluded on the same rule                          */
/* -------------------------------------------------------------------------- */
{
  const rows = [
    relay('Event 1 Women 4x200 Yard Freestyle Relay'),
    relay('Event 202 Women 4x200 Yard Freestyle Relay Time Trial', { isTimeTrial: true }),
  ];
  const c = count(rows);
  assert.equal(c.relayCount, 1, 'a relay time trial must not add a relay entry');
  assert.equal(c.total, 1);
}

/* -------------------------------------------------------------------------- */
/* 4. Real entries are untouched — the fix must not under-count                */
/* -------------------------------------------------------------------------- */
{
  // The failure mode opposite to the bug: skipping too much would let a
  // genuinely over-entered swimmer through, which is worse than a false
  // warning because nothing downstream would catch it.
  const rows = [
    ind('Event 6 Men 200 Yard IM'),
    ind('Event 15 Men 400 Yard IM'),
    ind('Event 26 Men 100 Yard Breaststroke'),
    ind('Event 39 Men 200 Yard Breaststroke'),
    relay('Event 11 Men 4x50 Yard Medley Relay'),
    relay('Event 20 Men 4x100 Yard Medley Relay'),
    relay('Event 31 Men 4x50 Yard Freestyle Relay'),
  ];
  const c = count(rows);
  assert.equal(c.individual, 4);
  assert.equal(c.relayCount, 3);
  assert.equal(c.total, 7, 'seven real entries must still count as seven');
}

/* -------------------------------------------------------------------------- */
/* 5. Prelims/finals collapse still works — the original rule is not lost      */
/* -------------------------------------------------------------------------- */
{
  const rows = [
    ind('Event 26 Men 100 Yard Breaststroke', { roundSwam: 'Prelims' }),
    ind('Event 26 Men 100 Yard Breaststroke', { roundSwam: 'Finals' }),
  ];
  assert.equal(count(rows).total, 1, 'prelims and finals of one event are still one entry');
}

/* -------------------------------------------------------------------------- */
/* 6. The real meet, end to end                                               */
/* -------------------------------------------------------------------------- */
{
  const { readFileSync } = await import('node:fs');
  const ws = JSON.parse(readFileSync('data/meets.json', 'utf-8')).find(w => w.name === 'Blank Workspace 1');
  if (ws) {
    const c = countSwimmerEntries(ws.menResults, 'Henderson State University', MEN, 'Oskar Cebula');
    // 8/7 before the fix: his 100 Breaststroke was charged twice.
    assert.equal(c.total, 7, `Oskar Cebula must be at the cap, not over it (got ${c.total})`);
    assert.equal(c.individual, 4);
    assert.equal(c.relayCount, 3);
  }
}

console.log('ALL entry_limits_time_trials assertions passed.');
