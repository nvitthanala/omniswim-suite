/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Standing "duplicate athletes" review.
 *
 * The alias suggestion list used to live only inside the import panels, gated on
 * an in-progress paste — so once you applied an import the offer to link
 * duplicates vanished for good, and a roster that already had duplicates had no
 * surface at all. This panel is always available on the Lineup step and works
 * against the current workspace, not a transient preview.
 *
 * Three sections, in decreasing confidence:
 *   1. pending auto-links  — evidence-backed, one click (or Link all) to apply
 *   2. suggestions         — below the auto bar, manual confirmation
 *   3. applied auto-links  — what the linker already did, each undoable
 *
 * Unlinking writes a suppression tombstone, so a rejected merge never comes back
 * on the next import. See `athleteAliases.ts` for the tier rules and blockers.
 */

import React, { useMemo, useState } from 'react';
import { Link2, Unlink, Check, ChevronDown, ChevronUp } from 'lucide-react';
import {
  planAutoAliasLinks,
  applyAutoAliasLinks,
  unlinkAndSuppressAlias,
  addAliasLink,
  isAliasSuppression,
  type AliasAutoLinkDecision,
  type AliasSuggestion,
} from '@omniswim/core/lib/athleteAliases';
import type { AthleteAliasLink, Gender, Workspace } from '@omniswim/core/types';
import { useToast } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  gender: Gender;
  /** Restrict to one team when the step has a team selected. */
  team?: string;
  onUpdate: (patch: Partial<Workspace>) => void;
  /** What-if off ⇒ read-only, matching the rest of the Lineup step. */
  editable?: boolean;
};

const TIER_LABEL: Record<string, string> = {
  conclusive: 'Certain',
  strong: 'Strong',
  moderate: 'Likely',
};

const TIER_CLASS: Record<string, string> = {
  conclusive: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  strong: 'border-[var(--text-accent)]/30 bg-[var(--text-accent)]/10 text-[var(--text-accent)]',
  moderate: 'badge-warning',
};

