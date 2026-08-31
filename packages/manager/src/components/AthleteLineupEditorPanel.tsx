/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Unified athlete editor: scorer status, meet entries, relay involvement.
 *
 * Rendered as a right-side slide-over drawer (fixed position) rather than
 * inline below the roster table — selecting an athlete used to push a ~950
 * line editor below the fold with no clear sense of who was being edited.
 * The drawer keeps the athlete identity pinned in a sticky header and
 * reorganizes the body into collapsible sections so only one concern is
 * expanded at a time by default.
 */

import AthleteEntriesSection from './AthleteEntriesSection';
import AthleteHistorySection from './AthleteHistorySection';
import DrawerSection from './DrawerSection';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Link2,
  ListChecks,
  Medal,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  Gender,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '@omniswim/core/types';
import { ALL_PLAN_EVENTS } from '@omniswim/core/lib/eventCatalog';
import { createPlannedEntry } from '@omniswim/core/lib/whatIfProjection';
import {
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '@omniswim/core/lib/swimmerEntryLimits';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import { buildCutlineTagForTeam } from '@omniswim/core/lib/cutlineTags';
import {
  canonicalSwimmerName,
  formatCompactEventLabel,
  isRelayResult,
  normalizeSwimmerName,
} from '@omniswim/core/lib/utils';
import {
  applyScorerOffRelayPatch,
  issueBadgeLabel,
  type LineupAthleteIssue,
} from '@omniswim/core/lib/rosterLineupAudit';
import {
  relayMissingStrokeLabel,
  stableRelayEntryKey,
} from '@omniswim/core/lib/relayLegMatching';
import {
  getAthleteCreditedSwims,
  scorerRosterKey,
  type AthleteCreditedSwim,
  type ScorerRosterRow,
} from '@omniswim/core/lib/scorerRoster';
import {
  editCreditedSwim,
  removeProjectedSwim,
  type WorkspaceEditorPatch,
} from '@omniswim/core/lib/swimEditor';
import { addAliasLink, buildAliasResolver, removeAliasLink } from '@omniswim/core/lib/athleteAliases';
import { CutlineTag, CutlineNearMissChip, useToast } from '@omniswim/ui';
import AthleteCreditedSwimsPanel, { type EditCreditedSwimValues } from './AthleteCreditedSwimsPanel';
import AthleteRoleTag from './AthleteRoleTag';


type RelayInvolvement = {
  event: string;
  legIndex: number;
  status: 'ok' | 'vacant' | 'removed';
  statusLabel: string;
  relayEntryKey: string;
};

type Props = {
  workspace: Workspace;
  settings: ScoringSettings;
  gender: Gender;
  athlete: ScorerRosterRow;
  issues: LineupAthleteIssue[];
  scoredResults: SwimmerResult[];
  allResults: SwimmerResult[];
  editable: boolean;
  onUpdate: (patch: Partial<Workspace>) => void;
  onClose: () => void;
  autoIsScorer: boolean;
};

export default function AthleteLineupEditorPanel({
  workspace,
  settings,
  gender,
  athlete,
  issues,
  scoredResults,
  allResults,
  editable,
  onUpdate,
  onClose,
  autoIsScorer,
}: Props) {
  const toast = useToast();
  const [lastApplied, setLastApplied] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  const [aliasesOpen, setAliasesOpen] = useState(false);
  const [newAliasText, setNewAliasText] = useState('');

  // A fresh athlete selection should never inherit a stale undo chip or open editors.
  useEffect(() => {
    setLastApplied(null);
    setNewAliasText('');
    // The entries and history sections reset their own editors on the same
    // key — see AthleteEntriesSection and AthleteHistorySection.
  }, [athlete.key]);

  // Escape closes the drawer, same as the backdrop click / X button.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Lost-update guard (BUG 3.2): every editor patch is a full-array replacement
  // computed from the workspace it was built against. During a rapid double-edit
  // (two clicks before React re-renders with the applied patch) the second build
  // would read the STALE `workspace` prop and overwrite the first edit. We keep a
  // ref to the freshest workspace — the prop, composed forward with each patch we
  // apply this render cycle — and build every patch against it so successive edits
  // compose instead of clobbering. The store's optimistic cache is likewise a
  // functional `{ ...w, ...patch }` merge, so the composed arrays land intact.
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const applyResult = (result: WorkspaceEditorPatch) => {
    workspaceRef.current = { ...workspaceRef.current, ...result.patch };
    onUpdate(result.patch);
    setLastApplied({ inverse: result.inverse, description: result.description });
    toast.push('success', result.description);
  };

  /** Build a patch against the freshest (composed) workspace, then apply it. */
  const applyPatch = (build: (ws: Workspace) => WorkspaceEditorPatch) => {
    applyResult(build(workspaceRef.current));
  };

  /** Apply a raw patch (no undo chip) while keeping the compose-ref current. */
  const applyRawPatch = (patch: Partial<Workspace>) => {
    workspaceRef.current = { ...workspaceRef.current, ...patch };
    onUpdate(patch);
  };

  const handleUndo = () => {
    if (!lastApplied) return;
    applyRawPatch(lastApplied.inverse);
    toast.push('success', `Undid: ${lastApplied.description}`);
    setLastApplied(null);
  };

  const plans = workspace.meetEntryPlans ?? [];
  const athleteCanonical = canonicalSwimmerName(athlete.name);
  const athleteTeamTrim = String(athlete.team ?? '').trim();
  const athletePlans = plans.filter(
    p =>
      canonicalSwimmerName(p.name) === athleteCanonical &&
      String(p.team ?? '').trim() === athleteTeamTrim &&
      p.gender === gender
  );

  const aliasResolver = useMemo(() => buildAliasResolver(workspace), [workspace]);

  const creditedSwims = useMemo(
    () => getAthleteCreditedSwims(scoredResults, athlete.team, athlete.name, gender, aliasResolver),
    [scoredResults, athlete.team, athlete.name, gender, aliasResolver]
  );
  const creditedPoints = useMemo(
    () => creditedSwims.reduce((sum, s) => sum + (s.points > 0 ? s.points : 0), 0),
    [creditedSwims]
  );


  const athleteHistoryRows = useMemo(
    () =>
      (workspace.athleteHistory ?? []).filter(
        h =>
          normalizeSwimmerName(h.name) === normalizeSwimmerName(athlete.name) &&
          String(h.team ?? '').trim() === athlete.team &&
          h.gender === gender
      ),
    [workspace.athleteHistory, athlete.name, athlete.team, gender]
  );

  // Links (either direction) that involve this athlete's canonical name —
  // matched via canonicalSwimmerName so "Last, First" and reordered spellings
  // still resolve to the same identity as the roster row.
  const athleteAliasLinks = useMemo(
    () =>
      (workspace.athleteAliases ?? []).filter(link => {
        if (link.gender !== gender) return false;
        return (
          canonicalSwimmerName(link.canonicalName) === athleteCanonical ||
          canonicalSwimmerName(link.aliasName) === athleteCanonical
        );
      }),
    [workspace.athleteAliases, gender, athleteCanonical]
  );

  const handleAddAlias = () => {
    if (!editable) return;
    const alias = newAliasText.trim();
    if (!alias) return;
    if (canonicalSwimmerName(alias) === athleteCanonical) {
      toast.push('error', 'That already matches the athlete name.');
      return;
    }
    applyPatch(ws =>
      addAliasLink(ws, {
        canonicalName: athlete.name,
        aliasName: alias,
        gender,
        team: athlete.team,
        source: 'manual',
      })
    );
    setNewAliasText('');
  };

  const handleRemoveAlias = (id: string) => {
    if (!editable) return;
    applyPatch(ws => removeAliasLink(ws, id));
  };

  const handleEditCreditedSwim = (swim: AthleteCreditedSwim, changes: EditCreditedSwimValues) => {
    applyPatch(ws => editCreditedSwim(ws, gender, swim.id, changes));
  };

  // `isRecruit` is true for a planned entry as well as a recruit row, so it
  // cannot pick the plane to delete from. removeProjectedSwim dispatches on
  // where the id actually lives — the old branch filtered `recruits` by a plan
  // id, removed nothing, and still reported success.
  //
  // It raises on a row the workspace does not own — a Team Roster Catalog swim
  // is injected at scoring time and has nothing to delete. Say so; the previous
  // behaviour was a success toast over a patch that changed nothing.
  const handleDeleteCreditedSwim = (swim: AthleteCreditedSwim) => {
    try {
      applyPatch(ws => removeProjectedSwim(ws, gender, swim.id));
    } catch {
      toast.push(
        'error',
        `${swim.event} is not editable here — it comes from the Team Roster Catalog, not this workspace.`
      );
    }
  };


  const counts = countSwimmerEntries(allResults, athlete.team, gender, athlete.name, aliasResolver);

  const relayInvolvement = useMemo((): RelayInvolvement[] => {
    const pdf = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
    const nameKey = normalizeSwimmerName(athlete.name);
    const out: RelayInvolvement[] = [];
    const seen = new Set<string>();

    for (const leg of scoredResults) {
      if (!isRelayResult(leg) || String(leg.team ?? '').trim() !== athlete.team) continue;
      if (leg.name === leg.team) continue;
      const entryKey = stableRelayEntryKey(pdf, leg);
      const legIdx = leg.relayLegIndex ?? 0;
      const rowKey = `${entryKey}|${legIdx}`;
      if (seen.has(rowKey)) continue;

      const isVacant = Boolean(leg.relayLegVacant || leg.relayMissingLeg);
      const onThisLeg =
        normalizeSwimmerName(leg.name) === nameKey ||
        (isVacant &&
          pdf.some(r => {
            if (!isRelayResult(r) || r.team !== athlete.team) return false;
            if (r.event !== leg.event || r.rank !== leg.rank) return false;
            if ((r.relayLegIndex ?? -1) !== legIdx) return false;
            return normalizeSwimmerName(r.name) === nameKey;
          }) ||
          pdf.some(
            r =>
              isRelayResult(r) &&
              r.team === athlete.team &&
              r.event === leg.event &&
              r.relayNames?.[legIdx] &&
              normalizeSwimmerName(r.relayNames[legIdx].name) === nameKey
          ));

      if (!onThisLeg && !isVacant) continue;
      if (!onThisLeg && isVacant) {
        // Only show vacant if this athlete was the departed name
        const departed =
          pdf.find(
            r =>
              isRelayResult(r) &&
              r.team === athlete.team &&
              r.event === leg.event &&
              (r.relayLegIndex ?? -1) === legIdx &&
              normalizeSwimmerName(r.name) === nameKey
          ) ||
          pdf.find(
            r =>
              isRelayResult(r) &&
              r.team === athlete.team &&
              r.event === leg.event &&
              r.relayNames?.[legIdx] &&
              normalizeSwimmerName(r.relayNames[legIdx].name) === nameKey
          );
        if (!departed) continue;
      }

      seen.add(rowKey);
      let status: RelayInvolvement['status'] = 'ok';
      let statusLabel = 'OK';
      if (isVacant) {
        const scorerOff = issues.some(i => i.type === 'relay_scorer_off');
        status = scorerOff ? 'removed' : 'vacant';
        const stroke = relayMissingStrokeLabel(leg.relayMissingLeg?.stroke);
        statusLabel = scorerOff
          ? 'Removed — not a scorer; fill this leg'
          : stroke
            ? `Vacant — needs ${stroke}`
            : 'Vacant — needs filling';
      }
      out.push({
        event: leg.event,
        legIndex: legIdx,
        status,
        statusLabel,
        relayEntryKey: entryKey,
      });
    }
    return out;
  }, [athlete.name, athlete.team, gender, scoredResults, workspace.menResults, workspace.womenResults, issues]);

  const setScorer = (isScorer: boolean) => {
    if (!editable) return;
    const ws = workspaceRef.current;
    const key = scorerRosterKey(athlete.team, gender, athlete.name);
    const rest = (ws.scorerRosterOverrides ?? []).filter(
      o => scorerRosterKey(o.team, o.gender, o.name) !== key
    );
    const nextOverrides =
      isScorer === autoIsScorer
        ? rest
        : [...rest, { name: athlete.name, team: athlete.team, gender, isScorer }];

    const patch = applyScorerOffRelayPatch(ws, {
      name: athlete.name,
      team: athlete.team,
      gender,
      isScorer,
      overrides: nextOverrides,
    });
    applyRawPatch(patch);
    if (!isScorer && relayInvolvement.length > 0) {
      toast.push(
        'info',
        `${athlete.name}: non-scorers cannot swim relays — leg(s) vacated. Fill them on Relays.`
      );
    }
  };


  return (
    <>
      {/* Backdrop only below lg, where the drawer covers most of the viewport.
          On large screens the roster table must stay clickable beside the drawer
          (one-click athlete switching); Escape / X / re-clicking the row close it. */}
      <div
        className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        id="athlete-lineup-editor"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${athlete.name}`}
        className="fixed inset-y-0 right-0 z-50 flex flex-col w-[min(40rem,92vw)] surface-card border-l border-theme-soft shadow-2xl"
      >
        <div className="shrink-0 surface-overlay border-b border-theme-soft px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h5 className="text-lg font-semibold text-[var(--text-primary)] truncate">
                {athlete.name}
              </h5>
              <p className="text-ui-caption text-theme-secondary mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="truncate max-w-[10rem]" title={athlete.team}>
                  {athlete.team}
                </span>
                <span className="text-theme-muted">·</span>
                <span>{athlete.classYear || '—'}</span>
                <AthleteRoleTag role={athlete.athleteRole} isRecruit={athlete.isRecruit} />
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-theme-muted hover:text-[var(--text-primary)] shrink-0"
              aria-label="Close athlete editor"
            >
              <X size={18} />
            </button>
          </div>

          {issues.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {issues.map((issue, i) => (
                <span
                  key={`${issue.type}-${i}`}
                  className="text-ui-caption px-1.5 py-0.5 rounded-full border border-amber-400/40 text-amber-400"
                  title={issue.message}
                >
                  {issueBadgeLabel(issue)}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={athlete.isScorer}
                disabled={!editable}
                onChange={e => setScorer(e.target.checked)}
                className="accent-[var(--text-accent)]"
              />
              <span className="text-ui-label font-medium text-[var(--text-primary)]">Scorer</span>
            </label>
            <p className="text-ui-caption text-theme-muted text-right max-w-[12rem] leading-relaxed">
              Non-scorers are removed from relay legs automatically.
            </p>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={() => setAliasesOpen(v => !v)}
              aria-expanded={aliasesOpen}
              className="flex items-center gap-1.5 text-ui-caption text-theme-secondary hover:text-[var(--text-accent)] transition-colors"
            >
              <Link2 size={12} />
              Aliases{athleteAliasLinks.length > 0 ? ` (${athleteAliasLinks.length})` : ''}
              {aliasesOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {aliasesOpen ? (
              <div className="mt-2 space-y-1.5">
                {athleteAliasLinks.length > 0 ? (
                  <ul className="space-y-1">
                    {athleteAliasLinks.map(link => (
                      <li
                        key={link.id}
                        className="flex items-center justify-between gap-2 text-ui-caption"
                      >
                        <span
                          className="truncate min-w-0 text-theme-secondary"
                          title={`${link.aliasName} → ${link.canonicalName}`}
                        >
                          {link.aliasName} → {link.canonicalName}
                        </span>
                        {editable ? (
                          <button
                            type="button"
                            onClick={() => handleRemoveAlias(link.id)}
                            className="p-1 rounded-md text-theme-muted hover:text-amber-400 transition-colors shrink-0"
                            aria-label={`Remove alias ${link.aliasName}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ui-micro text-theme-muted italic">
                    No linked spellings for this athlete.
                  </p>
                )}
                {editable ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newAliasText}
                      onChange={e => setNewAliasText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAddAlias();
                      }}
                      placeholder="Add alias spelling…"
                      className="flex-1 min-w-0 glass-input rounded-lg px-2 py-1.5 text-ui-caption"
                    />
                    <button
                      type="button"
                      onClick={handleAddAlias}
                      disabled={!newAliasText.trim()}
                      className="text-ui-caption px-2 py-1.5 border border-theme-soft rounded-lg disabled:opacity-40 shrink-0"
                    >
                      Link
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {lastApplied ? (
            <button
              type="button"
              onClick={handleUndo}
              title={lastApplied.description}
              className="flex w-full items-center gap-1.5 truncate border-b border-theme-soft surface-muted-bg px-4 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
            >
              <Undo2 size={12} className="shrink-0" />
              <span className="truncate">Undo: {lastApplied.description}</span>
            </button>
          ) : null}

          {/* Keyed on athlete.key so each newly-selected athlete opens with the
              same default section states (Individual entries expanded, the rest
              collapsed) rather than inheriting whatever the previous athlete had
              toggled. */}
          <div key={athlete.key}>
            <AthleteEntriesSection
              workspace={workspace}
              settings={settings}
              athlete={athlete}
              gender={gender}
              allResults={allResults}
              editable={editable}
              counts={counts}
              athletePlans={athletePlans}
              getWorkspace={() => workspaceRef.current}
              applyPatch={applyPatch}
              applyRawPatch={applyRawPatch}
            />

            <DrawerSection title="Relay involvement" icon={<ListChecks size={14} />}>
              {relayInvolvement.length === 0 ? (
                <p className="text-ui-caption text-theme-muted italic">Not on any projected relay legs.</p>
              ) : (
                <ul className="space-y-2">
                  {relayInvolvement.map(r => (
                    <li
                      key={`${r.relayEntryKey}|${r.legIndex}`}
                      className="flex items-start justify-between gap-3 text-ui-body"
                    >
                      <span className="min-w-0 truncate" title={r.event}>
                        {formatCompactEventLabel(r.event)} · leg {r.legIndex + 1}
                      </span>
                      <span
                        className={`shrink-0 text-ui-caption ${
                          r.status === 'ok' ? 'text-theme-secondary' : 'text-amber-400'
                        }`}
                      >
                        {r.statusLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DrawerSection>

            <DrawerSection
              title="Credited swims"
              icon={<Medal size={14} />}
              badge={
                creditedSwims.length > 0 ? (
                  <span className="text-ui-micro text-theme-muted">({creditedSwims.length})</span>
                ) : null
              }
            >
              {creditedSwims.length > 0 ? (
                <AthleteCreditedSwimsPanel
                  athleteName={athlete.name}
                  team={athlete.team}
                  swims={creditedSwims}
                  totalPoints={creditedPoints}
                  gender={gender}
                  deletable={editable}
                  onDeleteSwim={editable ? handleDeleteCreditedSwim : undefined}
                  onEditSwim={editable ? handleEditCreditedSwim : undefined}
                  entryLimitLabel={formatEntryLimitLabel(counts, settings)}
                />
              ) : (
                <p className="text-ui-caption text-theme-muted italic">
                  No credited swims from the loaded meet yet.
                </p>
              )}
            </DrawerSection>

            <AthleteHistorySection
              rows={athleteHistoryRows}
              athlete={athlete}
              gender={gender}
              editable={editable}
              applyPatch={applyPatch}
            />
          </div>
        </div>
      </div>
    </>
  );
}
