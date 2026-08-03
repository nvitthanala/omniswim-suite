/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { ListChecks, Wand2 } from 'lucide-react';
import { ClassYear, Gender, Workspace } from '@omniswim/core/types';
import {
  applyScoringTheory,
  parseScoringTheory,
  type ParsedScoringTheory,
} from '@omniswim/core/lib/scoringTheory';
import { useToast } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  classYearOverrides?: Record<string, ClassYear>;
  onUpdate: (patch: Partial<Workspace>) => void;
  /** When true, parse/preview still works but applying to the workspace is blocked. */
  applyDisabled?: boolean;
};

export default function ScoringTheoryPanel({
  workspace,
  gender,
  team,
  classYearOverrides,
  onUpdate,
  applyDisabled,
}: Props) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedScoringTheory | null>(null);

  const preview = useMemo(() => {
    if (!parsed || !team.trim()) return null;
    return applyScoringTheory(workspace, parsed, { team, gender, classYearOverrides });
  }, [parsed, workspace, team, gender, classYearOverrides]);

  const parseLocal = () => {
    setParsed(text.trim() ? parseScoringTheory(text) : null);
  };

  const confirmApply = () => {
    if (!parsed || !preview || !team.trim()) return;
    onUpdate(preview.patch);
    const s = preview.summary;
    toast.push(
      'success',
      `Theory applied: ${s.scorersMarked} scorer(s), ${s.entriesAdded} entr${
        s.entriesAdded === 1 ? 'y' : 'ies'
      }, ${s.relayLegsAssigned} relay leg(s)`
    );
    setParsed(null);
    setText('');
  };

  const warnings = [...(parsed?.warnings ?? []), ...(preview?.warnings ?? [])];

  return (
    <div className="surface-card rounded-xl p-4 sm:p-5 shrink-0 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <ListChecks size={16} className="text-[var(--text-accent)] shrink-0" />
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
          Scoring theory import
        </h4>
      </div>
      <p className="text-ui-body text-theme-secondary mb-3 leading-relaxed">
        Paste a scoring-team plan (relay squads + per-swimmer event lists, e.g.{' '}
        <span className="font-mono">Bartu Akin (1000, 4IM, 500, 1650)</span>). Names are matched to
        the roster — nicknames and accents are handled.
      </p>

      <label className="flex flex-col gap-1.5 mb-3">
        <span className="text-ui-caption text-theme-muted">Paste theory</span>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'Scoring team relays\n\n200 FR\nA River, Noel, Mate, Oliver\n…'}
          className="w-full min-h-[7rem] resize-y glass-input rounded-lg px-3 py-2.5 font-mono text-ui-body"
        />
      </label>

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          disabled={!text.trim() || !team.trim()}
          onClick={parseLocal}
          className="text-ui-label px-4 py-2 btn-accent-outline rounded-lg font-medium disabled:opacity-40"
        >
          Parse theory
        </button>
      </div>

      {!team.trim() && text.trim() ? (
        <p className="text-ui-caption text-amber-400/90 mb-3">
          Select a team above before parsing a theory.
        </p>
      ) : null}

      {parsed && preview ? (
        <div className="border border-theme-soft rounded-xl overflow-hidden">
          <div className="max-h-56 overflow-y-auto custom-scrollbar p-3 space-y-3">
            {preview.summary.resolvedSwimmers.length > 0 ? (
              <div>
                <p className="text-ui-caption text-theme-muted mb-1.5">Swimmer matches</p>
                <div className="flex flex-wrap gap-1.5">
                  {preview.summary.resolvedSwimmers.map(s => (
                    <span
                      key={s.rawName}
                      className={`text-ui-caption px-2 py-1 rounded-lg border max-w-full truncate ${
                        s.matched
                          ? 'text-theme-secondary border-theme-soft'
                          : 'badge-warning'
                      }`}
                      title={
                        s.matched
                          ? `${s.rawName} → ${s.matched} (${Math.round(s.confidence * 100)}%)`
                          : `${s.rawName}: no roster match`
                      }
                    >
                      {s.rawName}
                      {s.matched && s.matched !== s.rawName ? ` → ${s.matched}` : ''}
                      {!s.matched ? ' · unmatched' : ''}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {parsed.relays.length > 0 ? (
              <div>
                <p className="text-ui-caption text-theme-muted mb-1.5">Relay squads</p>
                <ul className="text-ui-body text-theme-secondary space-y-1">
                  {parsed.relays.map(r => (
                    <li key={`${r.event}|${r.squad}`} className="break-words">
                      <span className="text-[var(--text-primary)]">
                        {r.event} {r.squad}
                      </span>
                      : {r.legs.map(l => l.name).join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <ul className="text-ui-caption text-amber-400/90 list-disc list-inside space-y-1">
                {warnings.map((w, i) => (
                  <li key={i} className="break-words">
                    {w}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="p-3 border-t border-theme-soft surface-muted-bg">
            {applyDisabled ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                Enable <strong className="text-[var(--text-primary)]">What-if</strong> to apply the
                theory to the roster.
              </p>
            ) : (
              <button
                type="button"
                onClick={confirmApply}
                className="text-ui-label text-[var(--text-accent)] hover:underline font-semibold flex items-center gap-1.5"
              >
                <Wand2 size={14} />
                Apply theory ({preview.summary.entriesAdded} entries ·{' '}
                {preview.summary.relayLegsAssigned} relay legs)
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
