/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lazy baseline-vs-working comparison for the Source step.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import {
  requestScenarioDiff,
  type ScenarioDiffResult,
} from '@omniswim/core/lib/scenarioDiffClient';
import { useToast } from '@omniswim/ui';
import { ScenarioDiffView } from './ScenarioDiffView';

type Props = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  scoringSettings: ScoringSettings;
};

type DiffInputs = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  scoringSettings: ScoringSettings;
};

const BACKEND_UNSUPPORTED_MESSAGE = 'Snapshots require SQLite or PostgreSQL backend';

function matchesInputs(inputs: DiffInputs | null, current: DiffInputs): boolean {
  if (!inputs) return false;
  return (
    inputs.workspace === current.workspace &&
    inputs.gender === current.gender &&
    inputs.team === current.team &&
    inputs.scoringSettings === current.scoringSettings
  );
}

export default function BaselineDiffPanel({ workspace, gender, team, scoringSettings }: Props) {
  const { push } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(true);
  const [result, setResult] = useState<ScenarioDiffResult | null>(null);
  const [backendUnsupported, setBackendUnsupported] = useState(false);
  const requestIdRef = useRef(0);
  const resultInputsRef = useRef<DiffInputs | null>(null);
  const currentInputs = { workspace, gender, team, scoringSettings };

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setStale(true);
    setResult(null);
    resultInputsRef.current = null;

    // No team selected means nothing to compare — skip the request entirely
    // rather than computing an all-zero diff that reads as "no differences".
    if (!expanded || !team.trim()) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void requestScenarioDiff(workspace, workspace, {
      team,
      gender,
      settings: scoringSettings,
      thenMode: 'baseline',
    })
      .then(nextResult => {
        if (requestId !== requestIdRef.current) return;
        resultInputsRef.current = { workspace, gender, team, scoringSettings };
        setResult(nextResult);
        setStale(false);
      })
      .catch(err => {
        if (requestId !== requestIdRef.current) return;
        const message = err instanceof Error ? err.message : 'Failed to compute changes from the loaded meet';
        if (message === BACKEND_UNSUPPORTED_MESSAGE) {
          setBackendUnsupported(true);
        } else {
          push('error', message);
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });

    return () => {
      if (requestIdRef.current === requestId) requestIdRef.current += 1;
    };
  }, [workspace, gender, team, scoringSettings, expanded, push]);

  const hasCurrentResult = result !== null && !stale && matchesInputs(resultInputsRef.current, currentInputs);
  const hasTeam = team.trim().length > 0;

  if (backendUnsupported) {
    return (
      <section className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
          Changes from loaded meet
        </h4>
        <p className="text-ui-caption text-theme-secondary leading-relaxed mt-2">
          Changes from the loaded meet are unavailable with the current backend.
        </p>
      </section>
    );
  }

  return (
    <section className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Changes from loaded meet</h4>
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          disabled={loading || !hasTeam}
          className="btn-accent-outline rounded-md px-2.5 py-1.5 text-ui-caption font-semibold disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Calculating…
            </>
          ) : expanded ? (
            'Hide changes'
          ) : (
            'Show changes from the loaded meet'
          )}
        </button>
      </div>

      {/* A diff is scoped to one team. With no team chosen the comparison matches
          no rows, which would render as "no differences" — a confident, false
          statement that the working copy equals the loaded meet. Say what is
          actually missing instead; an empty match is not a real result. */}
      {!hasTeam ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed mt-2.5">
          Choose a team above to compare it against the loaded meet.
        </p>
      ) : null}
      {expanded && hasTeam && loading ? (
        <p className="text-ui-caption text-theme-muted flex items-center gap-1.5 mt-2.5">
          <Loader2 size={12} className="animate-spin" />
          Calculating changes…
        </p>
      ) : null}
      {expanded && hasTeam && hasCurrentResult && result ? (
        <ScenarioDiffView
          result={result}
          emptyMessage="No differences — the working copy matches the loaded meet."
        />
      ) : null}
    </section>
  );
}
