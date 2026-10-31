/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The words of an AutoBuilder result (plans/2026-10-25/D5-AUTOBUILDER.md 12.10 and amendments 4, 6, 8): pure functions from an
 * `AutoBuildResult` to text. No React, no storage, no clock. The panel renders what these return, and the tests read the same text.
 *
 * Rules the text keeps:
 * - Every change carries a sign or a word. Nothing is shown by colour alone (the dark tokens have no good/bad colours).
 * - A proof is "proven best" or "gap N points". In goal seek the proof counts changes: `bestFound` is the change count of the lineup
 *   found and `upperBound` is a LOWER bound on changes (amendment 4 item 4), so it is never called an upper bound.
 * - A skipped event whose pair is a frozen robust pair reads "not enough swims (n)", never "a longer run may enter it" (amendment 6 item 4).
 * - Engine facts are shown as the engine reports them. Nothing here computes a competition value.
 */
import { entryKey, formatHundredths } from '@omniswim/engine';
import type {
  AutoBuildEvaluation,
  AutoBuildExplanation,
  AutoBuildObjective,
  AutoBuildProof,
  AutoBuildProposal,
  AutoBuildRestriction,
  AutoBuildResult,
  EntryChange,
  Lineup,
  LineupEntry,
  RivalRef,
  Violation,
} from '@omniswim/engine';
import type { AutoBuildWireRequest } from '../shared/autobuilderProtocol';
import type { AutoBuildControls, Names, RunInputs } from './autoBuilderRequest';

/** A finished run, tagged with the snapshot and the inputs it came from. Accept is checked against both. */
export interface TaggedResult {
  readonly result: AutoBuildResult;
  readonly request: AutoBuildWireRequest;
  readonly inputs: RunInputs;
  readonly controls: AutoBuildControls;
  /** `snapshotKey(snapshot)` of the snapshot the request was built from. */
  readonly snapshotKey: string;
  readonly loadMs: number;
  readonly wallMs: number;
}

/** The proposal a result carries: `improved` has one, `current_infeasible` may carry an alternative, the others have none. */
export function proposalOf(result: AutoBuildResult): AutoBuildProposal | null {
  if (result.kind === 'improved') return result.proposal;
  if (result.kind === 'current_infeasible') return result.alternative;
  return null;
}

/** A number as a short sign-led delta: `+12`, `-3`, `0`. Fractions keep at most two decimals. */
export function signed(n: number): string {
  const text = plain(Math.abs(n));
  if (n > 0) return `+${text}`;
  if (n < 0) return `-${text}`;
  return '0';
}

