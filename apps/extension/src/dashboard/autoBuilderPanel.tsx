/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The AutoBuilder panel (plans/2026-10-25/D5-AUTOBUILDER.md 12.10, amendments 4 to 8; user questions G1 and A10).
 *
 * `AutoBuilderPanel` is the stateful part: controls, Run and Cancel through `createAutoBuildClient`, progress, and Accept. The words of a
 * result come from `autoBuilderResult.ts` and the Accept rules from `autoBuilderAccept.ts`. `AutoBuildResultView` only lays them out, so a
 * test can render every result kind to a string.
 *
 * Nothing here colours a state. Every delta has a sign and a word, every block has a sentence. Colours come from the `--osx-*` tokens of
 * dashboard.css, which carry the light and dark themes.
 *
 * Kept self-contained so a later slice can move it into a "Build" tab: the host passes the snapshot, the repo, the optimizer's solver and a
 * status sink, and nothing else.
 */
import * as React from 'react';
import type { LpSolve } from '@omniswim/engine';
import type { SimSnapshot } from '../shared/bridgeSchema';
import type { AutoBuildStatusMessage } from '../shared/panelProtocol';
import type { StorageRepo } from '../storage';
import { AUTOBUILD_CANCELLED, AutoBuildRunError, createAutoBuildClient } from './autobuilderClient';
import type { AutoBuildClient } from './autobuilderClient';
import { acceptBlock, acceptProposal, defaultRemoveChoices } from './autoBuilderAccept';
import type { AcceptOutcome, RemoveChoice } from './autoBuilderAccept';
import { defaultControls, meetKeyForSnapshot, prepareRequest, snapshotKey, TIME_LIMIT_RANGE } from './autoBuilderRequest';
import type { AutoBuildControls, ModeChoice } from './autoBuilderRequest';
import {
  changeLines,
  changeSummary,
  describeViolation,
  explanationLine,
  frozenPairsOf,
  headlineOf,
  metricLabel,
  plain,
  pointChangeOf,
  proofText,
  proposalOf,
  refusalText,
  rosterLines,
  signed,
} from './autoBuilderResult';
import type { TaggedResult } from './autoBuilderResult';

// ---- the result view -------------------------------------------------------------------------------

export type AcceptView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'blocked'; readonly reason: string }
  | { readonly phase: 'accepted'; readonly outcome: Extract<AcceptOutcome, { kind: 'accepted' }> }
  | { readonly phase: 'error'; readonly message: string };

export interface AutoBuildResultViewProps {
  readonly tagged: TaggedResult;
  /** Why Accept is blocked before any check (a stale snapshot), or `null`. */
  readonly blockReason: string | null;
  readonly accept: AcceptView;
  readonly choices: ReadonlyMap<string, RemoveChoice>;
  readonly onChoice?: (swimmerId: string, choice: RemoveChoice) => void;
  readonly onAccept?: () => void;
}

const sec = (ms: number): string => `${plain(Math.round(ms / 100) / 10)} s`;

/** One line of a list that begins with a sign. The sign is for the eye, the word after it is for everyone. */
function SignedItem({ sign, children }: { sign: string; children: React.ReactNode }) {
  return (
    <li>
      <span className="osx-ab-sign" aria-hidden="true">{sign}</span> {children}
    </li>
  );
}

