/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { ClassYear, Gender, Workspace } from '@omniswim/core/types';
import {
  applyScoringTheory,
  parseScoringTheory,
  type ParsedScoringTheory,
} from '@omniswim/core/lib/scoringTheory';
import { useToast } from '@omniswim/ui';
import {
  RelaySquadsSection,
  SwimmerMatchesSection,
  TheoryApplyFooter,
  TheoryWarningsList,
} from './ScoringTheoryPanelParts';
import {
  buildTheoryAppliedMessage,
  canParseTheory,
  shouldShowTeamRequiredWarning,
} from './scoringTheoryPanelView';

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
    toast.push('success', buildTheoryAppliedMessage(preview.summary));
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
          disabled={!canParseTheory(text, team)}
          onClick={parseLocal}
          className="text-ui-label px-4 py-2 btn-accent-outline rounded-lg font-medium disabled:opacity-40"
        >
          Parse theory
        </button>
      </div>

      {shouldShowTeamRequiredWarning(text, team) ? (
        <p className="text-ui-caption text-amber-400/90 mb-3">
          Select a team above before parsing a theory.
        </p>
      ) : null}

      {parsed && preview ? (
        <div className="border border-theme-soft rounded-xl overflow-hidden">
          <div className="max-h-56 overflow-y-auto custom-scrollbar p-3 space-y-3">
            <SwimmerMatchesSection resolvedSwimmers={preview.summary.resolvedSwimmers} />
            <RelaySquadsSection relays={parsed.relays} />
            <TheoryWarningsList warnings={warnings} />
          </div>
          <div className="p-3 border-t border-theme-soft surface-muted-bg">
            <TheoryApplyFooter applyDisabled={applyDisabled} preview={preview} onApply={confirmApply} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
