/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The AutoBuilder panel (U1-b): plans/2026-10-25/D5-AUTOBUILDER.md 12.10 and amendments 4, 6, 7 and 8; user questions G1 and A10.
 *
 * The result of a real run on the recorded simulator config C (tests/helpers/autoBuilderFixtures.ts) is the base for every
 * rendering test. The other result kinds are that result with the fields the kind changes, so each rendering reads a real proposal,
 * real names and a real proof. What these tests pin:
 * - every `AutoBuildResult` kind has plain words, a refusal keeps its code and subject, and every delta carries a sign or a word;
 * - the proof reads "Proven best" or "Gap N points", and in goal seek counts changes and calls `upperBound` a lower bound;
 * - a frozen robust pair reads "not enough swims (n)", and `roster_remove` has its own line;
 * - Accept is blocked on a stale snapshot, on changed inputs, and when the fresh re-score is not above the current lineup;
 * - Accept writes the lineup and the tags, never an entry into the simulator, and lists the entry changes;
 * - the A10 choice is preselected "non-scorer" and "delete" removes the tag.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window as HappyWindow } from 'happy-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUTOBUILD_DEFAULT_LIMITS, AUTOBUILD_DEFAULT_ROBUST } from '@omniswim/engine';
import type { AutoBuildExplanation, AutoBuildProof, AutoBuildProposal, AutoBuildResult } from '@omniswim/engine';
import { AutoBuildResultView } from '../apps/extension/src/dashboard/autoBuilderPanel';
import type { AcceptView, AutoBuildResultViewProps } from '../apps/extension/src/dashboard/autoBuilderPanel';
import { acceptBlock, acceptProposal, defaultRemoveChoices, DEFAULT_REMOVE_CHOICE, writeRosterTags } from '../apps/extension/src/dashboard/autoBuilderAccept';
import type { RemoveChoice } from '../apps/extension/src/dashboard/autoBuilderAccept';
import { DEFAULT_LIMITS, DEFAULT_ROBUST, defaultControls, objectiveOf, prepareRequest, snapshotKey } from '../apps/extension/src/dashboard/autoBuilderRequest';
import { changeLines, explanationLine, frozenPairsOf, headlineOf, proofText, refusalText } from '../apps/extension/src/dashboard/autoBuilderResult';
import type { TaggedResult } from '../apps/extension/src/dashboard/autoBuilderResult';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import { isAutoBuildStatus } from '../apps/extension/src/shared/panelProtocol';
import { configCWorld, nodeScore, realSolveLp, runWorld } from './helpers/autoBuilderFixtures';
import type { ConfigCWorld } from './helpers/autoBuilderFixtures';
import { toSwimCloudId } from '../apps/extension/src/storage';

