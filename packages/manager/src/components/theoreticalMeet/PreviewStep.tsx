/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Step 3 of the "Build theoretical meet" dialog: read each team, then preview the meet.
 *
 * The chosen events are chips with a visible Remove button. A removal is sent to the seed builder as an
 * `excludedEvents` pair (`removalFor`), and the preview is rebuilt: the builder applies the same entry caps
 * to the order without that event, so the next-best event may fill the slot (tagged "in place of a removed
 * event"). A removed event stays on screen with a Restore button. The builder owns the cap logic. This file
 * only toggles the pair and draws the result.
 *
 * Focus: a toggle swaps one button for the other, so focus moves to the new button for the same event.
 * A polite status line states what changed for a screen reader.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Undo2, X } from 'lucide-react';
import { Badge, Button, Disclosure } from '@omniswim/ui';
import { Gender } from '@omniswim/core/types';
import type { TeamLoadState, TheoreticalMeetFlow } from './useTheoreticalMeetFlow';
import { describeUnmatchedRemovals, removalFor, removalKey, type CaptureRow, type PreviewModel, type PreviewRelay, type PreviewSwimmer, type PreviewTeamRow } from './theoreticalMeetView';
import type { TheoreticalEventExclusion } from '../../lib/theoreticalMeetSeeds';
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

/** What the chip buttons need from the step: toggle one removal, and say which button to focus after it. */
type ToggleRemoval = (removal: TheoreticalEventExclusion, action: 'remove' | 'restore', label: string) => void;

function EventToggleButton({
  kind,
  swimmer,
  team,
  event,
  onToggle,
}: {
  kind: 'remove' | 'restore';
  swimmer: PreviewSwimmer;
  team: PreviewTeamRow;
  event: string;
  onToggle: ToggleRemoval;
}) {
  const removal = removalFor(team, swimmer, event);
  const label = kind === 'remove' ? `Remove ${event} for ${swimmer.name}` : `Restore ${event} for ${swimmer.name}`;
  return (
    <button
      type="button"
      data-tmeet-toggle={`${removalKey(removal)}|${kind}`}
      aria-label={label}
      title={label}
      onClick={() => onToggle(removal, kind, `${event} for ${swimmer.name}`)}
      className="ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-ui-micro font-medium text-theme-secondary theme-hover-row"
    >
      {kind === 'remove' ? <X size={12} aria-hidden="true" /> : <Undo2 size={12} aria-hidden="true" />}
      {kind === 'remove' ? 'Remove' : 'Restore'}
    </button>
  );
}

function SwimmerEvents({ team, swimmer, onToggle }: { team: PreviewTeamRow; swimmer: PreviewSwimmer; onToggle: ToggleRemoval }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label={`Events for ${swimmer.name}`}>
      {swimmer.chosen.map(entry => (
        <li key={entry.event} className="rounded-md border border-theme-soft bg-[var(--surface-muted)] px-1.5 py-0.5 text-ui-micro text-theme-secondary">
          {entry.event} <span className="text-[var(--text-primary)]">{entry.time}</span>
          {entry.isExhibition ? <span className="ml-1 rounded border border-warning-faint px-1 text-warning">exhibition</span> : null}
          {entry.fillsRemovedSlot ? <span className="ml-1 rounded border border-theme-soft px-1 text-[var(--text-accent)]">in place of a removed event</span> : null}
          <EventToggleButton kind="remove" swimmer={swimmer} team={team} event={entry.event} onToggle={onToggle} />
        </li>
      ))}
      {swimmer.removedByUser.map(entry => (
        <li key={entry.event} className="rounded-md border border-dashed border-theme-soft px-1.5 py-0.5 text-ui-micro text-theme-muted">
          <span className="line-through">{entry.event}</span> {entry.time} <span className="font-medium">removed by you</span>
          <EventToggleButton kind="restore" swimmer={swimmer} team={team} event={entry.event} onToggle={onToggle} />
        </li>
      ))}
    </ul>
  );
}

