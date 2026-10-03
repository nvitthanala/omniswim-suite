/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lazy baseline-vs-working comparison for the Athletes step. It renders only
 * the body: the parent's Disclosure supplies the title and the open/closed
 * state, and `active` (the Disclosure being open) starts the comparison.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import {
  requestScenarioDiff,
  type ScenarioDiffResult,
} from '@omniswim/core/lib/scenarioDiffClient';
import { useToast } from '@omniswim/ui';
import { DiffPanelBody } from './BaselineDiffPanelParts';
import { matchesInputs, resolveDiffViewState, type DiffInputs } from './baselineDiffView';

type Props = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  scoringSettings: ScoringSettings;
  /** True while the panel is on screen. The comparison runs only then. */
  active: boolean;
};

const BACKEND_UNSUPPORTED_MESSAGE = 'Snapshots require SQLite or PostgreSQL backend';

export default function BaselineDiffPanel({ workspace, gender, team, scoringSettings, active }: Props) {
  const { push } = useToast();
  const expanded = active;
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
  const viewState = resolveDiffViewState({ hasTeam, expanded, loading, hasCurrentResult });

  if (backendUnsupported) {
    return (
      <p className="text-ui-caption text-theme-secondary leading-relaxed">
        Changes from the loaded meet are unavailable with the current backend.
      </p>
    );
  }

  // A diff is scoped to one team. With no team chosen the comparison matches
  // no rows, which would render as "no differences" — a confident, false
  // statement that the working copy equals the loaded meet. Say what is
  // actually missing instead; an empty match is not a real result.
  return (
    <div>
      <p className="text-ui-body text-theme-secondary leading-relaxed">
        Compare this team&apos;s working roster with the frozen results of the loaded meet.
      </p>
      <DiffPanelBody state={viewState} result={result} />
    </div>
  );
}