/** The visible text of rendered markup, with the entities React writes decoded. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

const NO_ACCEPT: AcceptView = { phase: 'idle' };
const view = (tagged: TaggedResult, over: Partial<AutoBuildResultViewProps> = {}): string =>
  renderToStaticMarkup(React.createElement(AutoBuildResultView, { tagged, blockReason: null, accept: NO_ACCEPT, choices: new Map(), ...over }));

let world: ConfigCWorld;
let base: TaggedResult;
let proposal: AutoBuildProposal;

beforeAll(async () => {
  world = await configCWorld();
  base = await runWorld(world);
  if (base.result.kind !== 'improved') throw new Error(`config C did not improve: ${base.result.kind}`);
  proposal = base.result.proposal;
}, 120_000);

const withResult = (result: AutoBuildResult, over: Partial<TaggedResult> = {}): TaggedResult => ({ ...base, result, ...over });
const current = (): AutoBuildResult & { kind: 'improved' } => base.result as AutoBuildResult & { kind: 'improved' };
const proofWith = (over: Partial<AutoBuildProof>): AutoBuildProof => ({ ...current().proof, ...over });

describe('defaults and the objective of the controls', () => {
  it('the dashboard tables equal the engine tables', () => {
    expect(DEFAULT_LIMITS).toStrictEqual(AUTOBUILD_DEFAULT_LIMITS);
    expect(DEFAULT_ROBUST).toStrictEqual(AUTOBUILD_DEFAULT_ROBUST);
  });

  it('maps each mode to its engine objective', () => {
    const c = defaultControls();
    expect(objectiveOf(c)).toStrictEqual({ kind: 'max-own' });
    expect(objectiveOf({ ...c, mode: 'margin', rivalTeamId: '48' })).toStrictEqual({ kind: 'margin', rival: { kind: 'team', teamId: '48' } });
    expect(objectiveOf({ ...c, mode: 'closest' })).toStrictEqual({ kind: 'margin', rival: { kind: 'closest' } });
    expect(objectiveOf({ ...c, mode: 'robust' })).toStrictEqual({ kind: 'robust', ...AUTOBUILD_DEFAULT_ROBUST });
    expect(objectiveOf({ ...c, mode: 'goal-seek', goal: { kind: 'total', points: 1500, rival: 'closest' } })).toStrictEqual({ kind: 'goal-seek', target: { kind: 'total', points: 1500 } });
    expect(objectiveOf({ ...c, mode: 'goal-seek', goal: { kind: 'margin', points: 20, rival: '48' } })).toStrictEqual({ kind: 'goal-seek', target: { kind: 'margin', rival: { kind: 'team', teamId: '48' }, points: 20 } });
  });

  it('builds the request from the store: own tags are coach tags, opponents are suggested, swaps are opt-in', async () => {
    const off = await prepareRequest({ snapshot: world.snapshot, repo: world.repo, solveLp: realSolveLp, controls: defaultControls() });
    const on = await prepareRequest({ snapshot: world.snapshot, repo: world.repo, solveLp: realSolveLp, controls: { ...defaultControls(), proposeSwaps: true, timeLimitSeconds: 20 } });
    if (off.kind !== 'ready' || on.kind !== 'ready') throw new Error('not ready');
    expect(off.request.roster).toBe('fixed');
    expect(on.request.roster).toBe('propose-swaps');
    expect(on.request.limits.timeLimitSeconds).toBe(20);
    expect(off.request.tags.filter((t) => String(t.teamId) === world.ownTeamId).every((t) => t.source === undefined)).toBe(true);
    expect(off.request.tags.some((t) => t.source === 'suggested')).toBe(true);
    expect(off.request.genders).toStrictEqual(['Men']);
    expect(off.inputs.coachTags.map((t) => String(t.swimmerId))).toStrictEqual([...world.pinned]);
  });

  it('says what is missing, and never guesses a team or rules', async () => {
    const empty = await configCWorld();
    try {
      const other = { ...empty.snapshot, settings: { ...empty.snapshot.settings, startDate: '2001-01-01' } };
      const missing = await prepareRequest({ snapshot: other, repo: empty.repo, solveLp: realSolveLp, controls: defaultControls() });
      if (missing.kind !== 'missing') throw new Error('expected missing');
      expect(missing.missing.join(' ')).toMatch(/Choose your team/);
      expect(missing.missing.join(' ')).toMatch(/scoring rules/);
    } finally {
      empty.close();
    }
  }, 60_000);
});

describe('every result kind has plain words', () => {
  const cases: readonly { name: string; make(): AutoBuildResult; title: RegExp; text: RegExp }[] = [
    { name: 'improved', make: () => base.result, title: /Better lineup found/, text: /Proposal/ },
    { name: 'unchanged proven', make: () => ({ kind: 'unchanged', reason: 'proven_no_better', current: current().current, proof: current().proof }), title: /your lineup is the best/, text: /This is proven/ },
    { name: 'unchanged none found', make: () => ({ kind: 'unchanged', reason: 'none_found_within_limits', current: current().current, proof: current().proof }), title: /nothing better found/, text: /not a proof/ },
    { name: 'current meets target', make: () => ({ kind: 'unchanged', reason: 'current_meets_target', current: current().current, proof: current().proof }), title: /already meets the target/, text: /Zero changes are needed/ },
    {
      name: 'current infeasible with an alternative',
      make: () => ({ kind: 'current_infeasible', currentViolations: [{ kind: 'entry_cap', swimmerId: world.pinned[0] as never, which: 'total', count: 5, limit: 4 }], alternative: proposal, current: current().current, proof: current().proof }),
      title: /breaks a hard rule/,
      text: /Rules your current lineup breaks.*has 5 entries; the limit is 4.*Alternative lineup/,
    },
    {
      name: 'current infeasible with none',
      make: () => ({ kind: 'current_infeasible', currentViolations: [], alternative: null, current: current().current, proof: current().proof }),
      title: /breaks a hard rule/,
      text: /no legal alternative/,
    },
    { name: 'target unreachable proven', make: () => ({ kind: 'target_unreachable', reason: 'proven', current: current().current, proof: current().proof }), title: /target cannot be reached/, text: /This is proven/ },
    { name: 'target unreachable within limits', make: () => ({ kind: 'target_unreachable', reason: 'within_limits', current: current().current, proof: current().proof }), title: /No lineup reaching the target was found/, text: /not a proof that none exists/ },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const result = c.make();
      const html = view(withResult(result));
      const text = textOf(html);
      expect(html).toContain(`data-result-kind="${result.kind}"`);
      expect(textOf(html.slice(html.indexOf('data-testid="ab-headline"')))).toMatch(c.title);
      expect(text).toMatch(c.text);
      expect(headlineOf(result).title).toMatch(c.title);
      // A proposal brings Accept; a result without one has none.
      const hasProposal = result.kind === 'improved' || (result.kind === 'current_infeasible' && result.alternative !== null);
      expect(html.includes('data-testid="ab-accept-button"')).toBe(hasProposal);
    });
  }

  it('a refusal keeps its code and subject beside the plain words', () => {
    expect(refusalText('mode_not_built', 'goal-seek-prefer', 'x')).toBe('This mode and load setting are not built together. (mode_not_built: goal-seek-prefer)');
    expect(refusalText('own_team_unknown', null, 'x')).toMatch(/\(own_team_unknown\)$/);
    expect(refusalText('a_new_code', 'subject', 'the engine said this')).toBe('the engine said this (a_new_code: subject)');
  });
});

describe('the point change, the diff and the explanations', () => {
  it('shows the change with a sign and a word', () => {
    const text = textOf(view(base));
    const { current: before } = current();
    expect(text).toMatch(new RegExp(`own points: ${before.objective} to ${proposal.evaluation.objective}, \\+${proposal.evaluation.objective - before.objective} points \\(better\\)`));
  });

  it('lists each entry change with a word and a sign, and the counts add up', () => {
    const lines = changeLines(proposal, base.request.lineup, base.inputs.names);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.text).toMatch(/^(Add|Drop|Move|Enter) /);
      expect(['+', '-', '>']).toContain(l.sign);
    }
    const adds = proposal.entryChanges.filter((c) => c.kind === 'added').length;
    const drops = proposal.entryChanges.length - adds;
    const moves = lines.filter((l) => l.kind === 'move').length;
    expect(lines.length).toBe(adds + drops - moves);
    expect(textOf(view(base))).toMatch(new RegExp(`${proposal.changeCount} changes?:`));
  });

  it('a swimmer dropped from one event and added to another is one move', () => {
    const fake = {
      ...proposal,
      lineup: {
        ...base.request.lineup,
        entries: [
          ...base.request.lineup.entries.filter((e) => e.kind === 'individual').slice(0, 1),
          { kind: 'individual' as const, teamId: world.ownTeamId as never, swimmerId: world.pinned[0] as never, eventKey: 'zz-event' as never, gender: 'Men' as const, seedSwimId: null },
        ],
      },
    };
    const first = base.request.lineup.entries.find((e) => e.kind === 'individual')!;
    const from = { ...first, teamId: world.ownTeamId as never, swimmerId: world.pinned[0] as never };
    const lineupFrom = { ...base.request.lineup, entries: [from] };
    const keyOf = (e: any): string => ['i', e.teamId, e.swimmerId, e.eventKey, e.gender].join('|');
    const to = fake.lineup.entries[1]!;
    const lines = changeLines({ ...fake, entryChanges: [{ kind: 'removed', entryKey: keyOf(from), why: 'replaced' }, { kind: 'added', entryKey: keyOf(to) }] }, lineupFrom, base.inputs.names);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('move');
    expect(lines[0]?.text).toMatch(/^Move .* from .* to zz-event \(Men\)$/);
  });

  const names = { swimmer: (id: string) => `Swimmer ${id}`, team: (id: string) => `Team ${id}` };
  const spots = { numerator: 3, denominator: 1 };
  type Binding = 'entry_cap' | 'session_load' | 'strict_diver_rule' | 'load_penalty' | 'search_limit' | 'objective' | 'teammates';
  const unusual = (binding: Binding): AutoBuildExplanation => ({
    kind: 'unusual_event', entryKey: 'k', swimmerId: 's1' as never, eventKey: '100 Free' as never, gender: 'Men', place: 3, points: 6, seed: 5000 as never, estimated: true,
    otherTeamsAhead: 2, nextOtherTeamBehind: { teamId: 't2' as never, seed: 5100 as never }, marginalPoints: 4,
    skipped: [{ eventKey: '200 Free' as never, placeAlone: 2, marginalPoints: 5, binding }],
  });

  it('explains every explanation kind, roster_remove included', () => {
    const frozen = new Map<string, number>();
    const lines = [
      explanationLine({ kind: 'roster_add', swimmerId: 's2' as never, spotsAfter: spots, marginalPoints: 7 }, names, frozen),
      explanationLine({ kind: 'roster_remove', swimmerId: 's3' as never, spotsAfter: spots, marginalPoints: -2 }, names, frozen),
      explanationLine(unusual('teammates'), names, frozen),
    ];
    expect(lines.map((l) => l.kind)).toStrictEqual(['roster_add', 'roster_remove', 'unusual_event']);
    expect(lines[0]?.text).toBe('Swimmer s2 joins the scoring roster (3/1 spots after). Adds +7 points.');
    expect(lines[1]?.text).toBe('Swimmer s3 leaves the scoring roster (3/1 spots after). Keeping them would add -2 points; their entries stay as non-scorer entries.');
    expect(lines[2]?.text).toMatch(/Swimmer s1 in 100 Free \(Men\): place 3, 6 points, seed 50\.00 \(estimated from a converted time\), 2 entries from other teams ahead; next other team behind: Team t2 at 51\.00\. The entry adds \+4 points\./);
    expect(lines[2]?.skipped[0]).toBe('Not entered in 200 Free: would place 2 alone, +5 points. Why: teammates already there leave it no gain.');
  });

  // Every reason the engine can give for a skipped event, with the exact words the coach reads.
  const BINDING_TEXT: readonly (readonly [Binding, string])[] = [
    ['entry_cap', 'an entry limit stops it'],
    ['session_load', 'the session load limit stops it'],
    ['strict_diver_rule', "the AutoBuilder's conservative diver count stops it (not a meet rule)"],
    ['load_penalty', 'the extra-race penalty is as large as the points it adds'],
    ['search_limit', 'it was not tried within the search limits, so a longer run may enter it'],
    ['objective', 'the chosen objective prefers the entered events'],
    ['teammates', 'teammates already there leave it no gain'],
  ];

  it.each(BINDING_TEXT)('explains the skipped-event reason %s in words', (binding, why) => {
    const line = explanationLine(unusual(binding), names, new Map());
    expect(line.skipped).toStrictEqual([`Not entered in 200 Free: would place 2 alone, +5 points. Why: ${why}.`]);
  });

  it('the reason table covers every binding the engine has', () => {
    expect(BINDING_TEXT.map(([b]) => b).sort()).toStrictEqual(['entry_cap', 'load_penalty', 'objective', 'search_limit', 'session_load', 'strict_diver_rule', 'teammates']);
  });

  it('a skipped event of a frozen robust pair reads "not enough swims (n)", never "a longer run may enter it"', () => {
    const frozen = new Map([[`s1\u0000200 Free\u0000Men`, 2]]);
    const frozenLine = explanationLine(unusual('search_limit'), names, frozen).skipped[0] as string;
    expect(frozenLine).toMatch(/Why: not enough swims \(2\)\.$/);
    expect(frozenLine).not.toMatch(/longer run/);
    const open = explanationLine(unusual('search_limit'), names, new Map()).skipped[0] as string;
    expect(open).toMatch(/a longer run may enter it/);
    // The same through the proof: a frozen pair is listed as such.
    const proof = proofWith({ searchSpace: { ...current().proof.searchSpace, frozenPairs: [{ swimmerId: 's1' as never, eventKey: '200 Free' as never, gender: 'Men', swims: 2 }], restrictions: ['robust_frozen_pairs'] } });
    expect(frozenPairsOf(proof).get(`s1\u0000200 Free\u0000Men`)).toBe(2);
    expect(proofText({ ...current(), proof }, { kind: 'robust', recentSwims: 5, minSwims: 3 }, names).frozen).toStrictEqual(['Swimmer s1 in 200 Free (Men): not enough swims (2)']);
  });

  it('renders the real explanations of the proposal, one list item each, with their text', () => {
    // The fixture must have something to render, or this test proves nothing.
    expect(proposal.explanations.length).toBeGreaterThan(0);
    const html = view(base);
    const count = (html.match(/data-explanation="/g) ?? []).length;
    expect(count).toBe(proposal.explanations.length);
    const text = textOf(html);
    const frozen = frozenPairsOf(current().proof);
    for (const e of proposal.explanations) expect(text).toContain(explanationLine(e, base.inputs.names, frozen).text);
  });

  it('renders every explanation kind and every skipped-event reason as visible text', () => {
    const synthetic: AutoBuildExplanation[] = [
      { kind: 'roster_add', swimmerId: 's2' as never, spotsAfter: spots, marginalPoints: 7 },
      { kind: 'roster_remove', swimmerId: 's3' as never, spotsAfter: spots, marginalPoints: -2 },
      ...BINDING_TEXT.map(([binding]) => unusual(binding)),
    ];
    const html = view(withResult({ ...current(), proposal: { ...proposal, explanations: synthetic } }));
    expect((html.match(/data-explanation="/g) ?? []).length).toBe(synthetic.length);
    for (const kind of ['roster_add', 'roster_remove', 'unusual_event']) expect(html).toContain(`data-explanation="${kind}"`);
    const text = textOf(html);
    expect(text).toContain('joins the scoring roster');
    expect(text).toContain('leaves the scoring roster');
    for (const [, why] of BINDING_TEXT) expect(text).toContain(`Why: ${why}.`);
  });
});

describe('the proof', () => {
  const names = { swimmer: (id: string) => id, team: (id: string) => id };
  const max = { kind: 'max-own' } as const;
  it('reads "Proven best" or "Gap N points"', () => {
    expect(proofText({ ...current(), proof: proofWith({ status: 'proven_optimal' }) }, max, names).headline).toBe('Proven best');
    const gap = proofText({ ...current(), proof: proofWith({ status: 'gap', bestFound: 100, upperBound: 112, gap: 12 }) }, max, names);
    expect(gap.headline).toBe('Gap 12 points');
    expect(gap.detail).toMatch(/No lineup can score above 112/);
    expect(proofText({ ...current(), proof: proofWith({ status: 'unknown', gap: null, upperBound: null }) }, max, names).headline).toBe('No proof');
  });

  it('goal seek counts changes and calls upperBound a lower bound', () => {
    const goal = { kind: 'goal-seek', target: { kind: 'total', points: 1500 } } as const;
    const proven = proofText({ ...current(), proof: proofWith({ status: 'proven_optimal', bestFound: 4 }) }, goal, names);
    expect(proven.headline).toBe('Proven fewest changes');
    expect(proven.detail).toMatch(/fewer than 4 changes/);
    const gap = proofText({ ...current(), proof: proofWith({ status: 'gap', bestFound: 5, upperBound: 3, gap: 2 }) }, goal, names);
    expect(gap.headline).toBe('Gap 2 changes');
    expect(gap.detail).toMatch(/Fewest changes found: 5\. At least 3 changes are needed \(a lower bound\)/);
    for (const t of [proven, gap]) {
      expect(t.headline + t.detail).not.toMatch(/upper bound|points/i);
    }
    const unreachable = proofText({ kind: 'target_unreachable', reason: 'within_limits', current: current().current, proof: proofWith({ bestFound: 0, upperBound: null, gap: null }) }, goal, names);
    expect(unreachable.headline).toBe('Not proven');
    expect(unreachable.detail).not.toMatch(/0 changes/);
  });

  it('is on screen for every result', () => {
    const text = textOf(view(base));
    expect(text).toMatch(/Proof (Proven best|Gap [\d.]+ points|No proof)/);
    expect(text).toMatch(/\d+ solver runs?/);
  });
});

describe('Accept: the blocks', () => {
  it('blocks a stale snapshot before any check, and says why on screen', () => {
    expect(acceptBlock(base, world.snapshot)).toBeNull();
    const changed = { ...world.snapshot, settings: { ...world.snapshot.settings, maxScorersPerTeam: world.snapshot.settings.maxScorersPerTeam + 1 } };
    expect(snapshotKey(changed)).not.toBe(base.snapshotKey);
    const reason = acceptBlock(base, changed);
    expect(reason).toMatch(/simulator changed after this run/);
    const html = view(base, { blockReason: reason });
    expect(textOf(html)).toMatch(/Accept is blocked\. The SwimCloud simulator changed/);
    expect(html).toMatch(/data-testid="ab-accept-button"[^>]*disabled/);
    expect(acceptBlock(withResult({ kind: 'unchanged', reason: 'proven_no_better', current: current().current, proof: current().proof }), world.snapshot)).toMatch(/no proposal/);
  });

  const deps = (over: Partial<Parameters<typeof acceptProposal>[2]> = {}): Parameters<typeof acceptProposal>[2] => ({
    repo: world.repo, solveLp: realSolveLp, score: nodeScore, currentSnapshot: world.snapshot, now: () => '2026-10-31T12:00:00.000Z', newId: () => 'lineup-1', ...over,
  });

  it('blocks when the stored scorer tags changed after the run', async () => {
    const w = await configCWorld();
    try {
      const tagged = await runWorld(w);
      await w.repo.put('tags', { meetKey: w.meetKey, teamId: toSwimCloudId(w.ownTeamId), swimmerId: toSwimCloudId(w.pinned[0] as string), role: 'non-scorer' }, (await w.repo.get('tags', [w.meetKey, toSwimCloudId(w.ownTeamId), toSwimCloudId(w.pinned[0] as string)]) as { found: true; value: { rev: number } }).value.rev);
      const out = await acceptProposal(tagged, new Map(), { ...deps(), repo: w.repo, currentSnapshot: w.snapshot });
      expect(out).toStrictEqual({ kind: 'blocked', reason: 'Your scorer tags changed after this run. Run the AutoBuilder again.' });
      expect(await w.repo.list('lineups')).toHaveLength(0);
    } finally {
      w.close();
    }
  }, 120_000);

  it('blocks when the re-scored proposal is not above the re-scored current lineup, and writes nothing', async () => {
    const same: TaggedResult = withResult({ ...current(), proposal: { ...proposal, lineup: base.request.lineup, tagsForScoring: base.request.tags, entryChanges: [] } });
    const w = await configCWorld();
    try {
      const out = await acceptProposal({ ...same, inputs: base.inputs }, new Map(), { ...deps(), repo: w.repo });
      expect(out.kind).toBe('blocked');
      if (out.kind === 'blocked') {
        expect(out.reason).toMatch(/With fresh opponent rosters the proposal scores \d+ against \d+ for your current lineup \(0\)\. It is not above the current lineup, so it is not accepted/);
      }
      expect(await w.repo.list('lineups')).toHaveLength(0);
      expect(await w.repo.list('tags')).toHaveLength(w.pinned.length);
    } finally {
      w.close();
    }
  }, 120_000);

  it('blocks a goal-seek proposal that misses its target on the fresh score', async () => {
    const reachable = current().current.ownPoints;
    const goal: TaggedResult = { ...base, request: { ...base.request, objective: { kind: 'goal-seek', target: { kind: 'total', points: reachable + 100000 } } } };
    const out = await acceptProposal(goal, new Map(), deps());
    expect(out.kind).toBe('blocked');
    if (out.kind === 'blocked') expect(out.reason).toMatch(/does not reach the target of \d+\. It is not accepted/);
  }, 120_000);
});

describe('Accept: what it writes', () => {
  it('saves the lineup and the tags, writes no entry into the simulator, and lists the entry changes', async () => {
    const w = await configCWorld();
    try {
      const tagged = await runWorld(w);
      if (tagged.result.kind !== 'improved') throw new Error('expected improved');
      const accepted = tagged.result.proposal;
      const before = JSON.stringify(w.snapshot);
      const out = await acceptProposal(tagged, defaultRemoveChoices(accepted), {
        repo: w.repo, solveLp: realSolveLp, score: nodeScore, currentSnapshot: w.snapshot, now: () => '2026-10-31T12:00:00.000Z', newId: () => 'lineup-1',
      });
      if (out.kind !== 'accepted') throw new Error(`blocked: ${out.reason}`);
      expect(out.verified.proposal).toBeGreaterThan(out.verified.current);
      expect(out.lineupId).toBe('lineup-1');
      const row = await w.repo.get('lineups', 'lineup-1');
      if (!row.found) throw new Error('the lineup was not stored');
      expect(row.value.kind).toBe('lineup');
      expect(row.value.meetKey).toBe(w.meetKey);
      expect(row.value.name).toBe(out.lineupName);
      expect(row.value.name).toMatch(/^AutoBuilder: max own points \(2026-10-31\)$/);
      expect(row.value.payload.entries.length).toBe(accepted.lineup.entries.length);
      expect(row.value.builtUnder.rulePreset).toStrictEqual(tagged.inputs.ruleRef);
      // The tags: one scorer tag per roster add, on top of the three that were there.
      const tags = await w.repo.list('tags', { index: 'byMeet', value: w.meetKey });
      expect(tags.filter((t) => t.role === 'scorer')).toHaveLength(w.pinned.length + accepted.rosterAdds.length);
      expect(out.tagsWritten.filter((t) => t.action === 'scorer')).toHaveLength(accepted.rosterAdds.length);
      // The list the coach follows in SwimCloud.
      expect(out.changes.length).toBeGreaterThan(0);
      expect(out.changes.every((l) => /^(Add|Drop|Move|Enter) /.test(l.text))).toBe(true);
      // The simulator snapshot is untouched.
      expect(JSON.stringify(w.snapshot)).toBe(before);
      // On screen: the saved name and the to-do list.
      const text = textOf(view(tagged, { accept: { phase: 'accepted', outcome: out } }));
      expect(text).toContain(`stored as "${out.lineupName}"`);
      expect(text).toMatch(/Make these changes in SwimCloud/);
      expect(text).toContain(out.changes[0]?.text as string);
    } finally {
      w.close();
    }
  }, 180_000);
});

describe('Accept: the roster remove choice (user question A10)', () => {
  const remove = (id: string) => ({ teamId: '58' as never, gender: 'Men' as const, swimmerId: id as never });

  it('preselects "tag them non-scorer" for every swimmer taken off the roster', () => {
    const swap: AutoBuildProposal = { ...proposal, rosterRemoves: [remove(world.pinned[0] as string), remove(world.pinned[1] as string)] };
    expect([...defaultRemoveChoices(swap)]).toStrictEqual([[world.pinned[0], 'non-scorer'], [world.pinned[1], 'non-scorer']]);
    expect(DEFAULT_REMOVE_CHOICE).toBe('non-scorer');
    const html = view(withResult({ ...current(), proposal: swap }), { choices: defaultRemoveChoices(swap) });
    expect(html).toContain('data-testid="ab-remove-choices"');
    for (const id of [world.pinned[0], world.pinned[1]]) {
      const radios = [...html.matchAll(new RegExp(`<input[^>]*name="remove-${id}"[^>]*>`, 'g'))].map((m) => m[0]);
      expect(radios).toHaveLength(2);
      expect(radios.find((r) => r.includes('value="non-scorer"'))).toContain('checked');
      expect(radios.find((r) => r.includes('value="delete"'))).not.toContain('checked');
    }
    expect(textOf(html)).toMatch(/Tag them non-scorer.*Delete their scorer tag/);
  });

  it('shows no question when nobody leaves the roster', () => {
    expect(view(base)).not.toContain('ab-remove-choices');
  });

  it('writes a non-scorer tag by default, deletes the tag on request, and leaves other tags alone', async () => {
    const w = await configCWorld();
    try {
      const [keep, toNon, toDelete] = w.pinned as [string, string, string];
      const swap: AutoBuildProposal = { ...proposal, rosterAdds: [], rosterRemoves: [remove(toNon), remove(toDelete)] };
      const choices = new Map<string, RemoveChoice>([[toDelete, 'delete']]);
      const written = await writeRosterTags(w.repo, w.meetKey, swap, choices);
      expect(written).toStrictEqual([
        { swimmerId: toNon, teamId: '58', action: 'non-scorer' },
        { swimmerId: toDelete, teamId: '58', action: 'deleted' },
      ]);
      const role = async (id: string) => {
        const row = await w.repo.get('tags', [w.meetKey, toSwimCloudId('58'), toSwimCloudId(id)]);
        return row.found ? row.value.role : null;
      };
      expect(await role(keep)).toBe('scorer');
      expect(await role(toNon)).toBe('non-scorer');
      expect(await role(toDelete)).toBeNull();
    } finally {
      w.close();
    }
  });
});

describe('the page panel status line (D5 amendment 7 item 3)', () => {
  it('accepts exactly the four statuses with two finite numbers', () => {
    for (const status of ['running', 'done', 'cancelled', 'failed']) expect(isAutoBuildStatus({ kind: 'auto-build-status', status, elapsedMs: 1, limitMs: 2 })).toBe(true);
    expect(isAutoBuildStatus({ kind: 'auto-build-status', status: 'idle', elapsedMs: 1, limitMs: 2 })).toBe(false);
    expect(isAutoBuildStatus({ kind: 'auto-build-status', status: 'done', elapsedMs: Number.NaN, limitMs: 2 })).toBe(false);
    expect(isAutoBuildStatus({ kind: 'auto-build-status', status: 'done', elapsedMs: '1', limitMs: 2 })).toBe(false);
    expect(isAutoBuildStatus(null)).toBe(false);
    expect(isAutoBuildStatus({ kind: 'scorer-tag-state' })).toBe(false);
  });

  it('shows each status in words in the closed shadow root, and on the host element', () => {
    const win = new HappyWindow();
    let root: ShadowRoot | null = null;
    const attach = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function (init) {
      const r = attach.call(this, init);
      root = r as unknown as ShadowRoot;
      return r;
    };
    win.document.body.append(win.document.createElement('table'));
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    const line = (): HTMLElement => (root as unknown as ShadowRoot).querySelector('[data-osx-auto-build-status]') as HTMLElement;
    const host = (): Element => win.document.querySelector('[data-osx-page-panel]') as unknown as Element;
    expect(line().hidden).toBe(true);
    const expected = {
      running: 'AutoBuilder running: 3.2 s of 10.0 s',
      done: 'AutoBuilder finished in 3.2 s',
      cancelled: 'AutoBuilder cancelled after 3.2 s',
      failed: 'AutoBuilder stopped with an error after 3.2 s',
    } as const;
    for (const status of ['running', 'done', 'cancelled', 'failed'] as const) {
      panel.setAutoBuildStatus({ kind: 'auto-build-status', status, elapsedMs: 3200, limitMs: 10000 });
      expect(line().hidden).toBe(false);
      expect(line().textContent).toBe(expected[status]);
      expect(host().getAttribute('data-osx-auto-build')).toBe(status);
    }
    // A re-render of the scorer section keeps the line, and a remount shows the last status again.
    panel.setScorerState({ kind: 'scorer-tag-state', meetKey: 'm', teams: [], swimmers: [], tags: [], warnings: [] });
    expect(line().textContent).toBe(expected.failed);
    panel.setAutoBuildStatus(null);
    expect(line().hidden).toBe(true);
    expect(host().hasAttribute('data-osx-auto-build')).toBe(false);
    panel.disconnect();
  });
});
