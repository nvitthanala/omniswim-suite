/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tables for the two-snapshot compare (F3). Presentational only: every number
 * comes from the `ScenarioDiffResult` that `computeScenarioDiff` returned.
 *
 * The result still reports a swimmer, event or team that one snapshot does not
 * have as 0 points. Every row also carries `inThen` / `inNow`, and these
 * tables read those flags: a side with no entry shows a dash, never "0.0", and
 * a row only one side holds reads "Added" or "Removed". An empty clock reads
 * "NT".
 */

import React from 'react';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import {
  ABSENT_LABEL,
  NO_DIFFERENCES_MESSAGE,
  clockLabel,
  formatChange,
  noTeamResultsMessage,
  rowStatus,
  sidePointsLabel,
} from './scenarioCompareView';

function ChangeText({ value }: { value: number }) {
  const cls =
    Math.abs(value) < 1e-6
      ? 'text-theme-muted'
      : value > 0
        ? 'text-points-positive'
        : 'text-points-negative';
  return <span className={`font-mono tabular-nums ${cls}`}>{formatChange(value)}</span>;
}

const TH = 'px-2 py-2 font-medium';
const TD = 'px-2 py-1.5 align-top';

type SwimmerRow = ScenarioDiffResult['swimmers'][number];
type EventRow = ScenarioDiffResult['events'][number];
type SideLabels = { labelA: string; labelB: string };

/** "Added" or "Removed" as plain text beside a name. Nothing when both sides hold the row. */
function StatusText({ inThen, inNow }: { inThen: boolean; inNow: boolean }) {
  const status = rowStatus(inThen, inNow);
  if (status === null) return null;
  return <span className="text-theme-muted"> ({status})</span>;
}

/** Before or after points for one side, or a dash when that side has no entry. */
function SidePoints({ present, points }: { present: boolean; points: number }) {
  const tone = present ? 'text-theme-secondary' : 'text-theme-muted';
  return (
    <td className={`${TD} text-right font-mono tabular-nums ${tone}`}>
      {sidePointsLabel(present, points)}
    </td>
  );
}

function SideHeads({ labelA, labelB }: SideLabels) {
  return (
    <>
      <th scope="col" className={`${TH} text-right`} title={labelA}>
        Snapshot A
      </th>
      <th scope="col" className={`${TH} text-right`} title={labelB}>
        Snapshot B
      </th>
    </>
  );
}

/** One line per change, in plain words. Empty when the row only moved points. */
function ChangeLines({ row }: { row: SwimmerRow }) {
  const lines: string[] = [
    ...row.eventsAdded.map(e => `Added ${e}`),
    ...row.eventsRemoved.map(e => `Removed ${e}`),
    ...row.eventsChanged.map(
      c => `${c.event}: ${clockLabel(c.timeThen)} to ${clockLabel(c.timeNow)}`
    ),
  ];
  if (lines.length === 0) {
    return <span className="text-theme-muted">Same entries, different points</span>;
  }
  return (
    <ul className="space-y-0.5">
      {lines.map(line => (
        <li key={line} className="leading-snug">
          {line}
        </li>
      ))}
    </ul>
  );
}

type Props = {
  result: ScenarioDiffResult;
  labelA: string;
  labelB: string;
};

