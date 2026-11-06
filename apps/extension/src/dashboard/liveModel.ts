/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The live model (D7 decision L, plans/2026-10-25/D7-LIVEMODEL-SPEC.md). One builder serves Build, Accept, the Plan session load, the scorer tags, the
 * opponent suggestions, the cut tags and Save. It adapts the simulator snapshot, then applies the stored rosters and class years
 * (`enrichRosterMembership`). Nothing else in the dashboard adapts a snapshot for scoring.
 *
 * Decision P still holds: the Score tab, the Chart tab and the parity report read the raw snapshot through `rescoreSimulator`, never this model.
 * SwimCloud scores its own lineup, and the parity check compares OmniSwim with that. Fetched rosters never reach it.
 *
 * Rules:
 * - Simulator (current): every swimmer the simulator lists is a member. A stored roster changes no entry. Class years still fill in.
 * - A roster season: a swimmer the chosen roster does not list is `not_member`, and the entries of that swimmer are removed. A team whose roster is not
 *   loaded stays `unknown`. Unknown is never `not_member`.
 * - A scorer tag on a `not_member` swimmer is dropped from scoring and reported (`partitionTags`). The stored tag row is never deleted.
 */
import { AdapterError, adaptSimulatorSnapshot, enrichRosterMembership } from '@omniswim/swimcloud/browser';
import type { AdaptedSimulator, EnrichResult } from '@omniswim/swimcloud/browser';
import type { Lineup, MeetModel, ScorerTag, SourcingSettings } from '@omniswim/engine';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { swimmerLabel } from '../shared/names';
import { resolveClassYear, toSwimCloudId } from '../storage';
import type { ClassYearCode, ClassYearOverrideRecord, RosterRecord, StorageRepo } from '../storage';
import { meetKeyForSnapshot } from './meetKey';
import { rosterEvidence } from './rosterView';
import type { RosterSeasonChoice } from './rosterPlan';
import type { RosterSaveState, SeasonList } from './rosterFlow';
import { readRosterSeason } from './settingsStore';

/** A snapshot's identity. Two snapshots with the same key hold the same simulator state. */
export const snapshotKey = (snapshot: SimSnapshot): string => JSON.stringify(snapshot);

/** What storage holds that the live model reads. The maps are keyed by the simulator's team id. */
export interface LiveStored {
  /** The stored roster of each team for the roster season that decides membership (the chosen season, or the current one). */
  readonly membership: ReadonlyMap<string, RosterRecord>;
  /** The stored roster of each team for the current season. It carries the SwimCloud class years. */
  readonly current: ReadonlyMap<string, RosterRecord>;
  /** Every class-year override stored for the current season. */
  readonly overrides: readonly ClassYearOverrideRecord[];
}

export interface LiveModel {
  readonly meetKey: string;
  /** Equal keys mean equal output. It reads the output (snapshot, choice, each swimmer's membership and class year, the team enrichment), not the raw current label or fetch times. */
  readonly key: string;
  readonly choice: RosterSeasonChoice;
  readonly currentLabel: string | null;
  /** The adapter's own output (preset, division note). Never enriched. */
  readonly adapted: AdaptedSimulator;
  readonly model: MeetModel;
  readonly lineup: Lineup;
  /** The caller's object, the same reference. */
  readonly sourcing: SourcingSettings;
  readonly enrichment: Pick<EnrichResult, 'teams' | 'removedEntries'>;
}

export type LiveOutcome =
  | { readonly kind: 'not_loaded'; readonly missing: readonly string[] }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'ready'; readonly live: LiveModel };

/** Loads the live model of a snapshot once. The dashboard makes one, and every operation calls it once and passes the result down. */
export type LiveLoader = (snapshot: SimSnapshot) => Promise<LiveOutcome>;