function ProposalSection({ tagged, blockReason, accept, choices, onChoice, onAccept }: AutoBuildResultViewProps) {
  const proposal = proposalOf(tagged.result);
  if (proposal === null) return null;
  const { names } = tagged.inputs;
  const lines = changeLines(proposal, tagged.request.lineup, names);
  const roster = rosterLines(proposal, names);
  const change = tagged.result.kind === 'improved' ? pointChangeOf(tagged.request.objective, tagged.result.current, proposal.evaluation, names) : null;
  const frozen = frozenPairsOf(tagged.result.proof);
  const busy = accept.phase === 'checking' || accept.phase === 'accepted';
  return (
    <>
      <section className="osx-ab-block" data-testid="ab-proposal">
        <h4>{tagged.result.kind === 'current_infeasible' ? 'Alternative lineup' : 'Proposal'}</h4>
        {change !== null && (
          <p className="osx-ab-points" data-testid="ab-points">
            {change.label}: {plain(change.before)} to {plain(change.after)}, <strong>{signed(change.delta)} points ({change.word})</strong>
          </p>
        )}
        {change?.extras.map((x) => <p key={x} className="osx-ab-note">{x}</p>)}
        <p className="osx-ab-note" data-testid="ab-change-summary">{changeSummary(proposal)}</p>
        <h5>Entry changes</h5>
        {lines.length === 0 ? <p className="osx-ab-note">No entry changes.</p> : (
          <ol className="osx-ab-list" data-testid="ab-entry-changes">{lines.map((l) => <SignedItem key={l.text} sign={l.sign}>{l.text}</SignedItem>)}</ol>
        )}
        {(roster.adds.length > 0 || roster.removes.length > 0) && (
          <>
            <h5>Scoring roster</h5>
            <ul className="osx-ab-list" data-testid="ab-roster-changes">
              {roster.adds.map((t) => <SignedItem key={t} sign="+">{t}</SignedItem>)}
              {roster.removes.map((t) => <SignedItem key={t} sign="-">{t}</SignedItem>)}
            </ul>
          </>
        )}
        {proposal.newWarnings.length > 0 && (
          <>
            <h5>New warnings</h5>
            <ul className="osx-ab-list" data-testid="ab-warnings">{proposal.newWarnings.map((v, i) => <SignedItem key={i} sign="!">{describeViolation(v, names)}</SignedItem>)}</ul>
          </>
        )}
      </section>
      <section className="osx-ab-block" data-testid="ab-explanations">
        <h4>Why</h4>
        {proposal.explanations.length === 0 ? <p className="osx-ab-note">No swimmer is placed in an unusual event, and nobody joins or leaves the roster.</p> : (
          <ul className="osx-ab-list">
            {proposal.explanations.map((e, i) => {
              const line = explanationLine(e, names, frozen);
              return (
                <li key={i} data-explanation={line.kind}>
                  {line.text}
                  {line.skipped.length > 0 && <ul>{line.skipped.map((s) => <li key={s}>{s}</li>)}</ul>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="osx-ab-block" data-testid="ab-accept">
        <h4>Accept</h4>
        <p className="osx-ab-note">Accept saves your scorer tags and the proposed lineup in OmniSwim, then lists the entry changes for you to make in SwimCloud. It never changes SwimCloud's simulator.</p>
        {proposal.rosterRemoves.length > 0 && (
          <fieldset className="osx-ab-fieldset" data-testid="ab-remove-choices">
            <legend>Swimmers taken off the scoring roster: what should Accept do with their scorer tag?</legend>
            {proposal.rosterRemoves.map((r) => {
              const id = String(r.swimmerId);
              const name = names.swimmer(id);
              const value = choices.get(id) ?? 'non-scorer';
              return (
                <div key={id} role="radiogroup" aria-label={`Scorer tag of ${name}`} className="osx-ab-choice">
                  <strong>{name}</strong>
                  <label><input type="radio" name={`remove-${id}`} value="non-scorer" checked={value === 'non-scorer'} disabled={busy} onChange={() => onChoice?.(id, 'non-scorer')} /> Tag them non-scorer (keeps them off until you change it)</label>
                  <label><input type="radio" name={`remove-${id}`} value="delete" checked={value === 'delete'} disabled={busy} onChange={() => onChoice?.(id, 'delete')} /> Delete their scorer tag (a later run may add them back)</label>
                </div>
              );
            })}
          </fieldset>
        )}
        {blockReason !== null && <p role="alert" className="osx-ab-stale" data-testid="ab-block">Accept is blocked. {blockReason}</p>}
        <button type="button" data-testid="ab-accept-button" disabled={blockReason !== null || busy} onClick={onAccept}>
          {accept.phase === 'checking' ? 'Checking with fresh opponent rosters' : accept.phase === 'accepted' ? 'Accepted' : 'Accept proposal'}
        </button>
        {accept.phase === 'blocked' && <p role="alert" className="osx-ab-stale" data-testid="ab-block">Accept is blocked. {accept.reason}</p>}
        {accept.phase === 'error' && <p role="alert" className="osx-ab-stale" data-testid="ab-accept-error">{accept.message}</p>}
        {accept.phase === 'accepted' && <AcceptedSection outcome={accept.outcome} />}
      </section>
    </>
  );
}

function AcceptedSection({ outcome }: { outcome: Extract<AcceptOutcome, { kind: 'accepted' }> }) {
  return (
    <div role="status" data-testid="ab-accepted">
      <p><strong>Saved.</strong> The lineup is stored as "{outcome.lineupName}". Re-scored with fresh opponent rosters: {plain(outcome.verified.current)} to {plain(outcome.verified.proposal)} ({signed(outcome.verified.proposal - outcome.verified.current)}).</p>
      {outcome.tagsWritten.length > 0 && (
        <p className="osx-ab-note">Scorer tags written: {outcome.tagsWritten.map((t) => `${t.swimmerId} ${t.action}`).join(', ')}.</p>
      )}
      <h5>Make these changes in SwimCloud</h5>
      {outcome.changes.length === 0 ? <p className="osx-ab-note">No entry changes to make.</p> : (
        <ol className="osx-ab-list" data-testid="ab-todo">{outcome.changes.map((l) => <SignedItem key={l.text} sign={l.sign}>{l.text}</SignedItem>)}</ol>
      )}
    </div>
  );
}

/** Everything a finished run shows. It reads only its props, so a test can render it to a string. */
export function AutoBuildResultView(props: AutoBuildResultViewProps) {
  const { tagged } = props;
  const { result, inputs, request } = tagged;
  const head = headlineOf(result);
  const proof = proofText(result, request.objective, inputs.names);
  return (
    <div className="osx-ab-result" data-testid="ab-result" data-result-kind={result.kind}>
      <h3 data-testid="ab-headline">{head.title}</h3>
      <p>{head.detail}</p>
      <p className="osx-ab-note">Measured as: {metricLabel(request.objective, inputs.names)}. Your lineup: {plain(result.current.objective)}.</p>
      {result.kind === 'current_infeasible' && (
        <section className="osx-ab-block" data-testid="ab-violations">
          <h4>Rules your current lineup breaks</h4>
          <ul className="osx-ab-list">{result.currentViolations.map((v, i) => <SignedItem key={i} sign="!">{describeViolation(v, inputs.names)}</SignedItem>)}</ul>
        </section>
      )}
      <ProposalSection {...props} />
      <section className="osx-ab-block" data-testid="ab-proof">
        <h4>Proof</h4>
        <p><strong data-testid="ab-proof-headline">{proof.headline}</strong>. {proof.detail}</p>
        {proof.frozen.length > 0 && (
          <>
            <h5>Frozen pairs</h5>
            <ul className="osx-ab-list" data-testid="ab-frozen">{proof.frozen.map((f) => <li key={f}>{f}</li>)}</ul>
          </>
        )}
        <details>
          <summary>What the search covered</summary>
          <ul className="osx-ab-list">{proof.restrictions.map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="osx-ab-note">{proof.solves}. HiGHS load {sec(tagged.loadMs)}, run {sec(tagged.wallMs)}.</p>
        </details>
      </section>
    </div>
  );
}

// ---- the panel --------------------------------------------------------------------------------------

type Phase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'preparing' }
  | { readonly phase: 'running'; readonly solvesDone: number; readonly elapsedMs: number; readonly limitMs: number }
  | { readonly phase: 'done'; readonly tagged: TaggedResult }
  | { readonly phase: 'missing'; readonly missing: readonly string[] }
  | { readonly phase: 'refused'; readonly text: string }
  | { readonly phase: 'cancelled' }
  | { readonly phase: 'failed'; readonly message: string };

export interface AutoBuilderPanelProps {
  readonly snapshot: SimSnapshot;
  readonly repoForMeet: () => Promise<StorageRepo>;
  /** The solver of `optimizer.worker`, for opponent rosters. */
  readonly solveLp: LpSolve;
  /** Told when a run starts, ticks, ends or is cancelled. The host forwards it to the page panel. */
  readonly onStatus?: (message: AutoBuildStatusMessage) => void;
  /** A test passes its own client. */
  readonly client?: AutoBuildClient;
  /** A clock for the elapsed time, in ms. */
  readonly now?: () => number;
}

const MODES: readonly { readonly value: ModeChoice; readonly label: string }[] = [
  { value: 'max-own', label: 'Most own points' },
  { value: 'margin', label: 'Biggest margin over a chosen rival' },
  { value: 'closest', label: 'Biggest margin over the closest team' },
  { value: 'robust', label: 'Robust: use recent swims' },
  { value: 'goal-seek', label: 'Goal seek: fewest changes that reach a target' },
];

/** The failure state and the page-panel status for an error thrown by a run. */
function failureOf(cause: unknown): { readonly state: Phase; readonly status: AutoBuildStatusMessage['status'] } {
  if (cause instanceof Error && cause.message === AUTOBUILD_CANCELLED) return { state: { phase: 'cancelled' }, status: 'cancelled' };
  if (cause instanceof AutoBuildRunError) return { state: { phase: 'refused', text: refusalText(cause.code, cause.subject, cause.message) }, status: 'failed' };
  return { state: { phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) }, status: 'failed' };
}

const limitInRange = (seconds: number): boolean => Number.isFinite(seconds) && seconds >= TIME_LIMIT_RANGE.min && seconds <= TIME_LIMIT_RANGE.max;

/** True when goal seek has a target and a margin run has a rival that is a team in this meet. */
function controlsReady(controls: AutoBuildControls, teams: readonly { readonly id: string }[]): boolean {
  if (controls.mode === 'goal-seek' && !Number.isFinite(controls.goal.points)) return false;
  return controls.mode !== 'margin' || teams.some((t) => t.id === controls.rivalTeamId);
}

export function AutoBuilderPanel({ snapshot, repoForMeet, solveLp, onStatus, client, now = () => performance.now() }: AutoBuilderPanelProps) {
  const [controls, setControls] = React.useState<AutoBuildControls>(defaultControls);
  const [state, setState] = React.useState<Phase>({ phase: 'idle' });
  const [accept, setAccept] = React.useState<AcceptView>({ phase: 'idle' });
  const [choices, setChoices] = React.useState<ReadonlyMap<string, RemoveChoice>>(new Map());
  const clientRef = React.useRef<AutoBuildClient | undefined>(client);
  clientRef.current ??= createAutoBuildClient();
  const snapshotRef = React.useRef(snapshot);
  snapshotRef.current = snapshot;
  const timer = React.useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const statusSink = React.useRef(onStatus);
  statusSink.current = onStatus;
  const teams = React.useMemo(() => snapshot.teams.map((t) => ({ id: String(t.id), name: t.name })), [snapshot]);
  const currentKey = React.useMemo(() => snapshotKey(snapshot), [snapshot]);

  const stopTimer = (): void => {
    if (timer.current !== undefined) clearInterval(timer.current);
    timer.current = undefined;
  };
  React.useEffect(() => () => { stopTimer(); clientRef.current?.cancel(); }, []);

  const set = (patch: Partial<AutoBuildControls>): void => setControls((c) => ({ ...c, ...patch }));
  const emit = (status: AutoBuildStatusMessage['status'], elapsedMs: number, limitMs: number): void => statusSink.current?.({ kind: 'auto-build-status', status, elapsedMs, limitMs });

  const run = async (): Promise<void> => {
    const limitMs = controls.timeLimitSeconds * 1000;
    setAccept({ phase: 'idle' });
    setState({ phase: 'preparing' });
    const taggedKey = snapshotKey(snapshotRef.current);
    const startedAt = now();
    try {
      const repo = await repoForMeet();
      const prepared = await prepareRequest({ snapshot: snapshotRef.current, repo, solveLp, controls });
      if (prepared.kind === 'missing') {
        setState({ phase: 'missing', missing: prepared.missing });
        return;
      }
      const clientNow = clientRef.current as AutoBuildClient;
      let solvesDone = 0;
      const tick = (): void => {
        const elapsedMs = now() - startedAt;
        setState({ phase: 'running', solvesDone, elapsedMs, limitMs });
        emit('running', elapsedMs, limitMs);
      };
      tick();
      timer.current = setInterval(tick, 250);
      const { result, loadMs, wallMs } = await clientNow.runTimed(prepared.request, (p) => { solvesDone = p.solvesDone; });
      stopTimer();
      const tagged: TaggedResult = { result, request: prepared.request, inputs: prepared.inputs, controls, snapshotKey: taggedKey, loadMs, wallMs };
      const proposal = proposalOf(result);
      setChoices(proposal === null ? new Map() : defaultRemoveChoices(proposal));
      setState({ phase: 'done', tagged });
      emit('done', now() - startedAt, limitMs);
    } catch (cause) {
      stopTimer();
      const elapsed = now() - startedAt;
      const failure = failureOf(cause);
      setState(failure.state);
      emit(failure.status, elapsed, limitMs);
    }
  };

  const doAccept = async (tagged: TaggedResult): Promise<void> => {
    setAccept({ phase: 'checking' });
    try {
      const repo = await repoForMeet();
      const outcome = await acceptProposal(tagged, choices, { repo, solveLp, score: (req, lineup, tags, scaleD) => (clientRef.current as AutoBuildClient).score(req, lineup, tags, scaleD), currentSnapshot: () => snapshotRef.current, now: () => new Date().toISOString(), newId: () => crypto.randomUUID() });
      setAccept(outcome.kind === 'blocked' ? { phase: 'blocked', reason: outcome.reason } : { phase: 'accepted', outcome });
    } catch (cause) {
      setAccept({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const running = state.phase === 'running';
  const busy = running || state.phase === 'preparing';
  const rivals = teams;
  const limitOk = limitInRange(controls.timeLimitSeconds);
  const canRun = !busy && limitOk && controlsReady(controls, teams);
  const meetKey = React.useMemo(() => meetKeyForSnapshot(snapshot), [snapshot]);

  return (
    <section className="osx-results osx-ab" data-testid="autobuilder-panel" data-meet={meetKey}>
      <h2>AutoBuilder</h2>
      <form className="osx-ab-controls" onSubmit={(e) => e.preventDefault()}>
        <label>
          Goal
          <select aria-label="AutoBuilder goal" data-testid="ab-mode" value={controls.mode} disabled={busy} onChange={(e) => set({ mode: e.target.value as ModeChoice })}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        {controls.mode === 'margin' && (
          <label>
            Rival
            <select aria-label="Rival team" data-testid="ab-rival" value={controls.rivalTeamId} disabled={busy} onChange={(e) => set({ rivalTeamId: e.target.value })}>
              <option value="">Choose a team</option>
              {rivals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        {controls.mode === 'robust' && (
          <>
            <label>Recent swims to use <input type="number" min="1" aria-label="Recent swims" value={controls.robust.recentSwims} disabled={busy} onChange={(e) => set({ robust: { ...controls.robust, recentSwims: Number(e.target.value) } })} /></label>
            <label>Fewest swims to trust a pair <input type="number" min="1" aria-label="Fewest swims" value={controls.robust.minSwims} disabled={busy} onChange={(e) => set({ robust: { ...controls.robust, minSwims: Number(e.target.value) } })} /></label>
          </>
        )}
        {controls.mode === 'goal-seek' && (
          <>
            <label>
              Target
              <select aria-label="Target kind" data-testid="ab-goal-kind" value={controls.goal.kind} disabled={busy} onChange={(e) => set({ goal: { ...controls.goal, kind: e.target.value as 'total' | 'margin' } })}>
                <option value="total">Own points</option>
                <option value="margin">Margin over a team</option>
              </select>
            </label>
            {controls.goal.kind === 'margin' && (
              <label>
                Over
                <select aria-label="Target rival" value={controls.goal.rival} disabled={busy} onChange={(e) => set({ goal: { ...controls.goal, rival: e.target.value } })}>
                  <option value="closest">The closest team</option>
                  {rivals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            <label>Points to reach <input type="number" aria-label="Target points" data-testid="ab-goal-points" value={Number.isFinite(controls.goal.points) ? controls.goal.points : ''} disabled={busy} onChange={(e) => set({ goal: { ...controls.goal, points: e.target.value === '' ? Number.NaN : Number(e.target.value) } })} /></label>
          </>
        )}
        <label className="osx-ab-check">
          <input type="checkbox" data-testid="ab-swaps" checked={controls.proposeSwaps} disabled={busy} onChange={(e) => set({ proposeSwaps: e.target.checked })} /> Propose roster swaps (may take a tagged scorer off the scoring roster)
        </label>
        <label>
          Time limit (seconds)
          <input type="number" aria-label="Time limit in seconds" data-testid="ab-limit" min={TIME_LIMIT_RANGE.min} max={TIME_LIMIT_RANGE.max} value={Number.isFinite(controls.timeLimitSeconds) ? controls.timeLimitSeconds : ''} disabled={busy} onChange={(e) => set({ timeLimitSeconds: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />
        </label>
        {!limitOk && <p role="alert" className="osx-ab-stale">The time limit must be from {TIME_LIMIT_RANGE.min} to {TIME_LIMIT_RANGE.max} seconds.</p>}
        <p className="osx-ab-note">Session load follows "Meet schedule and athlete load" above. It is read when you press Run.</p>
        <div className="osx-ab-buttons">
          <button type="button" data-testid="ab-run" disabled={!canRun} onClick={() => void run()}>Run AutoBuilder</button>
          <button type="button" data-testid="ab-cancel" disabled={!running} onClick={() => clientRef.current?.cancel()}>Cancel</button>
        </div>
      </form>
      <div className="osx-ab-status" role="status" aria-live="polite" data-testid="ab-status" data-phase={state.phase}>
        {state.phase === 'preparing' && 'Preparing the request and the opponent rosters'}
        {state.phase === 'running' && `Running: ${state.solvesDone} ${state.solvesDone === 1 ? 'solve' : 'solves'} done, ${sec(state.elapsedMs)} of ${sec(state.limitMs)}`}
        {state.phase === 'cancelled' && 'Cancelled. Nothing was changed.'}
        {state.phase === 'failed' && `The AutoBuilder failed: ${state.message}`}
        {state.phase === 'refused' && state.text}
        {state.phase === 'missing' && (<>Cannot run yet:<ul>{state.missing.map((m) => <li key={m}>{m}</li>)}</ul></>)}
      </div>
      {state.phase === 'done' && (
        <AutoBuildResultView
          tagged={state.tagged}
          blockReason={acceptBlock(state.tagged, snapshot)}
          accept={accept}
          choices={choices}
          onChoice={(id, choice) => setChoices((m) => new Map(m).set(id, choice))}
          onAccept={() => void doAccept(state.tagged)}
        />
      )}
      {state.phase === 'done' && state.tagged.snapshotKey !== currentKey && <p className="osx-ab-note" data-testid="ab-stale">This result is from an earlier simulator state.</p>}
    </section>
  );
}
