/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: "Scout a team". The coach picks a crawled team and sees where the lineup wins, where it loses
 * and which events one swim could change. The comparison is `scoutOpponent`; this file only loads the
 * opponent's seeds and shows the result. It writes nothing to the workspace.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Gender, ScoringSettings, SwimmerResult, Workspace } from '@omniswim/core/types';
import { scoutOpponent, type ScoutReport } from '../lib/opponentScouting';
import { loadOpponentSeeds, type OpponentSeeds } from '../lib/opponentScoutingLoad';
import { createCaptureApi, type CaptureApi } from './theoreticalMeet/captureApi';
import { groupCaptures, type CaptureTeamGroup } from './theoreticalMeet/theoreticalMeetView';
import { ScoutReportView } from './ScoutReportView';
import {
  NO_CAPTURES_TEXT,
  NO_READY_CAPTURE_TEXT,
  SCOUT_INTRO,
  SCOUT_OUR_SIDE_NOTE,
  SCOUT_TERMS,
  defaultScoringId,
  describeScoutError,
  handTypedRowIds,
  isOwnTeamGroup,
  pickerLabel,
  unknownSourceRowIds,
  resolveScoutScoring,
  scoutScoringOptions,
} from './scoutOpponentView';

type Props = {
  workspace: Workspace;
  gender: Gender;
  /** The team chosen in the Manager team bar. */
  team: string;
  /** The scored rows of the current projection (`ScoringBundle.allScored`). */
  scoredRows: readonly SwimmerResult[];
  /** The workspace's merged scoring settings. */
  scoringSettings: ScoringSettings;
  /** Test seam. Defaults to the real capture routes. */
  captureApi?: CaptureApi;
};

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; detail: string | null }
  | { kind: 'ready'; groups: CaptureTeamGroup[] };

type RunState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string; detail: string | null }
  | { kind: 'ready'; seeds: OpponentSeeds };

const SELECT_CLASS = 'glass-input w-full min-w-0 rounded-lg px-2.5 py-1.5 text-ui-caption';

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-ui-micro font-medium text-theme-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

function Problem({ message, detail }: { message: string; detail: string | null }) {
  return (
    <div role="alert" className="text-ui-caption text-warning-soft leading-relaxed">
      <p>{message}</p>
      {detail !== null ? <p className="mt-1 text-theme-muted">{detail}</p> : null}
    </div>
  );
}