function sameTeam(a?: string, b?: string): boolean {
  if (!b) return true;
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

function Pair({ alias, canonical }: { alias: string; canonical: string }) {
  return (
    <p className="text-ui-body text-[var(--text-primary)] truncate">
      <span className="text-theme-secondary">{alias}</span>
      <span className="text-theme-muted mx-1.5">→</span>
      {canonical}
    </p>
  );
}

export default function DuplicateAthletesPanel({
  workspace,
  gender,
  team,
  onUpdate,
  editable = true,
}: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const plan = useMemo(() => planAutoAliasLinks(workspace), [workspace]);

  const pending = useMemo(
    () => plan.autoLinks.filter(d => d.gender === gender && sameTeam(d.team, team)),
    [plan, gender, team]
  );

  const suggestions = useMemo(
    () =>
      plan.suggestions.filter(
        s =>
          s.incoming.gender === gender &&
          sameTeam(s.existing.team ?? s.incoming.team, team) &&
          !dismissed.has(`${s.existing.name}|${s.incoming.name}`)
      ),
    [plan, gender, team, dismissed]
  );

  const applied = useMemo<AthleteAliasLink[]>(
    () =>
      (workspace.athleteAliases ?? []).filter(
        l =>
          !isAliasSuppression(l) &&
          l.provenance?.origin === 'auto' &&
          l.gender === gender &&
          sameTeam(l.team, team)
      ),
    [workspace.athleteAliases, gender, team]
  );

  if (pending.length === 0 && suggestions.length === 0 && applied.length === 0) return null;

  const linkAll = () => {
    const result = applyAutoAliasLinks(workspace, { plan: { ...plan, autoLinks: pending } });
    if (!result.applied.length) return;
    onUpdate(result.patch);
    toast.push('success', result.description);
  };

  const linkOne = (d: AliasAutoLinkDecision) => {
    const result = applyAutoAliasLinks(workspace, { plan: { ...plan, autoLinks: [d] } });
    onUpdate(result.patch);
    toast.push('success', `Linked "${d.aliasName}" to "${d.canonicalName}"`);
  };

  const linkSuggestion = (s: AliasSuggestion) => {
    const result = addAliasLink(workspace, {
      canonicalName: s.existing.name,
      aliasName: s.incoming.name,
      gender: s.incoming.gender,
      team: s.existing.team ?? s.incoming.team,
      source: 'manual',
    });
    onUpdate(result.patch);
    toast.push('success', result.description);
  };

  const unlink = (link: AthleteAliasLink) => {
    const patch = unlinkAndSuppressAlias(workspace, link.id);
    onUpdate(patch.patch);
    toast.push('success', patch.description);
  };

  return (
    <div className="mb-3 rounded-xl border border-theme-soft surface-muted-bg shrink-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="text-ui-caption text-theme-muted flex items-center gap-1.5 min-w-0">
          <Link2 size={13} className="text-[var(--text-accent)] shrink-0" />
          Duplicate athletes
          {pending.length > 0 && (
            <span className="ml-1 rounded-full border border-[var(--text-accent)]/30 bg-[var(--text-accent)]/10 px-1.5 text-[var(--text-accent)]">
              {pending.length} to link
            </span>
          )}
          {pending.length === 0 && applied.length > 0 && (
            <span className="ml-1 text-theme-muted/80">{applied.length} linked</span>
          )}
        </span>
        {open ? <ChevronUp size={14} className="shrink-0" /> : <ChevronDown size={14} className="shrink-0" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {pending.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-ui-caption text-theme-muted">
                  Same swimmer under two spellings — evidence-backed
                </p>
                {editable && pending.length > 1 && (
                  <button type="button" onClick={linkAll} className="btn-accent-outline px-2 py-1 text-ui-micro rounded-md">
                    Link all {pending.length}
                  </button>
                )}
              </div>
              <ul className="space-y-1.5">
                {pending.map(d => (
                  <li
                    key={`${d.aliasName}|${d.canonicalName}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-theme-soft/70 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <Pair alias={d.aliasName} canonical={d.canonicalName} />
                      <p className="text-ui-caption text-theme-muted truncate">
                        <span
                          className={`mr-1.5 inline-block rounded-sm border px-1 text-ui-micro uppercase ${
                            TIER_CLASS[d.tier] ?? ''
                          }`}
                        >
                          {TIER_LABEL[d.tier] ?? d.tier}
                        </span>
                        {d.reason}
                        {d.timeMatches.length > 0 && (
                          <span className="text-theme-muted/70">
                            {' '}
                            · {d.timeMatches.length} matching time
                            {d.timeMatches.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </p>
                    </div>
                    {editable && (
                      <button
                        type="button"
                        onClick={() => linkOne(d)}
                        className="btn-accent-outline px-2 py-1 text-ui-micro rounded-md shrink-0"
                      >
                        <Link2 size={11} className="inline mr-1" />
                        Link
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {suggestions.length > 0 && (
            <div>
              <p className="text-ui-caption text-theme-muted mb-1.5">Possible match — needs your call</p>
              <ul className="space-y-1.5">
                {suggestions.slice(0, 8).map(s => (
                  <li
                    key={`${s.existing.name}|${s.incoming.name}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-theme-soft/70 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <Pair alias={s.incoming.name} canonical={s.existing.name} />
                      <p className="text-ui-caption text-theme-muted truncate">
                        {s.reason} <span className="text-theme-muted/70">· {Math.round(s.score * 100)}%</span>
                      </p>
                    </div>
                    {editable && (
                      <div className="flex gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => linkSuggestion(s)}
                          className="btn-accent-outline px-2 py-1 text-ui-micro rounded-md"
                        >
                          Link
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDismissed(prev => new Set(prev).add(`${s.existing.name}|${s.incoming.name}`))
                          }
                          className="px-2 py-1 text-ui-micro rounded-md border border-theme-soft text-theme-muted"
                        >
                          Not the same
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {applied.length > 0 && (
            <div>
              <p className="text-ui-caption text-theme-muted mb-1.5">
                <Check size={11} className="inline mr-1 text-emerald-400" />
                Linked automatically
              </p>
              <ul className="space-y-1.5">
                {applied.map(l => (
                  <li
                    key={l.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-theme-soft/50 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <Pair alias={l.aliasName} canonical={l.canonicalName} />
                      {l.provenance?.reason && (
                        <p className="text-ui-caption text-theme-muted truncate">{l.provenance.reason}</p>
                      )}
                    </div>
                    {editable && (
                      <button
                        type="button"
                        onClick={() => unlink(l)}
                        title="Unlink and never suggest this pair again"
                        className="px-2 py-1 text-ui-micro rounded-md border border-theme-soft text-theme-muted shrink-0"
                      >
                        <Unlink size={11} className="inline mr-1" />
                        Not the same
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
