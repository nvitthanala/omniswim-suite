/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Save a snapshot of the live simulator (D6 section 1, "Save"): a `LineupRecord` of kind `snapshot`. It holds the lineup the simulator shows, the
 * engine's results for it, the report facts (`captureReportFacts`, the seed times and class years only the live model knows), and the scorer tags
 * the coach had then, with the opponent rosters the extension suggested. A snapshot never changes after it is saved.
 *
 * The lineup, its results and the record share one meet key (`meetKeyForSnapshot`): the storage validator requires the payload key to equal the
 * record key. The results are the engine's scoring of the live model's entries. In Simulator (current) that is the simulator's own lineup, the table
 * the Score tab shows and checks against SwimCloud. The tags are stored for the record, they do not change the results.
 *
 * The record loads the live model once (`deps.loadLive`) and reads it for the lineup, the results, the facts and the suggestions. A roster season
 * is refused: `builtUnder` cannot record it yet (F1.3b), and a saved record must say what it was built under (user question U14).
 */
import { captureReportFacts, requireComplete, scoreMeet } from '@omniswim/engine';
import type { LpSolve } from '@omniswim/engine';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { readScorerOwnTeam, readScorerRulePreset, readSessionPreset, resolveRulePreset } from '../storage';
import type { LineupRecord, StorageRepo } from '../storage';
import type { UndoStack } from '../storage';
import { readCoachTags } from './autoBuilderRequest';
import { meetKeyForSnapshot } from './meetKey';
import { suggestedTags, suggestOpponentRosters } from './suggestedRosters';
import type { LiveLoader } from './liveModel';

export interface SaveSnapshotDeps {
  readonly repo: StorageRepo;
  /** The solver of `optimizer.worker`, for the opponent rosters. */
  readonly solveLp: LpSolve;
  /** Loads the live model of the snapshot (D7 decision L). `buildSnapshotRecord` calls it once. */
  readonly loadLive: LiveLoader;
  readonly now: () => string;
  readonly newId: () => string;
  readonly undoStack?: UndoStack;
}

export type SaveSnapshotOutcome =
  | { readonly kind: 'saved'; readonly lineupId: string; readonly name: string; readonly coachTags: number; readonly suggestedTags: number }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] };

export type SnapshotRecord = Omit<LineupRecord, 'rev' | 'updatedAt'>;
export type BuiltSnapshot =
  | { readonly kind: 'built'; readonly record: SnapshotRecord; readonly coachTags: number; readonly suggestedTags: number }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] };

/** "Snapshot 2026-10-31 14:05" from an ISO time. */
export const defaultSnapshotName = (iso: string): string => `Snapshot ${iso.slice(0, 16).replace('T', ' ')}`;

/** The record `saveSnapshot` would store, or the reasons it cannot be made. Nothing is written. */
export async function buildSnapshotRecord(snapshot: SimSnapshot, name: string, deps: SaveSnapshotDeps): Promise<BuiltSnapshot> {
  const { repo } = deps;
  const meetKey = meetKeyForSnapshot(snapshot);
  const loaded = await deps.loadLive(snapshot);
  if (loaded.kind === 'not_loaded') return { kind: 'refused', reasons: ['SwimCloud has not loaded the simulator results yet.'] };
  if (loaded.kind === 'error') return { kind: 'refused', reasons: [loaded.reason] };
  const { live } = loaded;
  if (!live.adapted.preset.complete) return { kind: 'refused', reasons: [`The simulator rules are not complete yet: ${live.adapted.preset.pending.join(', ')}.`] };
  if (live.choice.kind === 'season') return { kind: 'refused', reasons: ['Saved snapshots cannot record a roster season yet.'] };
  const ruleRef = await readScorerRulePreset(repo, meetKey);
  const rules = ruleRef === undefined ? undefined : await resolveRulePreset(repo, ruleRef);
  if (ruleRef === undefined || rules === undefined || !rules.found) return { kind: 'refused', reasons: ['Choose your OmniSwim scoring rules in the page panel first. A snapshot records the rules it was made under.'] };

  const coach = await readCoachTags(repo, meetKey);
  const ownTeamId = await readScorerOwnTeam(repo, meetKey);
  const suggestions = ownTeamId === undefined ? [] : await suggestOpponentRosters(live, String(ownTeamId), coach, rules.value, deps.solveLp);
  // The store keeps a suggested tag under `tags.suggested`: that category already says where it came from, and the validator allows no `source` key.
  const suggested = suggestedTags(suggestions).map(({ teamId, swimmerId, role }) => ({ teamId, swimmerId, role }));
  const selected = await readSessionPreset(repo, meetKey);

  const lineupId = deps.newId();
  const savedName = name.trim() === '' ? defaultSnapshotName(deps.now()) : name.trim();
  const record: SnapshotRecord = {
    lineupId,
    meetKey,
    name: savedName,
    kind: 'snapshot',
    payloadVersion: 1,
    payload: live.lineup,
    origin: { kind: 'local' },
    createdAt: deps.now(),
    builtUnder: {
      rulePreset: ruleRef,
      ...(rules.rev === undefined ? {} : { rulePresetRev: rules.rev }),
      rulePresetValues: rules.value,
      ...(selected.ref === undefined || selected.preset === undefined ? {} : { sessionPreset: selected.ref, sessionPresetValues: selected.preset }),
    },
    results: scoreMeet(live.model, live.lineup, [], requireComplete(live.adapted.preset.preset), live.sourcing),
    tags: { coach, suggested },
    // The settings `results` are scored under, so a seed fact and its result row come from one valuation.
    facts: captureReportFacts(live.model, live.lineup, live.sourcing),
  };
  return { kind: 'built', record, coachTags: coach.length, suggestedTags: suggested.length };
}

export async function saveSnapshot(snapshot: SimSnapshot, name: string, deps: SaveSnapshotDeps): Promise<SaveSnapshotOutcome> {
  const built = await buildSnapshotRecord(snapshot, name, deps);
  if (built.kind === 'refused') return built;
  const stored = await deps.repo.put('lineups', built.record, 'new');
  deps.undoStack?.recordUndo({ changes: [{ before: { op: 'delete', store: 'lineups', key: stored.lineupId }, writtenRev: stored.rev }] });
  return { kind: 'saved', lineupId: built.record.lineupId, name: built.record.name, coachTags: built.coachTags, suggestedTags: built.suggestedTags };
}

/** Save the live lineup as an editable lineup record, with its tags and seed facts. Only a snapshot may hold results (`validate.ts`, D3), so they are left out. */
export async function saveLineup(snapshot: SimSnapshot, name: string, deps: SaveSnapshotDeps): Promise<SaveSnapshotOutcome> {
  const built = await buildSnapshotRecord(snapshot, name.trim() ? name : `Lineup ${deps.now().slice(0, 16).replace('T', ' ')}`, deps);
  if (built.kind === 'refused') return built;
  // Results are snapshot-only: a lineup can be edited, and results come from SwimCloud for one moment.
  const { results: _results, ...base } = built.record;
  const record = { ...base, kind: 'lineup' as const };
  const stored = await deps.repo.put('lineups', record, 'new');
  deps.undoStack?.recordUndo({ changes: [{ before: { op: 'delete', store: 'lineups', key: stored.lineupId }, writtenRev: stored.rev }] });
  return { kind: 'saved', lineupId: record.lineupId, name: record.name, coachTags: built.coachTags, suggestedTags: built.suggestedTags };
}