function SwimmerNotes({ swimmer }: { swimmer: PreviewSwimmer }) {
  return (
    <>
      {swimmer.unfilledSlots > 0 ? (
        <p className="w-full text-ui-micro text-theme-muted">
          {swimmer.unfilledSlots === 1
            ? 'The freed slot stays empty: no other offered event is left for this swimmer.'
            : `${swimmer.unfilledSlots} freed slots stay empty: no other offered events are left for this swimmer.`}
        </p>
      ) : null}
      {swimmer.leftOutByCap > 0 ? <p className="w-full text-ui-micro text-theme-muted">{`${swimmer.leftOutByCap} more left out by the entry cap`}</p> : null}
      {swimmer.excludedExhibitionEvents.length > 0 ? (
        <p className="w-full text-ui-micro text-theme-muted">{`No seed for ${swimmer.excludedExhibitionEvents.join(', ')} (exhibition)`}</p>
      ) : null}
    </>
  );
}

/** The relay part of the preview summary: what was built, what could not be, and the user's per-swimmer limit. */
function relaySummarySentences(relays: PreviewModel['relays']): string {
  if (!relays.requested) return '';
  if (!relays.programKnown) return ' No relay was built: this scoring preset has no relay program on record.';
  const built = ` ${relays.built} estimated ${relays.built === 1 ? 'relay' : 'relays'} built${relays.absent > 0 ? `, ${relays.absent} could not be built` : ''}.`;
  return relays.maxPerSwimmer === null ? built : `${built} Relays per swimmer: at most ${relays.maxPerSwimmer}.`;
}

function RelayCard({ relay }: { relay: PreviewRelay }) {
  return (
    <li className="rounded-md border border-theme-soft p-2" data-tmeet-relay={relay.event}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-caption font-medium text-[var(--text-primary)]">{relay.event}</span>
        <span className="text-ui-caption text-[var(--text-primary)]">{relay.totalTime}</span>
        <Badge tone="warning">{relay.tag}</Badge>
      </div>
      <ol className="mt-1 space-y-0.5">
        {relay.legs.map(leg => (
          <li key={leg.position} className="flex flex-wrap items-baseline gap-x-2 text-ui-micro text-theme-secondary">
            <span className="text-theme-muted">{`Leg ${leg.position}`}</span>
            <span className="text-[var(--text-primary)]">{leg.name}</span>
            <span>{`${leg.strokeLabel} ${leg.time}`}</span>
            {leg.adjustmentSec !== undefined ? <span className="text-theme-muted">{`(flat start ${leg.flatStartTime}, less ${leg.adjustmentSec} s)`}</span> : null}
            {leg.estimated ? <span className="rounded border border-warning-faint px-1 text-warning">estimated</span> : <span className="text-theme-muted">flat-start best</span>}
            {leg.isExhibition ? <span className="rounded border border-warning-faint px-1 text-warning">exhibition</span> : null}
          </li>
        ))}
      </ol>
    </li>
  );
}