/** A number without trailing zeros. */
export function plain(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

const plural = (n: number, one: string, many = `${one}s`): string => `${plain(n)} ${n === 1 ? one : many}`;

/** The word beside a delta, so the sign is never the only cue. */
export function deltaWord(n: number): string {
  return n > 0 ? 'better' : n < 0 ? 'worse' : 'no change';
}

// ---- the objective -------------------------------------------------------------------------------

const isGoalSeek = (o: AutoBuildObjective): o is Extract<AutoBuildObjective, { kind: 'goal-seek' }> => o.kind === 'goal-seek';

function rivalText(rival: RivalRef, names: Names): string {
  return rival.kind === 'closest' ? 'the closest team' : names.team(String(rival.teamId));
}

/** What the objective measures, in points. */
export function metricLabel(objective: AutoBuildObjective, names: Names): string {
  switch (objective.kind) {
    case 'margin':
      return `margin over ${rivalText(objective.rival, names)}`;
    case 'robust':
      return 'own points with robust seeds';
    case 'goal-seek':
      return objective.target.kind === 'total' ? 'own points' : `margin over ${rivalText(objective.target.rival, names)}`;
    default:
      return 'own points';
  }
}

/** The mode in a few words, for the saved lineup name and the status line. */
export function modeLabel(objective: AutoBuildObjective, names: Names): string {
  switch (objective.kind) {
    case 'margin':
      return objective.rival.kind === 'closest' ? 'closest margin' : `margin vs ${rivalText(objective.rival, names)}`;
    case 'robust':
      return 'robust';
    case 'goal-seek':
      return objective.target.kind === 'total' ? `goal seek ${plain(objective.target.points)} points` : `goal seek margin ${plain(objective.target.points)} vs ${rivalText(objective.target.rival, names)}`;
    default:
      return 'max own points';
  }
}

// ---- the headline of each result kind ------------------------------------------------------------

export interface Headline {
  /** `better`: a proposal beats the current lineup. `same`: nothing to change. `blocked`: the current lineup breaks a rule, or the target is out of reach. */
  readonly tone: 'better' | 'same' | 'blocked';
  readonly title: string;
  readonly detail: string;
}

export function headlineOf(result: AutoBuildResult): Headline {
  switch (result.kind) {
    case 'improved':
      return { tone: 'better', title: 'Better lineup found', detail: 'The proposal beats your current lineup. Nothing is written until you accept it.' };
    case 'unchanged':
      if (result.reason === 'proven_no_better') return { tone: 'same', title: 'No change: your lineup is the best', detail: 'Within the search limits, no legal lineup does better. This is proven.' };
      if (result.reason === 'current_meets_target') return { tone: 'same', title: 'No change: your lineup already meets the target', detail: 'Zero changes are needed.' };
      return { tone: 'same', title: 'No change: nothing better found', detail: 'The search found no better lineup within its limits. This is not a proof: a longer run or a wider search may find one.' };
    case 'current_infeasible':
      return {
        tone: 'blocked',
        title: 'Your current lineup breaks a hard rule',
        detail: result.alternative === null ? 'The AutoBuilder found no legal alternative within its limits.' : 'The AutoBuilder found a legal alternative. It is shown below as a proposal.',
      };
    case 'target_unreachable':
      return result.reason === 'proven'
        ? { tone: 'blocked', title: 'The target cannot be reached', detail: 'No legal lineup reaches the target. This is proven.' }
        : { tone: 'blocked', title: 'No lineup reaching the target was found', detail: 'The search found none within its limits. This is not a proof that none exists.' };
  }
}

const REFUSALS: Readonly<Record<string, string>> = {
  own_team_unknown: 'Your team is not in this meet. Choose your team again in the page panel.',
  draft_meet: 'This meet is a draft, so it cannot be scored.',
  nothing_to_build: 'No swimmer of yours can be changed: every one is on a fixed relay, untagged off the roster, or tagged off the scoring roster.',
  own_tag_not_coach: 'One of your own team tags is not a coach tag.',
  rule_unsupported: 'The chosen scoring rules use a setting the AutoBuilder does not build.',
  pending_setting: 'A setting is still pending. Set it in the rules or the session schedule, then run again.',
  unscheduled_event: 'An event is missing from the session schedule. Add it in the meet schedule, then run again.',
  rival_invalid: 'The rival team is not valid for this meet.',
  target_invalid: 'The target is not valid.',
  limits_invalid: 'A limit is not valid.',
  robust_no_spread: 'Robust mode needs swims on different dates, and none are recorded.',
  scale_unsupported: 'A point value cannot be scaled exactly, so the AutoBuilder refuses to guess.',
  model_mismatch: 'The AutoBuilder and the scoring engine disagree about this lineup. Nothing is proposed.',
  mode_not_built: 'This mode and load setting are not built together.',
  scoring_roster_missing: 'A team has entries and no scoring roster. Tag your scorers, and let opponent rosters be suggested.',
  internal: 'The AutoBuilder stopped on an unexpected problem.',
};

/** A refusal in plain words, with the engine's code and subject kept visible. */
export function refusalText(code: string, subject: string | null, message: string): string {
  const words = REFUSALS[code] ?? message;
  return `${words} (${code}${subject === null ? '' : `: ${subject}`})`;
}

// ---- the point change ----------------------------------------------------------------------------

export interface PointChange {
  readonly label: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  readonly word: string;
  /** Own points and load penalty facts, when they add to the objective line. */
  readonly extras: readonly string[];
}

export function pointChangeOf(objective: AutoBuildObjective, current: AutoBuildEvaluation, proposal: AutoBuildEvaluation, names: Names): PointChange {
  const delta = proposal.objective - current.objective;
  const extras: string[] = [];
  if (proposal.ownPoints !== proposal.objective || current.ownPoints !== current.objective) extras.push(`Own points: ${plain(current.ownPoints)} to ${plain(proposal.ownPoints)} (${signed(proposal.ownPoints - current.ownPoints)})`);
  if (proposal.penaltyPoints > 0 || current.penaltyPoints > 0) extras.push(`Load penalty: -${plain(current.penaltyPoints)} to -${plain(proposal.penaltyPoints)} points`);
  if (proposal.robustOwnPoints !== null) extras.push(`Own points with normal seeds: ${plain(proposal.ownPoints)}`);
  return { label: metricLabel(objective, names), before: current.objective, after: proposal.objective, delta, word: deltaWord(delta), extras };
}

// ---- the entry diff ------------------------------------------------------------------------------

export interface ChangeLine {
  readonly kind: 'add' | 'drop' | 'move';
  /** The sign that comes with the word in `text`. */
  readonly sign: '+' | '-' | '>';
  /** What the coach does in SwimCloud, for example "Add Jane Doe to the 200 Free (Women)". */
  readonly text: string;
}

const genderText = (g: string): string => g;

function entryEvent(e: LineupEntry): string {
  return `${e.eventKey} (${genderText(e.gender)})`;
}

/**
 * The coach's to-do list for SwimCloud: adds, drops and moves. A swimmer dropped from one event and added to another is one move.
 * An entry the lineups do not hold is still listed, by its key, never silently skipped.
 */
export function changeLines(proposal: AutoBuildProposal, currentLineup: Lineup, names: Names): ChangeLine[] {
  const proposed = new Map(proposal.lineup.entries.map((e) => [entryKey(e), e] as const));
  const current = new Map(currentLineup.entries.map((e) => [entryKey(e), e] as const));
  const lines: ChangeLine[] = [];
  const added: { change: EntryChange; entry: LineupEntry | undefined }[] = [];
  const dropped: { change: Extract<EntryChange, { kind: 'removed' }>; entry: LineupEntry | undefined }[] = [];
  for (const change of proposal.entryChanges) {
    if (change.kind === 'added') added.push({ change, entry: proposed.get(change.entryKey) });
    else dropped.push({ change, entry: current.get(change.entryKey) });
  }
  const usedAdds = new Set<number>();
  const usedDrops = new Set<number>();
  dropped.forEach((d, di) => {
    if (d.entry?.kind !== 'individual') return;
    const dropEntry = d.entry;
    const ai = added.findIndex((a, i) => !usedAdds.has(i) && a.entry?.kind === 'individual' && a.entry.swimmerId === dropEntry.swimmerId && a.entry.teamId === dropEntry.teamId && a.entry.eventKey !== dropEntry.eventKey);
    if (ai < 0) return;
    const to = added[ai]?.entry as LineupEntry;
    usedAdds.add(ai);
    usedDrops.add(di);
    lines.push({ kind: 'move', sign: '>', text: `Move ${names.swimmer(dropEntry.swimmerId)} from ${entryEvent(dropEntry)} to ${entryEvent(to)}` });
  });
  added.forEach((a, i) => {
    if (usedAdds.has(i)) return;
    const e = a.entry;
    if (e === undefined) lines.push({ kind: 'add', sign: '+', text: `Add the entry ${a.change.entryKey}` });
    else if (e.kind === 'individual') lines.push({ kind: 'add', sign: '+', text: `Add ${names.swimmer(e.swimmerId)} to ${entryEvent(e)}` });
    else lines.push({ kind: 'add', sign: '+', text: `Enter ${names.team(e.teamId)} relay ${e.letter} in ${entryEvent(e)}: ${e.legs.map((l) => names.swimmer(l.swimmerId)).join(', ')}` });
  });
  dropped.forEach((d, i) => {
    if (usedDrops.has(i)) return;
    const e = d.entry;
    const why = d.change.why === 'leg_not_in_search' ? ' (rebuilt: one of its swimmers is no longer on the scoring roster)' : '';
    if (e === undefined) lines.push({ kind: 'drop', sign: '-', text: `Drop the entry ${d.change.entryKey}` });
    else if (e.kind === 'individual') lines.push({ kind: 'drop', sign: '-', text: `Drop ${names.swimmer(e.swimmerId)} from ${entryEvent(e)}` });
    else lines.push({ kind: 'drop', sign: '-', text: `Drop ${names.team(e.teamId)} relay ${e.letter} from ${entryEvent(e)}${why}` });
  });
  return lines;
}

/** The roster changes as sentences: who joins and who leaves the scoring roster. */
export function rosterLines(proposal: AutoBuildProposal, names: Names): { adds: string[]; removes: string[] } {
  return {
    adds: proposal.rosterAdds.map((r) => `${names.swimmer(String(r.swimmerId))} (${names.team(String(r.teamId))}, ${genderText(r.gender)}) joins the scoring roster`),
    removes: proposal.rosterRemoves.map((r) => `${names.swimmer(String(r.swimmerId))} (${names.team(String(r.teamId))}, ${genderText(r.gender)}) leaves the scoring roster`),
  };
}

/** The mix of changes in one sentence. */
export function changeSummary(proposal: AutoBuildProposal): string {
  const adds = proposal.entryChanges.filter((c) => c.kind === 'added').length;
  const drops = proposal.entryChanges.length - adds;
  const parts = [plural(adds, 'entry add'), plural(drops, 'entry drop')];
  if (proposal.rosterAdds.length > 0) parts.push(plural(proposal.rosterAdds.length, 'roster add'));
  if (proposal.rosterRemoves.length > 0) parts.push(plural(proposal.rosterRemoves.length, 'roster remove'));
  return `${plural(proposal.changeCount, 'change')}: ${parts.join(', ')}`;
}

// ---- explanations --------------------------------------------------------------------------------

const BINDING: Readonly<Record<'entry_cap' | 'session_load' | 'strict_diver_rule' | 'load_penalty' | 'search_limit' | 'objective' | 'teammates', string>> = {
  entry_cap: 'an entry limit stops it',
  session_load: 'the session load limit stops it',
  strict_diver_rule: "the AutoBuilder's conservative diver count stops it (not a meet rule)",
  load_penalty: 'the extra-race penalty is as large as the points it adds',
  search_limit: 'it was not tried within the search limits, so a longer run may enter it',
  objective: 'the chosen objective prefers the entered events',
  teammates: 'teammates already there leave it no gain',
};

const pairKey = (swimmerId: string, eventKey: string, gender: string): string => `${swimmerId}\u0000${eventKey}\u0000${gender}`;

/** The frozen robust pairs of a proof, by swimmer, event and gender, with the swim count the rule found. */
export function frozenPairsOf(proof: AutoBuildProof): ReadonlyMap<string, number> {
  return new Map(proof.searchSpace.frozenPairs.map((p) => [pairKey(String(p.swimmerId), p.eventKey, p.gender), p.swims] as const));
}

const spotsText = (s: { numerator: number; denominator: number }): string => `${s.numerator}/${s.denominator} spots`;

export interface ExplanationLine {
  readonly kind: AutoBuildExplanation['kind'];
  readonly text: string;
  /** The skipped events of an `unusual_event`, each with the reason in words. */
  readonly skipped: readonly string[];
}

export function explanationLine(e: AutoBuildExplanation, names: Names, frozen: ReadonlyMap<string, number>): ExplanationLine {
  switch (e.kind) {
    case 'roster_add':
      return { kind: e.kind, skipped: [], text: `${names.swimmer(String(e.swimmerId))} joins the scoring roster (${spotsText(e.spotsAfter)} after). Adds ${signed(e.marginalPoints)} points.` };
    case 'roster_remove':
      return {
        kind: e.kind,
        skipped: [],
        text: `${names.swimmer(String(e.swimmerId))} leaves the scoring roster (${spotsText(e.spotsAfter)} after). Keeping them would add ${signed(e.marginalPoints)} points; their entries stay as non-scorer entries.`,
      };
    case 'unusual_event': {
      const seed = `seed ${formatHundredths(e.seed)}${e.estimated ? ' (estimated from a converted time)' : ''}`;
      const ahead = `${plural(e.otherTeamsAhead, 'entry', 'entries')} from other teams ahead`;
      const next = e.nextOtherTeamBehind === null ? '' : `; next other team behind: ${names.team(String(e.nextOtherTeamBehind.teamId))} at ${formatHundredths(e.nextOtherTeamBehind.seed)}`;
      const skipped = e.skipped.map((s) => {
        const why = s.binding === 'search_limit' && frozen.has(pairKey(String(e.swimmerId), s.eventKey, e.gender)) ? `not enough swims (${frozen.get(pairKey(String(e.swimmerId), s.eventKey, e.gender))})` : BINDING[s.binding];
        return `Not entered in ${s.eventKey}: would place ${s.placeAlone} alone, ${signed(s.marginalPoints)} points. Why: ${why}.`;
      });
      return {
        kind: e.kind,
        skipped,
        text: `${names.swimmer(String(e.swimmerId))} in ${e.eventKey} (${genderText(e.gender)}): place ${e.place}, ${plural(e.points, 'point')}, ${seed}, ${ahead}${next}. The entry adds ${signed(e.marginalPoints)} points.`,
      };
    }
  }
}

// ---- the proof -----------------------------------------------------------------------------------

const RESTRICTIONS: Readonly<Record<AutoBuildRestriction, string>> = {
  scorers_only_entries: 'only scorers are entered',
  relays_within_scoring_cap: 'relays stay within the scoring cap',
  disjoint_relays: 'a swimmer swims one relay per event',
  relay_leg_bases: 'relay legs use recorded splits',
  held_split_entries: 'split-session entries stay as they are',
  strict_diver_weight: "the conservative diver count applies (the current lineup breaks it, so the search leaves it out)",
  robust_frozen_pairs: 'robust mode froze pairs with too few swims',
  fixed_relay_events: 'relays with a fixed swimmer stay as entered',
};

export function restrictionText(r: AutoBuildRestriction): string {
  return RESTRICTIONS[r];
}

export interface ProofText {
  /** The first sentence: "Proven best", "Gap 12 points", and so on. */
  readonly headline: string;
  readonly detail: string;
  readonly restrictions: readonly string[];
  readonly frozen: readonly string[];
  readonly solves: string;
}

export function proofText(result: AutoBuildResult, objective: AutoBuildObjective, names: Names): ProofText {
  const proof = result.proof;
  const goal = isGoalSeek(objective);
  const restrictions = proof.searchSpace.restrictions.map(restrictionText);
  const frozen = proof.searchSpace.frozenPairs.map((p) => `${names.swimmer(String(p.swimmerId))} in ${p.eventKey} (${genderText(p.gender)}): not enough swims (${p.swims})`);
  const stages = proof.solves.length === 0 ? 'no solver runs' : plural(proof.solves.length, 'solver run');
  const solveMs = proof.timings.solveMs;
  const solves = `${stages}${solveMs === null ? '' : `, ${plain(Math.round(solveMs))} ms in the solver`}`;
  if (goal) return { ...goalProof(result, proof), restrictions, frozen, solves };
  const unit = 'points';
  if (proof.status === 'proven_optimal') return { headline: 'Proven best', detail: `No lineup within the search space scores more. Best: ${plain(proof.bestFound)} ${unit}.`, restrictions, frozen, solves };
  if (proof.status === 'gap' && proof.gap !== null && proof.upperBound !== null) {
    return { headline: `Gap ${plain(proof.gap)} ${unit}`, detail: `The best lineup found scores ${plain(proof.bestFound)}. No lineup can score above ${plain(proof.upperBound)}, so a better one may exist.`, restrictions, frozen, solves };
  }
  return { headline: 'No proof', detail: `The best lineup found scores ${plain(proof.bestFound)}. The solver gave no bound, so a better one may exist.`, restrictions, frozen, solves };
}

/** Goal seek counts changes: `bestFound` is the changes of the lineup found, `upperBound` a lower bound on changes. */
function goalProof(result: AutoBuildResult, proof: AutoBuildProof): { headline: string; detail: string } {
  if (result.kind === 'target_unreachable') {
    return result.reason === 'proven'
      ? { headline: 'Proven: no lineup reaches the target', detail: 'The relaxed model has no solution that reaches the target.' }
      : { headline: 'Not proven', detail: 'No lineup reaching the target was found. The search did not show that none exists.' };
  }
  if (result.kind === 'unchanged' && result.reason === 'current_meets_target') return { headline: 'Proven: 0 changes needed', detail: 'Your current lineup already meets the target.' };
  if (proof.status === 'proven_optimal') return { headline: 'Proven fewest changes', detail: `No lineup that reaches the target needs fewer than ${plural(proof.bestFound, 'change')}.` };
  if (proof.status === 'gap' && proof.upperBound !== null && proof.gap !== null) {
    return { headline: `Gap ${plural(proof.gap, 'change')}`, detail: `Fewest changes found: ${proof.bestFound}. At least ${plural(proof.upperBound, 'change')} are needed (a lower bound), so a lineup with fewer changes may exist.` };
  }
  return { headline: 'No proof', detail: `Fewest changes found: ${proof.bestFound}. The solver gave no bound on the fewest changes.` };
}

// ---- violations ----------------------------------------------------------------------------------

/** A rule warning in words. An unknown kind still shows its kind and the swimmer or event it names. */
export function describeViolation(v: Violation, names: Names): string {
  switch (v.kind) {
    case 'entry_cap':
      return `${names.swimmer(String(v.swimmerId))} has ${plural(v.count, v.which === 'total' ? 'entry' : `${v.which} entry`, v.which === 'total' ? 'entries' : `${v.which} entries`)}; the limit is ${v.limit}.`;
    case 'session_load':
      return `${names.swimmer(String(v.swimmerId))} swims ${plural(v.races, 'race')} on day ${v.session.day} (${v.session.slot}); the limit is ${v.limit}.`;
    case 'scorer_without_entry':
      return `${names.swimmer(String(v.swimmerId))} is a scorer with no entry, and still takes a roster spot.`;
    default: {
      const o = v as unknown as Record<string, unknown>;
      const who = typeof o.swimmerId === 'string' ? ` (${names.swimmer(o.swimmerId)})` : '';
      const where = typeof o.eventKey === 'string' ? ` in ${o.eventKey}` : '';
      return `${v.kind.replace(/_/g, ' ')}${who}${where}`;
    }
  }
}
