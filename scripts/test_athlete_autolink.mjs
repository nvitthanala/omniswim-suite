/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Auto-linking tests for duplicate athlete names (planAutoAliasLinks /
 * applyAutoAliasLinks): tier rules, hard blockers, suppression durability and
 * idempotency.
 *
 * Fixtures use the REAL HSU 2026-27 duplicates that motivated this feature —
 * a SwimCloud roster paste landing on top of loaded NSISC meet results.
 *
 * Run: npx tsx scripts/test_athlete_autolink.mjs
 */
import assert from 'node:assert/strict';
import {
  planAutoAliasLinks,
  applyAutoAliasLinks,
  unlinkAndSuppressAlias,
  buildAliasResolver,
} from '../packages/core/src/lib/athleteAliases.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

/** A competed swim (appears in menResults => this athlete raced). */
const res = (name, event, time) => ({ name, team: TEAM, gender: MEN, event, time });
/** A recruit row (import-only side: SwimCloud personal bests). */
const rec = (name, event, time) => ({ name, team: TEAM, gender: MEN, event, time, classYear: 'HS' });

/**
 * The real duplicate set. Left column competed; right column exists only in the
 * paste. Note the exact cross-source time collisions on individual events —
 * 100 Breaststroke 55.52, 50 Free 20.59, 100 Free 46.50 — which are the
 * corroborating evidence the `strong` tier relies on.
 */
function hsuWorkspace(extra = {}) {
  return {
    athleteAliases: [],
    menResults: [
      res('Oliver Pozvai', 'Event 8 Men 50 Yard Freestyle', '20.28'),
      res('Oliver Pozvai', 'Event 35 Men 100 Yard Freestyle', '44.44'),
      res('Alan Gonzalez Mujica', 'Event 17 Men 200 Yard Freestyle', '1:43.22'),
      res('Cam Mask', 'Event 26 Men 100 Yard Breaststroke', '55.52'),
      res('Stevie Balistreri', 'Event 13 Men 100 Yard Butterfly', '49.32'),
      res('Tristen Fergunson', 'Event 8 Men 50 Yard Freestyle', '20.59'),
      res('Tristen Fergunson', 'Event 35 Men 100 Yard Freestyle', '46.50'),
      res('Alfonso Campanico', 'Event 22 Men 500 Yard Freestyle', '4:57.49'),
      // Relay rows: EVERY leg carries the shared team time. Inadmissible as
      // identity evidence — see the 1:31.73 regression test below.
      res('Stevie Balistreri', 'Event 11 Men 4x50 Yard Medley Relay', '1:31.73'),
      res('Tristen Fergunson', 'Event 11 Men 4x50 Yard Medley Relay', '1:31.73'),
      res('Hunter Rytting', 'Event 11 Men 4x50 Yard Medley Relay', '1:31.73'),
      res('Mark Eberhard', 'Event 11 Men 4x50 Yard Medley Relay', '1:31.73'),
    ],
    recruits: [
      rec('Olivér Pózvai', '50 Freestyle', '20.22'),
      rec('Alan Alejan Gonzalez Mujica', '200 Freestyle', '1:43.22'),
      rec('Camden Mask', '100 Breaststroke', '55.52'),
      rec('Steven Balistreri', '100 Butterfly', '49.20'),
      rec('Tristin Ferguson', '50 Freestyle', '20.59'),
      rec('Tristin Ferguson', '100 Freestyle', '46.50'),
      rec('Afonso Campanico', '100 Freestyle', '52.28'),
    ],
    ...extra,
  };
}

const pairOf = d => `${d.aliasName}=>${d.canonicalName}`;

console.log('athlete auto-link');

// --- 1. the five real duplicate pairs all auto-link -------------------------
{
  const plan = planAutoAliasLinks(hsuWorkspace());
  const pairs = new Set(plan.autoLinks.map(pairOf));

  for (const p of [
    'Olivér Pózvai=>Oliver Pozvai',
    'Alan Alejan Gonzalez Mujica=>Alan Gonzalez Mujica',
    'Camden Mask=>Cam Mask',
    'Steven Balistreri=>Stevie Balistreri',
    'Tristin Ferguson=>Tristen Fergunson',
    'Afonso Campanico=>Alfonso Campanico',
  ]) {
    assert.ok(pairs.has(p), `expected auto-link ${p}; got ${[...pairs].join(', ')}`);
  }
  ok('all six real HSU duplicate pairs auto-link');

  // MERGE SEMANTICS: the competed spelling is the official record and wins.
  for (const d of plan.autoLinks) {
    assert.notEqual(d.competedSide, 'alias', `${pairOf(d)} made the import-only name canonical`);
  }
  ok('canonical name is always the competed (meet-results) spelling');

  const diacritic = plan.autoLinks.find(d => d.aliasName === 'Olivér Pózvai');
  assert.equal(diacritic.tier, 'conclusive');
  ok('diacritic-only pair is tier "conclusive"');

  const ferguson = plan.autoLinks.find(d => d.aliasName === 'Tristin Ferguson');
  assert.equal(ferguson.tier, 'strong');
  assert.ok(ferguson.timeMatches.length > 0, 'expected corroborating individual-event times');
  ok('surname-typo pair reaches "strong" on individual-event time corroboration');

  // No overlapping events at all, so no time evidence exists for this one.
  const campanico = plan.autoLinks.find(d => d.aliasName === 'Afonso Campanico');
  assert.equal(campanico.tier, 'moderate');
  assert.equal(campanico.timeMatches.length, 0);
  ok('no-shared-events pair still links at "moderate" via name + import-only side');
}

