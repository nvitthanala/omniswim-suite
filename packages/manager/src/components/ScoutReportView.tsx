/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: the result of one scouting comparison. Presentational only: every number comes from the
 * `ScoutReport`. A side with no time shows "no time", never 0.
 */

import React from 'react';
import type { ScoutEvent, ScoutReport } from '../lib/opponentScouting';
import {
  NO_ENTRY_TEXT,
  NO_TIME_TEXT,
  TOTALS_SCOPE_NOTE,
  bestLabel,
  formatPoints,
  leaderText,
  leftOutText,
  noTimeLine,
  notScoutedText,
  summaryText,
  swapText,
  swingText,
} from './scoutOpponentView';

type Props = {
  report: ScoutReport;
  /** Caveats of the seed build and of the scoring rules. Each once. */
  caveats: readonly string[];
  /** Warnings from reading the capture. */
  warnings: readonly string[];
};

function EventList({
  title,
  help,
  events,
  report,
  detail = 'swap',
}: {
  title: string;
  help: string;
  events: readonly ScoutEvent[];
  report: ScoutReport;
  /** `swap`: the two fastest swimmers trading times. `swing`: the closest neighbouring pair that changes the lead. */
  detail?: 'swap' | 'swing';
}) {
  return (
    <section className="space-y-1">
      <h4 className="text-ui-caption font-semibold text-[var(--text-primary)]">
        {title} ({events.length})
      </h4>
      <p className="text-ui-micro text-theme-muted">{help}</p>
      {events.length === 0 ? (
        <p className="text-ui-micro text-theme-muted">None.</p>
      ) : (
        <ul className="space-y-1.5">
          {events.map(event => (
            <li key={event.eventKey} className="rounded-lg border border-theme-soft px-2.5 py-1.5 text-ui-micro">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium text-theme-primary">{event.event}</span>
                <span className="text-theme-secondary">{leaderText(event, report.ourTeam, report.opponentTeam)}</span>
              </div>
              <div className="text-theme-muted">
                You: {bestLabel(event.ourBest)} ({formatPoints(event.ourPoints)} pts). {report.opponentTeam}: {bestLabel(event.theirBest)} ({formatPoints(event.theirPoints)} pts).
              </div>
              <div className="text-theme-muted">
                {detail === 'swing' ? swingText(event, report.ourTeam, report.opponentTeam) : swapText(event)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Notes({ title, lines }: { title: string; lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <section className="space-y-1">
      <h4 className="text-ui-caption font-semibold text-[var(--text-primary)]">{title}</h4>
      <ul className="space-y-1 text-ui-micro text-theme-muted">
        {lines.map((line, index) => (
          <li key={`${index}-${line}`} className="leading-snug">
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ScoutReportView({ report, caveats, warnings }: Props) {
  const totals =
    report.ourTotal === null || report.theirTotal === null
      ? null
      : `Points in the compared events: ${report.ourTeam} ${formatPoints(report.ourTotal)}, ${report.opponentTeam} ${formatPoints(report.theirTotal)}. ${TOTALS_SCOPE_NOTE}`;
  return (
    <div className="space-y-3">
      <p className="text-ui-caption text-theme-secondary leading-relaxed">{summaryText(report)}</p>
      {totals !== null ? <p className="text-ui-micro text-theme-muted">{totals}</p> : null}
      <EventList
        title="Where you lead"
        help="Your fastest swimmer is faster than theirs."
        events={report.wins}
        report={report}
      />
      <EventList
        title="Where you trail"
        help="Their fastest swimmer is faster than yours."
        events={report.losses}
        report={report}
      />
      {report.ties.length > 0 ? (
        <EventList title="Tied" help="Both fastest swimmers have the same time." events={report.ties} report={report} />
      ) : null}
      <EventList
        title="Swing events"
        help="Two neighbouring swimmers from different teams could change which team leads the event in points. Closest pair first. This is not a forecast of the meet."
        events={report.swingEvents}
        report={report}
        detail="swing"
      />
      <Notes
        title={`Events with ${NO_TIME_TEXT} or ${NO_ENTRY_TEXT} on one side`}
        lines={report.noTime.map(n => noTimeLine(n, report.ourTeam, report.opponentTeam))}
      />
      <Notes title="Not compared" lines={report.notScouted.map(notScoutedText)} />
      <Notes title="Left out of the comparison" lines={report.leftOut.map(leftOutText)} />
      <Notes title="Read this first" lines={[...new Set([...caveats, ...warnings])]} />
    </div>
  );
}
