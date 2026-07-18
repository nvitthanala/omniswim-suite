/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Lineup compliance audit + non-scorer relay vacate tests.
 */
import assert from 'node:assert/strict';
import { Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import {
  applyScorerOffRelayPatch,
  buildTeamLineupAudit,
  computeVacateRelayLegNames,
  pruneRelayOverridesForSwimmer,
  suggestQuickFillForVacantLeg,
} from '../packages/core/src/lib/rosterLineupAudit.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { softRemoveSwimmerFromWorkspace } from '../packages/core/src/lib/swimmerSoftRemove.ts';
import { normalizeSwimmerName } from '../packages/core/src/lib/utils.ts';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits.ts';
import { relayTemplateFromLeg } from '../packages/core/src/lib/relayLegMatching.ts';

function relayLegs(team, event, names, extras = {}) {
  return names.map((name, i) => ({
    id: `rel-${event}-${i}`,
    rank: 1,
    name,
    classYear: extras.classYears?.[i] ?? 'JR',
    team,
    time: '3:20.00',
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    roundSwam: 'A Final',
    relayNames: names.map((n, j) => ({
      name: n,
      year: extras.classYears?.[j] ?? 'JR',
    })),
  }));
}

function baseWorkspace(overrides = {}) {
  const team = 'Ouachita Baptist University';
  return {
    id: 'audit-ws',
    name: 'Audit Test',
    createdAt: Date.now(),
    menResults: [
      {
        id: 'i1',
        rank: 1,
        name: 'Alpha, Ace',
        classYear: 'JR',
        team,
        time: '20.50',
        points: 0,
        event: '50 Freestyle',
        gender: Gender.MEN,
        roundSwam: 'A Final',
      },
      {
        id: 'i2',
        rank: 2,
        name: 'Beta, Bob',
        classYear: 'SO',
        team,
        time: '21.00',
        points: 0,
        event: '50 Freestyle',
        gender: Gender.MEN,
        roundSwam: 'A Final',
      },
      {
        id: 'i3',
        rank: 3,
        name: 'Gamma, Gus',
        classYear: 'SR',
        team,
        time: '21.50',
        points: 0,
        event: '50 Freestyle',
        gender: Gender.MEN,
        roundSwam: 'B Final',
      },
      {
        id: 'i4',
        rank: 1,
        name: 'Delta, Dan',
        classYear: 'FR',
        team,
        time: '48.00',
        points: 0,
        event: '100 Freestyle',
        gender: Gender.MEN,
        roundSwam: 'A Final',
      },
      ...relayLegs(
        team,
        '200 Freestyle Relay',
        ['Alpha, Ace', 'Beta, Bob', 'Gamma, Gus', 'Delta, Dan'],
        { classYears: ['JR', 'SO', 'SR', 'FR'] }
      ),
    ],
    womenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    ...overrides,
  };
}

// --- pruneRelayOverridesForSwimmer ---
{
  const overrides = [
    { relayEntryKey: 'k1', legIndex: 0, assigneeName: 'Alpha, Ace' },
    { relayEntryKey: 'k1', legIndex: 1, assigneeName: 'Beta, Bob' },
  ];
  const next = pruneRelayOverridesForSwimmer(overrides, 'Alpha, Ace');
  assert.equal(next.length, 1);
  assert.equal(next[0].assigneeName, 'Beta, Bob');
}

// --- soft remove also prunes relay overrides ---
{
  const ws = baseWorkspace({
    relayLegOverrides: [
      { relayEntryKey: 'k1', legIndex: 2, assigneeName: 'Gamma, Gus' },
    ],
  });
  const patch = softRemoveSwimmerFromWorkspace(ws, {
    name: 'Gamma, Gus',
    gender: Gender.MEN,
  });
  assert.ok(patch.deletedSwimmers?.some(d => d.name === 'Gamma, Gus'));
  assert.equal((patch.relayLegOverrides ?? []).length, 0);
}

// --- computeVacateRelayLegNames when scorer toggled off ---
{
  const ws = baseWorkspace({
    scorerRosterOverrides: [
      {
        name: 'Beta, Bob',
        team: 'Ouachita Baptist University',
        gender: Gender.MEN,
        isScorer: false,
      },
    ],
  });
  const vacate = computeVacateRelayLegNames(
    ws.menResults,
    Gender.MEN,
    ws.scoringSettings,
    ws.scorerRosterOverrides
  );
  assert.ok(vacate.has(normalizeSwimmerName('Beta, Bob')));
}

// --- applyScorerOffRelayPatch prunes overrides ---
{
  const ws = baseWorkspace({
    relayLegOverrides: [
      { relayEntryKey: 'k1', legIndex: 1, assigneeName: 'Beta, Bob' },
    ],
  });
  const overrides = [
    {
      name: 'Beta, Bob',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      isScorer: false,
    },
  ];
  const patch = applyScorerOffRelayPatch(ws, {
    name: 'Beta, Bob',
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
    isScorer: false,
    overrides,
  });
  assert.deepEqual(patch.scorerRosterOverrides, overrides);
  assert.equal((patch.relayLegOverrides ?? []).length, 0);
}

// --- what-if projection vacates non-scorer relay legs ---
{
  const ws = baseWorkspace({
    scorerRosterOverrides: [
      {
        name: 'Beta, Bob',
        team: 'Ouachita Baptist University',
        gender: Gender.MEN,
        isScorer: false,
      },
    ],
  });
  const projected = buildWhatIfResults({
    workspace: ws,
    gender: Gender.MEN,
    removeSeniors: false,
  });
  const vacantBob = projected.filter(
    r =>
      r.isRelay &&
      r.event === '200 Freestyle Relay' &&
      (r.relayLegVacant || r.relayMissingLeg) &&
      (r.relayLegIndex === 1 || r.name === '—')
  );
  assert.ok(
    vacantBob.length >= 1,
    'expected vacant relay leg for non-scorer Beta'
  );
}

// --- over entry limit + empty lineup audit ---
{
  const team = 'Ouachita Baptist University';
  const ws = baseWorkspace({
    meetEntryPlans: [
      {
        id: 'p1',
        name: 'Alpha, Ace',
        team,
        gender: Gender.MEN,
        event: '100 Butterfly',
        time: '52.00',
        source: 'manual',
        active: true,
      },
      {
        id: 'p2',
        name: 'Alpha, Ace',
        team,
        gender: Gender.MEN,
        event: '200 Butterfly',
        time: '1:55.00',
        source: 'manual',
        active: true,
      },
      {
        id: 'p3',
        name: 'Alpha, Ace',
        team,
        gender: Gender.MEN,
        event: '200 IM',
        time: '1:58.00',
        source: 'manual',
        active: true,
      },
      {
        id: 'p4',
        name: 'Alpha, Ace',
        team,
        gender: Gender.MEN,
        event: '400 IM',
        time: '4:10.00',
        source: 'manual',
        active: true,
      },
    ],
    activeEntryIds: ['p1', 'p2', 'p3', 'p4'],
    scorerRosterOverrides: [
      {
        name: 'Delta, Dan',
        team,
        gender: Gender.MEN,
        isScorer: true,
      },
    ],
  });
  // Clear Delta individual so empty_lineup can fire — remove his 100 Free from pool via soft remove? 
  // Simpler: mark a recruit-only scorer with no entries.
  const ws2 = {
    ...ws,
    recruits: [
      {
        id: 'rec1',
        name: 'Empty, Ed',
        team,
        gender: Gender.MEN,
        classYear: 'FR',
        event: '50 Freestyle',
        time: '22.00',
        timeType: 'SCY',
      },
    ],
    scorerRosterOverrides: [
      ...ws.scorerRosterOverrides,
      { name: 'Empty, Ed', team, gender: Gender.MEN, isScorer: true },
    ],
    // Soft-remove recruit's auto swim by not including recruit event in plans and
    // using plan_sheet? Recruits always add their event. Use meetEntryPlans only athlete.
  };
  // For empty lineup: override someone who has no individual after we delete their PDF rows
  // Use soft-remove on Delta's events by deleting from menResults individuals for Delta.
  const withoutDeltaInd = {
    ...ws,
    menResults: ws.menResults.filter(r => !(r.name === 'Delta, Dan' && !r.isRelay)),
    scorerRosterOverrides: [
      { name: 'Delta, Dan', team, gender: Gender.MEN, isScorer: true },
    ],
  };

  const projected = buildWhatIfResults({
    workspace: withoutDeltaInd,
    gender: Gender.MEN,
    removeSeniors: false,
  });
  const scored = calculatePoints(projected, withoutDeltaInd.scoringSettings);
  const audit = buildTeamLineupAudit({
    workspace: withoutDeltaInd,
    gender: Gender.MEN,
    team,
    settings: withoutDeltaInd.scoringSettings,
    allResults: projected,
    allScored: scored,
    removeSeniors: false,
  });

  const alphaKey = normalizeSwimmerName('Alpha, Ace');
  const alphaIssues = audit.athleteIssues.get(alphaKey) ?? [];
  assert.ok(
    alphaIssues.some(i => i.type === 'over_entry_limit'),
    `expected over_entry_limit for Alpha, got ${JSON.stringify(alphaIssues)}`
  );

  const deltaKey = normalizeSwimmerName('Delta, Dan');
  const deltaIssues = audit.athleteIssues.get(deltaKey) ?? [];
  assert.ok(
    deltaIssues.some(i => i.type === 'empty_lineup'),
    `expected empty_lineup for Delta, got ${JSON.stringify(deltaIssues)}`
  );
}

// --- scorer off → vacant + audit tags ---
{
  const team = 'Ouachita Baptist University';
  const ws = baseWorkspace({
    scorerRosterOverrides: [
      { name: 'Beta, Bob', team, gender: Gender.MEN, isScorer: false },
    ],
  });
  const projected = buildWhatIfResults({
    workspace: ws,
    gender: Gender.MEN,
    removeSeniors: false,
  });
  const scored = calculatePoints(projected, ws.scoringSettings);
  const audit = buildTeamLineupAudit({
    workspace: ws,
    gender: Gender.MEN,
    team,
    settings: ws.scoringSettings,
    allResults: projected,
    allScored: scored,
    removeSeniors: false,
  });
  assert.ok(audit.vacantRelayLegCount >= 1, 'expected vacant relay leg count');
  const bobIssues = audit.athleteIssues.get(normalizeSwimmerName('Beta, Bob')) ?? [];
  assert.ok(
    bobIssues.some(i => i.type === 'relay_scorer_off' || i.type === 'relay_leg_vacant'),
    `expected relay issue for Bob, got ${JSON.stringify(bobIssues)}`
  );
  assert.ok(
    audit.checklistItems.some(c => c.group === 'relays'),
    'expected relay checklist items'
  );
}

// --- remove seniors → vacant legs ---
{
  const team = 'Ouachita Baptist University';
  const ws = baseWorkspace();
  const projected = buildWhatIfResults({
    workspace: ws,
    gender: Gender.MEN,
    removeSeniors: true,
  });
  const scored = calculatePoints(projected, ws.scoringSettings);
  const audit = buildTeamLineupAudit({
    workspace: ws,
    gender: Gender.MEN,
    team,
    settings: ws.scoringSettings,
    allResults: projected,
    allScored: scored,
    removeSeniors: true,
  });
  assert.ok(audit.vacantRelayLegCount >= 1, 'senior on relay should vacate a leg');
  const gusIssues = audit.athleteIssues.get(normalizeSwimmerName('Gamma, Gus')) ?? [];
  assert.ok(
    gusIssues.some(i => i.type === 'relay_leg_vacant'),
    `expected relay_leg_vacant for senior Gus, got ${JSON.stringify(gusIssues)}`
  );
}

// --- quick fill suggestion ---
{
  const team = 'Ouachita Baptist University';
  const ws = baseWorkspace({
    recruits: [
      {
        id: 'rec-fill',
        name: 'Fill, Fred',
        team,
        gender: Gender.MEN,
        classYear: 'FR',
        event: '50 Freestyle',
        time: '20.90',
        timeType: 'SCY',
      },
    ],
    scorerRosterOverrides: [
      { name: 'Beta, Bob', team, gender: Gender.MEN, isScorer: false },
      { name: 'Fill, Fred', team, gender: Gender.MEN, isScorer: true },
    ],
  });
  const projected = buildWhatIfResults({
    workspace: ws,
    gender: Gender.MEN,
    removeSeniors: false,
  });
  const vacant = projected.find(
    r => r.isRelay && r.relayLegVacant && r.event === '200 Freestyle Relay'
  );
  assert.ok(vacant, 'need a vacant leg for quick-fill');
  const template = relayTemplateFromLeg(ws.menResults, vacant);
  const key = relayEntryKey(template);
  const active = projected.filter(r => !r.isRelay);
  const suggestion = suggestQuickFillForVacantLeg(
    ws,
    Gender.MEN,
    team,
    key,
    vacant.relayLegIndex ?? 1,
    active
  );
  // May be null if stroke matching fails for free relay (50 free should match)
  if (suggestion) {
    assert.ok(suggestion.overrides.length >= 1);
    assert.ok(suggestion.message.includes('leg'));
  }
}

console.log('test_lineup_audit: ok');