function TermsHelp() {
  return (
    <details className="text-ui-micro text-theme-secondary">
      <summary className="cursor-pointer font-medium">What these words mean</summary>
      <dl className="mt-1.5 space-y-1.5">
        {SCOUT_TERMS.map(t => (
          <div key={t.term}>
            <dt className="font-semibold">{t.term}</dt>
            <dd className="text-theme-muted">{t.meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

type Comparison =
  | { report: ScoutReport; problem: null }
  | { report: null; problem: { message: string; detail: string | null } }
  | null;

/** What the last run shows: the wait, the problem, or the report. */
function RunStatus({ run, comparison }: { run: RunState; comparison: Comparison }) {
  return (
    <div aria-live="polite" className="space-y-2">
      {run.kind === 'loading' ? (
        <p className="flex items-center gap-1.5 text-ui-caption text-theme-muted">
          <Loader2 size={12} className="animate-spin" />
          Reading the crawled pages…
        </p>
      ) : null}
      {run.kind === 'error' ? <Problem message={run.message} detail={run.detail} /> : null}
      {run.kind === 'ready' && comparison?.problem != null ? (
        <Problem message={comparison.problem.message} detail={comparison.problem.detail} />
      ) : null}
      {run.kind === 'ready' && comparison?.report != null ? (
        <>
          <p className="text-ui-micro text-theme-muted leading-relaxed">{SCOUT_OUR_SIDE_NOTE}</p>
          <ScoutReportView
            report={comparison.report}
            caveats={[...run.seeds.caveats, ...comparison.report.caveats]}
            warnings={run.seeds.warnings}
          />
        </>
      ) : null}
    </div>
  );
}

export default function ScoutOpponentPanel({ workspace, gender, team, scoredRows, scoringSettings, captureApi }: Props) {
  const baseId = useId();
  const api = useMemo(() => captureApi ?? createCaptureApi(), [captureApi]);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [teamId, setTeamId] = useState('');
  const [captureId, setCaptureId] = useState('');
  const [scoringId, setScoringId] = useState(() => defaultScoringId(scoringSettings));
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const latest = useRef(0);

  // Read the capture list once, when the tab opens.
  useEffect(() => {
    let cancelled = false;
    api.listCaptures().then(
      records => {
        if (!cancelled) setList({ kind: 'ready', groups: groupCaptures(records, Date.now()) });
      },
      (err: unknown) => {
        if (cancelled) return;
        const problem = describeScoutError(err);
        setList({ kind: 'error', message: problem.message, detail: problem.detail });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const groups = useMemo(() => {
    if (list.kind !== 'ready') return [];
    return list.groups.filter(g => !isOwnTeamGroup(g, team));
  }, [list, team]);
  const group = groups.find(g => g.teamId === teamId);
  const readyRows = group?.rows.filter(r => r.status === 'ready') ?? [];
  const options = useMemo(() => scoutScoringOptions(scoringSettings), [scoringSettings]);

  // A new gender, team or choice makes a shown result stale. Clear it.
  useEffect(() => {
    latest.current += 1;
    setRun({ kind: 'idle' });
  }, [gender, team, scoringId, captureId]);

  const pickTeam = (id: string) => {
    setTeamId(id);
    const next = groups.find(g => g.teamId === id)?.rows.find(r => r.status === 'ready');
    setCaptureId(next?.captureId ?? '');
  };

  const scoring = resolveScoutScoring(scoringId, {
    scoringSettings: scoringSettings,
    conference: workspace.conference,
  });
  // The report is derived, not stored: an edit to the lineup on the left re-scores against the same
  // opponent seeds, so the numbers never go stale.
  const comparison = useMemo(() => {
    if (run.kind !== 'ready' || scoring === null) return null;
    try {
      const report = scoutOpponent({
        gender,
        ourTeam: team,
        opponentTeam: run.seeds.teamName,
        ourRows: scoredRows,
        theirRows: run.seeds.rows,
        settings: scoring.settings,
        ...(scoring.conference === undefined ? {} : { conference: scoring.conference }),
        excludeOurRowIds: handTypedRowIds(workspace, gender, team),
        unknownSourceOurRowIds: unknownSourceRowIds(workspace, gender, team),
        theirEntryCapped: run.seeds.entryCapped,
      });
      return { report, problem: null };
    } catch (err) {
      return { report: null, problem: describeScoutError(err) };
    }
    // `scoring` is rebuilt every render from its inputs, which are listed instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the inputs of `scoring`
  }, [run, gender, team, scoredRows, scoringId, scoringSettings, workspace]);
  const canRun = captureId !== '' && scoring !== null && run.kind !== 'loading';

  const start = () => {
    if (scoring === null || captureId === '') return;
    const request = ++latest.current;
    setRun({ kind: 'loading' });
    loadOpponentSeeds({
      captureIds: [captureId],
      gender,
      deps: api,
      scoringSettings: scoring.settings,
      ...(scoring.conference === undefined ? {} : { conference: scoring.conference }),
    })
      .then(seeds => {
        if (request === latest.current) setRun({ kind: 'ready', seeds });
      })
      .catch((err: unknown) => {
        if (request !== latest.current) return;
        const problem = describeScoutError(err);
        setRun({ kind: 'error', message: problem.message, detail: problem.detail });
      });
  };

  return (
    <section aria-label="Scout a team" className="space-y-3 rounded-xl border border-theme-soft surface-muted-bg p-3">
      <div className="space-y-1.5">
        <h3 className="text-ui-caption font-semibold text-[var(--text-primary)]">Scout a team</h3>
        <p className="text-ui-micro text-theme-muted leading-relaxed">{SCOUT_INTRO}</p>
        <TermsHelp />
      </div>

      {list.kind === 'loading' ? (
        <p className="flex items-center gap-1.5 text-ui-caption text-theme-muted">
          <Loader2 size={12} className="animate-spin" />
          Loading crawled teams…
        </p>
      ) : null}
      {list.kind === 'error' ? <Problem message={list.message} detail={list.detail} /> : null}
      {list.kind === 'ready' && groups.length === 0 ? (
        <p className="text-ui-caption text-theme-muted leading-relaxed">{NO_CAPTURES_TEXT}</p>
      ) : null}

      {groups.length > 0 ? (
        <div className="space-y-2">
          <Field id={`${baseId}-team`} label="Team to scout">
            <select id={`${baseId}-team`} value={teamId} onChange={e => pickTeam(e.target.value)} className={SELECT_CLASS}>
              <option value="">Choose a team</option>
              {groups.map(g => (
                <option key={g.teamId} value={g.teamId}>
                  {pickerLabel(g)}
                </option>
              ))}
            </select>
          </Field>
          {group !== undefined && readyRows.length === 0 ? (
            <p className="text-ui-caption text-theme-muted leading-relaxed">{NO_READY_CAPTURE_TEXT}</p>
          ) : null}
          {readyRows.length > 0 ? (
            <Field id={`${baseId}-capture`} label="Crawl to use">
              <select id={`${baseId}-capture`} value={captureId} onChange={e => setCaptureId(e.target.value)} className={SELECT_CLASS}>
                {readyRows.map(r => (
                  <option key={r.captureId} value={r.captureId}>
                    {r.season ?? 'Season not recorded'}. {r.ageText}
                  </option>
                ))}
              </select>
              {readyRows.find(r => r.captureId === captureId)?.staleHint != null ? (
                <p className="mt-1 text-ui-micro text-warning-soft">{readyRows.find(r => r.captureId === captureId)?.staleHint}</p>
              ) : null}
            </Field>
          ) : null}
          <Field id={`${baseId}-scoring`} label="Score with">
            <select id={`${baseId}-scoring`} value={scoringId} onChange={e => setScoringId(e.target.value)} className={SELECT_CLASS}>
              <option value="">Choose scoring rules</option>
              {options.map(o => (
                <option key={o.id} value={o.id} disabled={o.disabledReason !== null} title={o.disabledReason ?? undefined}>
                  {o.label}
                </option>
              ))}
            </select>
            {options[0]?.disabledReason != null ? (
              <p className="mt-1 text-ui-micro text-theme-muted">{options[0].disabledReason}</p>
            ) : null}
          </Field>
          <button
            type="button"
            onClick={start}
            disabled={!canRun}
            className="rounded-lg border border-theme-soft px-3 py-1.5 text-ui-caption font-medium text-theme-primary disabled:opacity-50"
          >
            Scout this team
          </button>
        </div>
      ) : null}

      <RunStatus run={run} comparison={comparison} />
    </section>
  );
}
