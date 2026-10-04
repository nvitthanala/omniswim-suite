/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Step 3 of the "Build theoretical meet" dialog: read each team, then preview the meet.
 *
 * v1 is read-only. The chosen events are shown as chips, not edited. The seed builder picks events
 * under the entry caps inside `buildTheoreticalMeetSeeds` and has no input that leaves one event out,
 * so a removable chip would need a core-side change to keep the caps honest.
 */

import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Badge, Button, Disclosure } from '@omniswim/ui';
import { Gender } from '@omniswim/core/types';
import type { TeamLoadState, TheoreticalMeetFlow } from './useTheoreticalMeetFlow';
import type { CaptureRow, PreviewTeamRow } from './theoreticalMeetView';
import { ProblemPanel } from './TeamsStep';

function captureTitle(row: CaptureRow | undefined, captureId: string): string {
  if (row === undefined) return captureId;
  return `Team ${row.teamId}${row.season === null ? '' : `, ${row.season}`}`;
}

function TeamReadRow({ title, load, onRetry }: { title: string; load: TeamLoadState | undefined; onRetry: () => void }) {
  if (load === undefined || load.status === 'loading') {
    return (
      <li className="rounded-lg border border-theme-soft p-3" role="status" aria-label={`Reading ${title}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-ui-caption font-medium text-[var(--text-primary)]">{title}</span>
          <span className="text-ui-micro text-theme-muted">Reading the stored pages</span>
        </div>
        <div className="skeleton-block mt-2 h-3 w-2/3" />
      </li>
    );
  }
  if (load.status === 'failed') {
    return (
      <li className="rounded-lg border border-theme-soft p-3">
        <div className="mb-2 text-ui-caption font-medium text-[var(--text-primary)]">{title}</div>
        <ProblemPanel problem={load.problem} onRetry={onRetry} retryLabel="Retry this team" />
        {!load.problem.retryable ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry} leadingIcon={<RefreshCw size={12} />}>
            Retry this team
          </Button>
        ) : null}
      </li>
    );
  }
  const teams = load.result.teams.map(team => `${team.teamName}, ${team.gender === Gender.WOMEN ? 'women' : 'men'}`);
  return (
    <li className="rounded-lg border border-theme-soft p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-caption font-medium text-[var(--text-primary)]">{title}</span>
        <span className="flex items-center gap-1 text-ui-micro text-theme-secondary">
          <CheckCircle2 size={12} aria-hidden="true" /> Read
        </span>
      </div>
      <p className="mt-1 text-ui-micro text-theme-muted">{teams.join(' and ')}</p>
    </li>
  );
}

function NameList({ label, names }: { label: string; names: readonly string[] }) {
  return (
    <div className="text-ui-caption">
      <dt className="text-theme-secondary">
        {label} <span className="text-theme-muted">({names.length})</span>
      </dt>
      <dd className="mt-0.5 text-[var(--text-primary)]">{names.length === 0 ? <span className="text-theme-muted">None</span> : names.join(', ')}</dd>
    </div>
  );
}

function TeamPreview({ team }: { team: PreviewTeamRow }) {
  return (
    <Disclosure
      title={`${team.teamName}, ${team.genderLabel}`}
      summary={`${team.rowsCreated} ${team.rowsCreated === 1 ? 'entry' : 'entries'}`}
      className="text-ui-caption"
    >
      <dl className="space-y-2">
        <NameList label="No times captured" names={team.athletesWithNoTimes} />
        <NameList label="Times page could not be read" names={team.timesParseFailed} />
        <NameList label="No seed in short course yards" names={team.noSeedInCourse.map(a => `${a.name} (${a.reason})`)} />
        <NameList label="Diving only, left out" names={team.divingExcluded} />
        <NameList label="Also on another team, entered once" names={team.duplicatesAcrossTeams} />
        <div className="text-ui-caption">
          <dt className="text-theme-secondary">Exhibition seeds used</dt>
          <dd className="mt-0.5 text-[var(--text-primary)]">
            {team.exhibitionSeedsUsed === 0 ? <span className="text-theme-muted">None</span> : `${team.exhibitionSeedsUsed} of ${team.rowsCreated} entries`}
          </dd>
        </div>
        {team.exhibitionEventsExcluded > 0 ? (
          <div className="text-ui-caption">
            <dt className="text-theme-secondary">Events dropped as exhibition</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">{team.exhibitionEventsExcluded}</dd>
          </div>
        ) : null}
      </dl>
      <h5 className="mt-4 text-ui-caption font-semibold text-[var(--text-primary)]">Chosen events ({team.swimmers.length} swimmers)</h5>
      <ul className="mt-2 space-y-2">
        {team.swimmers.map(swimmer => (
          <li key={swimmer.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="min-w-[8rem] text-ui-caption font-medium text-[var(--text-primary)]">{swimmer.name}</span>
            <span className="flex flex-wrap gap-1">
              {swimmer.chosen.map(entry => (
                <span key={entry.event} className="rounded-md border border-theme-soft bg-[var(--surface-muted)] px-1.5 py-0.5 text-ui-micro text-theme-secondary">
                  {entry.event} <span className="text-[var(--text-primary)]">{entry.time}</span>
                  {entry.isExhibition ? <span className="ml-1 rounded border border-warning-faint px-1 text-warning">exhibition</span> : null}
                </span>
              ))}
              {swimmer.leftOutByCap > 0 ? (
                <span className="text-ui-micro text-theme-muted">{`${swimmer.leftOutByCap} more left out by the entry cap`}</span>
              ) : null}
              {swimmer.excludedExhibitionEvents.length > 0 ? (
                <span className="text-ui-micro text-theme-muted">{`No seed for ${swimmer.excludedExhibitionEvents.join(', ')} (exhibition)`}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

export function PreviewStep({ flow, captureRows }: { flow: TheoreticalMeetFlow; captureRows: ReadonlyMap<string, CaptureRow> }) {
  const { selected, teamLoads, retryTeam, preview, name, setName, createProblem } = flow;
  const model = preview.status === 'ready' ? preview.built.model : null;
  const defaultName = preview.status === 'ready' ? preview.built.build.payload.name : '';

  return (
    <div className="space-y-5">
      <section aria-labelledby="tmeet-read-heading">
        <h3 id="tmeet-read-heading" className="mb-2 text-ui-label font-semibold text-[var(--text-primary)]">
          Teams
        </h3>
        <ul className="space-y-2">
          {selected.map(id => (
            <TeamReadRow key={id} title={captureTitle(captureRows.get(id), id)} load={teamLoads[id]} onRetry={() => retryTeam(id)} />
          ))}
        </ul>
      </section>

      {preview.status === 'error' ? <ProblemPanel problem={preview.problem} /> : null}
      {createProblem !== null ? <ProblemPanel problem={createProblem} /> : null}

      {model !== null ? (
        <>
          <section aria-labelledby="tmeet-summary-heading" className="space-y-2">
            <h3 id="tmeet-summary-heading" className="text-ui-label font-semibold text-[var(--text-primary)]">
              Preview
            </h3>
            <p className="text-ui-caption text-theme-secondary">
              {`${model.totalRows} entries from ${model.teamCount} ${model.teamCount === 1 ? 'team' : 'teams'}. Places are the order of the seed times. Chosen events are read-only in this version.`}
              {model.exhibitionSeedsUsed > 0 ? ` ${model.exhibitionSeedsUsed} of them come from exhibition swims and carry an exhibition tag.` : ''}
              {model.exhibitionEventsExcluded > 0 ? ` ${model.exhibitionEventsExcluded} ${model.exhibitionEventsExcluded === 1 ? 'event was' : 'events were'} dropped because the best swim there is exhibition.` : ''}
            </p>
            <label htmlFor="tmeet-name" className="block text-ui-caption text-theme-secondary">
              Workspace name
            </label>
            <input
              id="tmeet-name"
              type="text"
              className="glass-input w-full text-ui-caption"
              value={name}
              maxLength={120}
              placeholder={defaultName}
              onChange={event => setName(event.target.value)}
            />
            <div className="space-y-2 pt-1">
              {model.teams.map(team => (
                <TeamPreview key={team.key} team={team} />
              ))}
            </div>
          </section>

          {model.warnings.length > 0 ? (
            <section aria-labelledby="tmeet-warnings-heading" className="rounded-lg border border-theme-soft p-3">
              <h4 id="tmeet-warnings-heading" className="flex items-center gap-1.5 text-ui-caption font-semibold text-[var(--text-primary)]">
                <AlertTriangle size={12} className="text-warning" aria-hidden="true" /> Warnings
              </h4>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ui-caption text-theme-secondary">
                {model.warnings.map(warning => (
                  <li key={warning.text} className="break-words">
                    {warning.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="tmeet-caveats-heading" className="rounded-lg border border-warning-faint bg-warning-faint p-3">
            <h4 id="tmeet-caveats-heading" className="flex items-center gap-1.5 text-ui-caption font-semibold text-warning">
              <AlertTriangle size={12} aria-hidden="true" /> This is not a real meet
              <Badge tone="warning" className="ml-1">
                Read before creating
              </Badge>
            </h4>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ui-caption text-[var(--text-primary)]">
              {model.caveats.map(caveat => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