/**
 * The key is built from what decides the output, not from the inputs that led to it: the snapshot, the choice, each swimmer's roster flag and
 * class year, and the per-team enrichment (status, overlap, notes, the lists). Fetching an identical roster again, or the season list arriving
 * with nothing stored, leaves the output and the key as they were, so a run is not made stale by a change that changed nothing.
 */
function liveKey(snapshot: SimSnapshot, choice: RosterSeasonChoice, model: MeetModel, teams: EnrichResult['teams']): string {
  return JSON.stringify([snapshotKey(snapshot), choice, model.swimmers.map((s) => [s.swimmerId, s.roster, s.classYear]), teams]);
}

/** The class year of every swimmer of every team: override, then SwimCloud, then absent (`null`). Needs the current season's label. */
function resolveClassYears(model: MeetModel, currentLabel: string | null, stored: LiveStored): Record<string, ClassYearCode | null> {
  const out: Record<string, ClassYearCode | null> = {};
  if (currentLabel === null) return out;
  for (const s of model.swimmers) {
    // A simulator id that is not a SwimCloud id cannot have a stored override or roster entry; it stays absent.
    let id;
    try { id = toSwimCloudId(s.swimmerId); } catch { continue; }
    const override = stored.overrides.find((o) => o.swimmerId === id && o.seasonId === currentLabel);
    const roster = stored.current.get(s.teamId);
    const resolved = resolveClassYear({
      swimmerId: id,
      seasonId: currentLabel,
      ...(override ? { override } : {}),
      ...(roster && roster.seasonId === currentLabel ? { roster } : {}),
    });
    out[s.swimmerId] = resolved.state === 'absent' ? null : resolved.classYear;
  }
  return out;
}

/** Pure. The adapter's `RangeError`/`AdapterError`, and the enrichment's `RangeError`, become `error`. Any other throw is a bug and propagates. */
export function buildLiveModel(i: { snapshot: SimSnapshot; choice: RosterSeasonChoice; currentLabel: string | null; stored: LiveStored; sourcing: SourcingSettings }): LiveOutcome {
  const { snapshot, choice, currentLabel, stored, sourcing } = i;
  const meetKey = meetKeyForSnapshot(snapshot);
  try {
    const adapted = adaptSimulatorSnapshot(snapshot, { meetKey, snapshotId: 'live-snapshot' });
    if (adapted.kind === 'not_loaded') return { kind: 'not_loaded', missing: adapted.missing };
    const raw = adapted.adapted;
    const rosters = Object.fromEntries(raw.model.teams.map((t) => [t.teamId, rosterEvidence(stored.membership.get(t.teamId))]));
    const enriched = enrichRosterMembership(
      { model: raw.model, lineup: raw.lineup },
      { mode: choice.kind === 'season' ? 'season' : 'simulator-current', rosters, classYears: resolveClassYears(raw.model, currentLabel, stored) },
    );
    return {
      kind: 'ready',
      live: {
        meetKey,
        key: liveKey(snapshot, choice, enriched.model, enriched.teams),
        choice,
        currentLabel,
        adapted: raw,
        model: enriched.model,
        lineup: enriched.lineup,
        sourcing,
        enrichment: { teams: enriched.teams, removedEntries: enriched.removedEntries },
      },
    };
  } catch (cause) {
    if (cause instanceof RangeError || cause instanceof AdapterError) return { kind: 'error', reason: cause.message };
    throw cause;
  }
}

async function loadRosters(repo: StorageRepo, teamIds: readonly string[], label: string | null, gender: 'Men' | 'Women'): Promise<Map<string, RosterRecord>> {
  const map = new Map<string, RosterRecord>();
  if (label === null) return map;
  for (const id of teamIds) {
    let key;
    try { key = toSwimCloudId(id); } catch { continue; }
    const found = await repo.get('rosters', [key, label, gender]);
    if (found.found) map.set(id, found.value);
  }
  return map;
}