function TeamRelays({ team }: { team: PreviewTeamRow }) {
  if (team.relays.length === 0 && team.relaysAbsent.length === 0) return null;
  return (
    <div className="mt-4" data-tmeet-relays-for={`${team.teamName}|${team.genderLabel}`}>
      <h5 className="text-ui-caption font-semibold text-[var(--text-primary)]">
        Relays <Badge tone="warning">estimated</Badge>
      </h5>
      {team.relays.length > 0 ? (
        <ul className="mt-2 space-y-2" aria-label={`Estimated relays for ${team.teamName}`}>
          {team.relays.map(relay => (
            <RelayCard key={relay.id} relay={relay} />
          ))}
        </ul>
      ) : null}
      {team.relaysAbsent.length > 0 ? (
        <div className="mt-2 space-y-1 text-ui-micro text-theme-muted">
          {team.relaysAbsent.map(absent => (
            <div key={absent.event} data-tmeet-relay-absent={absent.event}>
              <span className="font-medium text-theme-secondary">{`No ${absent.event} entry.`}</span> {absent.reasons.join(' ')}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TeamPreview({ team, onToggle }: { team: PreviewTeamRow; onToggle: ToggleRemoval }) {
  const entries = `${team.rowsCreated} ${team.rowsCreated === 1 ? 'entry' : 'entries'}`;
  return (
    <Disclosure
      title={`${team.teamName}, ${team.genderLabel}`}
      summary={team.relays.length > 0 ? `${entries}, ${team.relays.length} ${team.relays.length === 1 ? 'relay' : 'relays'}` : entries}
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
        {team.eventsRemovedByUser > 0 ? (
          <div className="text-ui-caption">
            <dt className="text-theme-secondary">Events removed by you</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">{team.eventsRemovedByUser}</dd>
          </div>
        ) : null}
        {team.exhibitionEventsExcluded > 0 ? (
          <div className="text-ui-caption">
            <dt className="text-theme-secondary">Events dropped as exhibition</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">{team.exhibitionEventsExcluded}</dd>
          </div>
        ) : null}
      </dl>
      <TeamRelays team={team} />
      <h5 className="mt-4 text-ui-caption font-semibold text-[var(--text-primary)]">Chosen events ({team.swimmers.length} swimmers)</h5>
      <ul className="mt-2 space-y-2">
        {team.swimmers.map(swimmer => (
          <li key={swimmer.swimmerKey} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="min-w-[8rem] text-ui-caption font-medium text-[var(--text-primary)]">{swimmer.name}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <SwimmerEvents team={team} swimmer={swimmer} onToggle={onToggle} />
              <SwimmerNotes swimmer={swimmer} />
            </div>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

export function PreviewStep({ flow, captureRows }: { flow: TheoreticalMeetFlow; captureRows: ReadonlyMap<string, CaptureRow> }) {
  const { selected, teamLoads, retryTeam, preview, name, setName, createProblem, removals, toggleEventRemoval, clearRemovals } = flow;
  const model = preview.status === 'ready' ? preview.built.model : null;
  const defaultName = preview.status === 'ready' ? preview.built.build.payload.name : '';
  const removalCount = Object.keys(removals).length;
  const unmatchedRemovals = model === null ? null : describeUnmatchedRemovals(model.unmatchedRemovals);

  // After a toggle the old button is gone. Focus the opposite button of the same event once the new preview is drawn.
  const [announcement, setAnnouncement] = useState('');
  const focusAfter = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onToggle: ToggleRemoval = (removal, action, label) => {
    focusAfter.current = `${removalKey(removal)}|${action === 'remove' ? 'restore' : 'remove'}`;
    setAnnouncement(action === 'remove' ? `Removed ${label}.` : `Restored ${label}.`);
    toggleEventRemoval(removal);
  };
  useEffect(() => {
    const wanted = focusAfter.current;
    if (wanted === null) return;
    const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button[data-tmeet-toggle]') ?? []);
    buttons.find(b => b.dataset.tmeetToggle === wanted)?.focus();
    focusAfter.current = null;
  }, [preview]);

  return (
    <div className="space-y-5" ref={rootRef}>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
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
      {preview.status === 'error' && removalCount > 0 ? (
        <div className="rounded-lg border border-theme-soft p-3 text-ui-caption text-theme-secondary">
          <p>{`You removed ${removalCount} ${removalCount === 1 ? 'event' : 'events'}. The meet cannot be built with the removals in place.`}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={clearRemovals} leadingIcon={<Undo2 size={12} />}>
            Restore all removed events
          </Button>
        </div>
      ) : null}
      {createProblem !== null ? <ProblemPanel problem={createProblem} /> : null}

      {model !== null ? (
        <>
          <section aria-labelledby="tmeet-summary-heading" className="space-y-2">
            <h3 id="tmeet-summary-heading" className="text-ui-label font-semibold text-[var(--text-primary)]">
              Preview
            </h3>
            <p className="text-ui-caption text-theme-secondary">
              {`${model.totalRows} entries from ${model.teamCount} ${model.teamCount === 1 ? 'team' : 'teams'}. Places are the order of the seed times. Remove an event to take it out of a swimmer's lineup. The next-best event fills the slot under the same entry cap.`}
              {relaySummarySentences(model.relays)}
              {model.exhibitionSeedsUsed > 0 ? ` ${model.exhibitionSeedsUsed} of them come from exhibition swims and carry an exhibition tag.` : ''}
              {model.exhibitionEventsExcluded > 0 ? ` ${model.exhibitionEventsExcluded} ${model.exhibitionEventsExcluded === 1 ? 'event was' : 'events were'} dropped because the best swim there is exhibition.` : ''}
              {model.eventsRemovedByUser > 0 ? ` You removed ${model.eventsRemovedByUser} ${model.eventsRemovedByUser === 1 ? 'event' : 'events'}.` : ''}
            </p>
            {unmatchedRemovals !== null ? (
              <p data-testid="tmeet-unmatched-removals" className="text-ui-caption text-warning">
                {unmatchedRemovals}
              </p>
            ) : null}
            {removalCount > 0 ? (
              <Button variant="ghost" size="sm" onClick={clearRemovals} leadingIcon={<Undo2 size={12} />}>
                Restore all removed events
              </Button>
            ) : null}
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
                <TeamPreview key={team.key} team={team} onToggle={onToggle} />
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
