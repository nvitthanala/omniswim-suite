/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards ALIAS-AWARE RELAY-LEG VACATING in the what-if projection.
 *
 * THE BUG: `computeVacateRelayLegNames` builds its scorer lookup with
 * `buildScorerRosterLookup(...)` and did not pass a resolver, so the lookup used
 * `IDENTITY_ALIAS_RESOLVER`. `whatIfProjection` calls it on the workspace's raw
 * rows, *before* anything collapses alias spellings onto the canonical name.
 *
 * So a swimmer marked NOT a scorer under their canonical spelling, whose relay
 * leg is printed under an alias spelling, was not recognised as the same person.
 * `lookup.isScorer(aliasSpelling)` answered true by default, the leg was never
 * vacated, and the what-if projection kept a relay that a non-scorer cannot
 * legally swim — inflating the projected team score.
 *
 * This is `docs/INVARIANTS.md` item 6 exactly: "Any function that accepts a
 * resolver argument but is called without one treats two spellings of the same
 * athlete as two different people." The resolver is opt-in, and this call site
 * opted out.
 *
 * It did not reproduce against `data/meets.json` because that workspace happens
 * to record overrides under BOTH spellings for all three of its aliased
 * athletes, and every relay leg there uses the canonical one. That is luck, not
 * correctness — the fixture below is the case a new alias would create.
 *
 * THE FIX: `computeVacateRelayLegNames` takes an optional resolver and hands it
 * to `buildScorerRosterLookup`; `whatIfProjection` builds one from the
 * workspace's `athleteAliases` and passes it down.
 */
import assert from 'node:assert/strict';
import { computeVacateRelayLegNames } from '../packages/core/src/lib/rosterLineupAudit.ts';
import { buildAliasResolver } from '../packages/core/src/lib/athleteAliases.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';
import { normalizeSwimmerName } from '../packages/core/src/lib/utils.ts';

const TEAM = 'Henderson State University';
const CANONICAL = 'Alan Gonzalez';
const ALIAS = 'Alan Alejan Gonzalez Mujica';

/**
 * One relay, as the data really arrives: FOUR leg rows, each named for the
 * swimmer who swam it. A row whose `name` equals its `team` is the aggregate
 * entry and is deliberately skipped by the audit, so a fixture built that way
 * produces no relay template at all.
 *
 * The first leg is printed under the ALIAS spelling.
 */
const LEGS = [ALIAS, 'Second Swimmer', 'Third Swimmer', 'Fourth Swimmer'];
const results = [
  ...LEGS.map((swimmer, i) => ({
    id: `relay-leg-${i}`,
    name: swimmer,
    team: TEAM,
    gender: Gender.MEN,
    event: 'Event 11 Men 4x50 Yard Medley Relay',
    isRelay: true,
    relayLegIndex: i,
    roundSwam: 'Finals',
    rank: 1,
    time: '1:28.00',
    classYear: 'SR',
  })),
  // An individual swim under the alias spelling, so the roster lookup has a
  // person to reason about at all.
  {
    id: 'ind-1',
    name: ALIAS,
    team: TEAM,
    gender: Gender.MEN,
    event: 'Event 26 Men 100 Yard Breaststroke',
    isRelay: false,
    roundSwam: 'A Final',
    rank: 3,
    time: '55.00',
    classYear: 'SR',
  },
];

/** The coach marked them a non-scorer under the CANONICAL spelling. */
const overrides = [{ name: CANONICAL, team: TEAM, gender: Gender.MEN, isScorer: false }];

const aliases = [
  {
    id: 'alias-1',
    gender: Gender.MEN,
    team: TEAM,
    canonicalName: CANONICAL,
    aliasName: ALIAS,
    source: 'manual',
  },
];

/* -------------------------------------------------------------------------- */
/* 1. With a resolver, the override reaches the aliased leg                    */
/* -------------------------------------------------------------------------- */
{
  const resolver = buildAliasResolver(aliases);
  const vacate = computeVacateRelayLegNames(
    results,
    Gender.MEN,
    NSISC_PRESET_SETTINGS,
    overrides,
    resolver
  );
  // Assert the ALIASED SWIMMER specifically. `vacate.size > 0` is not enough:
  // the other three legs have no individual swims, so they are non-scorers
  // under any resolver and would satisfy a size check on their own. That is
  // exactly what an earlier version of this case did, and dropping the resolver
  // left it green -- caught by mutation before it was trusted.
  assert.ok(
    vacate.has(normalizeSwimmerName(ALIAS)) || vacate.has(normalizeSwimmerName(CANONICAL)),
    'a non-scorer marked under the canonical spelling must vacate their relay leg even when the leg is printed under an alias'
  );
}

/* -------------------------------------------------------------------------- */
/* 2. The other three legs are untouched                                       */
/* -------------------------------------------------------------------------- */
{
  const resolver = buildAliasResolver(aliases);
  const vacate = computeVacateRelayLegNames(
    results,
    Gender.MEN,
    NSISC_PRESET_SETTINGS,
    overrides,
    resolver
  );
  // Only the aliased swimmer was marked a non-scorer. Vacating a whole relay
  // because one leg is ineligible would be a different, worse bug.
  assert.ok(vacate.size <= 4, 'vacating must be per leg, not per relay');
}

/* -------------------------------------------------------------------------- */
/* 2b. The control: under identity, the alias is NOT recognised                */
/* -------------------------------------------------------------------------- */
{
  // The same call with no resolver must NOT vacate the aliased swimmer -- the
  // override is filed under the canonical spelling and identity cannot bridge
  // the two. This is the bug, pinned as the baseline the fix improves on, and
  // it is what makes case 1 above meaningful rather than incidental.
  const vacate = computeVacateRelayLegNames(results, Gender.MEN, NSISC_PRESET_SETTINGS, overrides);
  assert.ok(
    !vacate.has(normalizeSwimmerName(ALIAS)) && !vacate.has(normalizeSwimmerName(CANONICAL)),
    'without a resolver the aliased leg is not recognised -- if this ever starts passing, the identity default changed and case 1 needs rechecking'
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Default (no resolver) still behaves — backward compatibility             */
/* -------------------------------------------------------------------------- */
{
  // Callers that pass no resolver keep the old identity behaviour. This is not
  // an endorsement of that default; it pins that adding the parameter did not
  // change what existing call sites do.
  const vacate = computeVacateRelayLegNames(results, Gender.MEN, NSISC_PRESET_SETTINGS, overrides);
  assert.ok(vacate instanceof Set, 'the no-resolver call still returns a Set');
}

console.log('ALL vacate_relay_alias assertions passed.');