/** Both snapshots' team totals and the change between them. */
function TotalsTable({ result, labelA, labelB }: Props) {
  return (
    <div className="overflow-x-auto rounded-lg border border-theme-soft">
      <table className="w-full min-w-0 border-collapse text-left text-ui-micro">
        <caption className="sr-only">Team totals for {result.team}</caption>
        <thead className="surface-overlay text-theme-secondary">
          <tr>
            <th scope="col" className={TH}>
              Team
            </th>
            <th scope="col" className={`${TH} text-right`} title={labelA}>
              Snapshot A
            </th>
            <th scope="col" className={`${TH} text-right`} title={labelB}>
              Snapshot B
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-theme-soft">
            <th scope="row" className={`${TD} font-semibold text-[var(--text-primary)]`}>
              {result.team}
            </th>
            <td className={`${TD} text-right font-mono tabular-nums text-theme-secondary`}>
              {sidePointsLabel(result.totals.inThen, result.totals.then)}
            </td>
            <td className={`${TD} text-right font-mono tabular-nums text-[var(--text-primary)]`}>
              {sidePointsLabel(result.totals.inNow, result.totals.now)}
            </td>
            <td className={`${TD} text-right`}>
              {result.totals.inThen || result.totals.inNow ? (
                <ChangeText value={result.totals.delta} />
              ) : (
                <span className="font-mono tabular-nums text-theme-muted">{ABSENT_LABEL}</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SwimmersTable({ rows, labelA, labelB }: SideLabels & { rows: SwimmerRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-theme-soft">
      <table className="w-full min-w-0 border-collapse text-left text-ui-micro">
        <caption className="sr-only">Swimmers whose entries or points changed</caption>
        <thead className="surface-overlay text-theme-secondary">
          <tr>
            <th scope="col" className={TH}>
              Swimmer
            </th>
            <SideHeads labelA={labelA} labelB={labelB} />
            <th scope="col" className={`${TH} text-right`}>
              Change
            </th>
            <th scope="col" className={TH}>
              What changed
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr
              key={`${row.isRelay ? 'relay' : 'ind'}:${row.name}`}
              className="border-t border-theme-soft"
            >
              <th scope="row" className={`${TD} font-normal text-[var(--text-primary)]`}>
                {row.name}
                {row.isRelay ? <span className="text-theme-muted"> (relay)</span> : null}
                <StatusText inThen={row.inThen} inNow={row.inNow} />
              </th>
              <SidePoints present={row.inThen} points={row.pointsThen} />
              <SidePoints present={row.inNow} points={row.pointsNow} />
              <td className={`${TD} text-right`}>
                <ChangeText value={row.deltaPoints} />
              </td>
              <td className={`${TD} text-theme-secondary`}>
                <ChangeLines row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventsTable({ rows, labelA, labelB }: SideLabels & { rows: EventRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-theme-soft">
      <table className="w-full min-w-0 border-collapse text-left text-ui-micro">
        <caption className="sr-only">Events whose points changed</caption>
        <thead className="surface-overlay text-theme-secondary">
          <tr>
            <th scope="col" className={TH}>
              Event
            </th>
            <SideHeads labelA={labelA} labelB={labelB} />
            <th scope="col" className={`${TH} text-right`}>
              Change
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Swimmers changed
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.event} className="border-t border-theme-soft">
              <th scope="row" className={`${TD} font-normal text-theme-secondary`}>
                {row.event}
                <StatusText inThen={row.inThen} inNow={row.inNow} />
              </th>
              <SidePoints present={row.inThen} points={row.pointsThen} />
              <SidePoints present={row.inNow} points={row.pointsNow} />
              <td className={`${TD} text-right`}>
                <ChangeText value={row.delta} />
              </td>
              <td className={`${TD} text-right font-mono tabular-nums text-theme-muted`}>
                {row.swimmersChanged}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The whole compare result: totals, then swimmers and events that changed. */
export function ScenarioCompareResult({ result, labelA, labelB }: Props) {
  const unchanged = result.swimmers.length === 0 && result.events.length === 0;
  const teamAbsent = !result.totals.inThen && !result.totals.inNow;
  return (
    <div className="space-y-3">
      <TotalsTable result={result} labelA={labelA} labelB={labelB} />
      {teamAbsent ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {noTeamResultsMessage(result.team)}
        </p>
      ) : unchanged ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {NO_DIFFERENCES_MESSAGE}
        </p>
      ) : (
        <>
          {result.swimmers.length > 0 ? (
            <SwimmersTable rows={result.swimmers} labelA={labelA} labelB={labelB} />
          ) : null}
          {result.events.length > 0 ? (
            <EventsTable rows={result.events} labelA={labelA} labelB={labelB} />
          ) : null}
        </>
      )}
    </div>
  );
}