/** Read the stored rosters and overrides the live model needs. A team with no record, or an id that is not a SwimCloud id, has no entry: not loaded. */
export async function loadLiveStored(repo: StorageRepo, teamIds: readonly string[], gender: 'Men' | 'Women', membershipLabel: string | null, currentLabel: string | null): Promise<LiveStored> {
  const [membership, current] = await Promise.all([loadRosters(repo, teamIds, membershipLabel, gender), loadRosters(repo, teamIds, currentLabel, gender)]);
  const overrides = currentLabel === null ? [] : await repo.list('classYearOverrides', { index: 'bySeason', value: currentLabel });
  return { membership, current, overrides };
}

/** The current season's label: the page's season list, else a roster this panel saved from the server's current page. */
export function currentLabelOf(seasons: SeasonList | null, save: RosterSaveState): string | null {
  if (seasons) return seasons.current.label;
  if (save.kind !== 'saved') return null;
  for (const r of save.reports) {
    if (r.request.role !== 'chosen-season' && (r.status.kind === 'saved' || r.status.kind === 'saved-empty')) return r.status.seasonLabel;
  }
  return null;
}

/** Read the meet's roster season choice and the stored rosters, then build. The caller passes the snapshot, the repo, the current label and the sourcing. */
export async function loadLiveModel(a: { snapshot: SimSnapshot; repo: StorageRepo; currentLabel: string | null; sourcing: SourcingSettings }): Promise<LiveOutcome> {
  const { snapshot, repo, currentLabel, sourcing } = a;
  const choice = await readRosterSeason(repo, meetKeyForSnapshot(snapshot));
  // A simulator that states no gender cannot be adapted; the build below reports that. No roster is read for it.
  const gender = snapshot.settings.gender === 'M' ? 'Men' : snapshot.settings.gender === 'F' ? 'Women' : null;
  const teamIds = snapshot.teams.map((t) => String(t.id));
  const membershipLabel = choice.kind === 'season' ? choice.label : currentLabel;
  const stored = gender === null ? { membership: new Map(), current: new Map(), overrides: [] } : await loadLiveStored(repo, teamIds, gender, membershipLabel, currentLabel);
  return buildLiveModel({ snapshot, choice, currentLabel, stored, sourcing });
}

/**
 * Split the coach's tags in two. A tag on a `not_member` swimmer is not used: the swimmer is off the chosen roster and has no entries. A tag on an
 * `unknown` swimmer is kept: unknown is never treated as not a member. Nothing is deleted from storage.
 */
export function partitionTags(live: LiveModel, tags: readonly ScorerTag[]): { kept: ScorerTag[]; notMember: readonly ScorerTag[] } {
  const notMemberIds = new Set(live.model.swimmers.filter((s) => s.roster === 'not_member').map((s) => `${s.teamId}\u0000${s.swimmerId}`));
  const kept: ScorerTag[] = [];
  const notMember: ScorerTag[] = [];
  for (const tag of tags) (notMemberIds.has(`${tag.teamId}\u0000${tag.swimmerId}`) ? notMember : kept).push(tag);
  return { kept, notMember };
}

/** "Jo Doe is not on the 2025-2026 roster; the scorer tag is not used." One line per dropped tag. */
export function droppedTagWarnings(live: LiveModel, notMember: readonly ScorerTag[]): string[] {
  const label = live.choice.kind === 'season' ? live.choice.label : '';
  return notMember.map((t) => `${swimmerLabel(String(t.swimmerId), live.model.display?.swimmers[String(t.swimmerId)]?.name)} is not on the ${label} roster; the ${t.role} tag is not used.`);
}

/** The Score tab's note when a roster season is chosen, or `null` in Simulator (current). */
export function rosterSeasonNote(live: LiveModel): string | null {
  if (live.choice.kind !== 'season') return null;
  return `Roster season ${live.choice.label} applies to Build, Plan and scorer tags (${live.enrichment.removedEntries.length} entries removed). This table is SwimCloud's own lineup, scored as SwimCloud scores it.`;
}
