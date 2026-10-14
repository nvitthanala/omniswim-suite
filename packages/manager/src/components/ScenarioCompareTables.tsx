/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tables for the two-snapshot compare (F3). Presentational only: every number
 * comes from the `ScenarioDiffResult` that `computeScenarioDiff` returned.
 *
 * The result reports a swimmer or event that one snapshot does not have as
 * 0 points, so a before/after points cell would show 0 for "not entered".
 * These tables show the change in points per row and the two team totals,
 * and nothing more. An empty clock reads "NT".
 */

import React from 'react';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { NO_DIFFERENCES_MESSAGE, clockLabel, formatChange } from './scenarioCompareView';

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
              {result.totals.then.toFixed(1)}
            </td>
            <td className={`${TD} text-right font-mono tabular-nums text-[var(--text-primary)]`}>
              {result.totals.now.toFixed(1)}
            </td>
            <td className={`${TD} text-right`}>
              <ChangeText value={result.totals.delta} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SwimmersTable({ rows }: { rows: SwimmerRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-theme-soft">
      <table className="w-full min-w-0 border-collapse text-left text-ui-micro">
        <caption className="sr-only">Swimmers whose entries or points changed</caption>
        <thead className="surface-overlay text-theme-secondary">
          <tr>
            <th scope="col" className={TH}>
              Swimmer
            </th>
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
              </th>
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

function EventsTable({ rows }: { rows: ScenarioDiffResult['events'] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-theme-soft">
      <table className="w-full min-w-0 border-collapse text-left text-ui-micro">
        <caption className="sr-only">Events whose points changed</caption>
        <thead className="surface-overlay text-theme-secondary">
          <tr>
            <th scope="col" className={TH}>
              Event
            </th>
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
              </th>
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
  return (
    <div className="space-y-3">
      <TotalsTable result={result} labelA={labelA} labelB={labelB} />
      {unchanged ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {NO_DIFFERENCES_MESSAGE}
        </p>
      ) : (
        <>
          {result.swimmers.length > 0 ? <SwimmersTable rows={result.swimmers} /> : null}
          {result.events.length > 0 ? <EventsTable rows={result.events} /> : null}
        </>
      )}
    </div>
  );
}