// --- 2. THE regression test: relay times must never link teammates ----------
{
  const plan = planAutoAliasLinks(hsuWorkspace());
  const linked = buildAliasResolver(applyAutoAliasLinks(hsuWorkspace()).patch.athleteAliases ?? []);

  for (const [a, b] of [
    ['Stevie Balistreri', 'Tristen Fergunson'],
    ['Hunter Rytting', 'Mark Eberhard'],
    ['Stevie Balistreri', 'Hunter Rytting'],
  ]) {
    assert.ok(
      !plan.autoLinks.some(
        d => (d.aliasName === a && d.canonicalName === b) || (d.aliasName === b && d.canonicalName === a)
      ),
      `${a} and ${b} were auto-linked off a shared RELAY time`
    );
    assert.ok(!linked.areLinked(a, b, TEAM, MEN), `${a} and ${b} resolve to one identity`);
  }
  ok('relay team times (1:31.73 shared by 4 legs) never link distinct teammates');
}

// --- 3. hard blocker: two names that both competed are different people -----
{
  const ws = hsuWorkspace({
    // Same surname, one-letter first name difference — would otherwise be a
    // strong candidate. But BOTH raced, so they are provably two people.
    menResults: [
      res('Jake Smith', 'Event 8 Men 50 Yard Freestyle', '21.10'),
      res('Jack Smith', 'Event 8 Men 50 Yard Freestyle', '21.44'),
    ],
    recruits: [],
  });
  const plan = planAutoAliasLinks(ws);
  assert.equal(plan.autoLinks.length, 0, 'auto-linked two athletes who both competed');
  ok('both-competed pair is never auto-linked (you cannot race yourself)');
}

// --- 4. twins: similar names, no corroboration, no auto-link ----------------
{
  const ws = hsuWorkspace({
    menResults: [res('Jake Smith', 'Event 8 Men 50 Yard Freestyle', '21.10')],
    recruits: [rec('Jack Smith', '100 Butterfly', '55.01')],
  });
  const plan = planAutoAliasLinks(ws);
  assert.equal(
    plan.autoLinks.length,
    0,
    `siblings auto-linked: ${plan.autoLinks.map(pairOf).join(', ')}`
  );
  ok('sibling-shaped names with no shared evidence stay out of auto-link');
}

// --- 5. suppression is durable: unlink must not come back ------------------
{
  const applied = applyAutoAliasLinks(hsuWorkspace());
  const afterApply = { ...hsuWorkspace(), athleteAliases: applied.patch.athleteAliases };

  const target = afterApply.athleteAliases.find(l => l.aliasName === 'Camden Mask');
  assert.ok(target, 'expected a Camden Mask link to unlink');

  const undone = unlinkAndSuppressAlias(afterApply, target.id);
  const afterUnlink = { ...afterApply, athleteAliases: undone.patch.athleteAliases };

  assert.ok(
    !buildAliasResolver(afterUnlink.athleteAliases).areLinked('Camden Mask', 'Cam Mask', TEAM, MEN),
    'unlink did not take effect'
  );

  // Re-running the importer must respect the user's decision.
  const replan = planAutoAliasLinks(afterUnlink);
  assert.ok(
    !replan.autoLinks.some(d => d.aliasName === 'Camden Mask'),
    'a user-rejected link was recreated by the next import'
  );
  ok('unlink is durable — re-planning does not resurrect a rejected pair');
}

// --- 6. idempotency --------------------------------------------------------
{
  const first = applyAutoAliasLinks(hsuWorkspace());
  const afterFirst = { ...hsuWorkspace(), athleteAliases: first.patch.athleteAliases };
  const second = applyAutoAliasLinks(afterFirst);

  assert.equal(second.applied.length, 0, 'second run created more links');
  assert.deepEqual(second.patch, {}, 'second run produced a non-empty patch');
  ok('applying twice is a no-op (idempotent)');
}

// --- 7. provenance is auditable -------------------------------------------
{
  const applied = applyAutoAliasLinks(hsuWorkspace());
  for (const link of applied.patch.athleteAliases ?? []) {
    assert.equal(link.provenance?.origin, 'auto');
    assert.ok(link.provenance?.rule, 'link is missing the rule that created it');
    assert.ok(link.provenance?.tier, 'link is missing its evidence tier');
    assert.ok(link.provenance?.decidedAt, 'link is missing a timestamp');
  }
  ok('every auto-link records origin, rule, tier and timestamp');
}

// --- 8. resolver actually unifies the duplicates ---------------------------
{
  const applied = applyAutoAliasLinks(hsuWorkspace());
  const r = buildAliasResolver(applied.patch.athleteAliases ?? []);
  assert.ok(r.areLinked('Tristin Ferguson', 'Tristen Fergunson', TEAM, MEN));
  assert.ok(r.areLinked('Olivér Pózvai', 'Oliver Pozvai', TEAM, MEN));
  assert.equal(r.resolveAthleteName('Camden Mask', TEAM, MEN), 'Cam Mask');
  ok('resolver unifies linked spellings onto the competed name');
}

console.log(`\nathlete auto-link: ${n} passed`);
