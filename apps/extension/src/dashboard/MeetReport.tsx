import React from 'react';
import { entryKey, scoreProgression, swimmerPoints } from '@omniswim/engine';
import type { Lineup, ReportFacts, Results, SessionPreset, TeamId } from '@omniswim/engine';
import { ScoreChart } from './ScoreChart';

export interface MeetReportProps {
  lineup: Lineup;
  results: Results;
  facts: ReportFacts | null;
  schedule: SessionPreset | null;
  ownTeamId: TeamId;
  rivalTeamId: TeamId | null;
  teamNames: Readonly<Record<TeamId, string>>;
  print?: () => void;
}

export const printReport = (print: () => void = () => window.print()): void => print();

const formatPoints = (value: number): string => String(Math.round(value * 100) / 100);

const seedLabel = (fact: ReportFacts['seeds'][string] | undefined): string => {
  if (!fact) return 'Seed unavailable';
  if (fact.kind === 'none') return fact.reason === 'no_time' ? 'No time' : 'Not convertible';
  const value = fact.hundredths;
  if (fact.kind === 'score') return `${(value / 100).toFixed(2)} points`;
  const hundredths = value % 100;
  const seconds = Math.floor(value / 100) % 60;
  const minutes = Math.floor(value / 6000);
  return `${minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : seconds}.${String(hundredths).padStart(2, '0')}${fact.estimated ? ' (estimated)' : ''}`;
};

export function MeetReport(props: MeetReportProps): React.ReactElement {
  const { lineup, results, facts, schedule, ownTeamId, rivalTeamId, teamNames, print = () => window.print() } = props;
  const progression = scoreProgression(results, schedule);
  const standings = [...results.teams].sort((a, b) => a.rank - b.rank);
  const names = lineup.display?.swimmers ?? {};
  const points = swimmerPoints(results, lineup).filter(row => row.teamId === ownTeamId).sort((a, b) => b.total - a.total);
  const eventOrder = new Map(results.events.map((event, index) => [event.eventKey, index]));
  const entries = [...lineup.entries].filter(entry => entry.teamId === ownTeamId).sort((a, b) =>
    (eventOrder.get(a.eventKey) ?? Number.MAX_SAFE_INTEGER) - (eventOrder.get(b.eventKey) ?? Number.MAX_SAFE_INTEGER));
  const eventGroups = new Map<string, typeof entries>();
  entries.forEach(entry => eventGroups.set(entry.eventKey, [...(eventGroups.get(entry.eventKey) ?? []), entry]));
  const title = (entry: typeof entries[number]): string => entry.kind === 'individual'
    ? names[entry.swimmerId]?.name ?? 'Name unavailable'
    : `${entry.letter} relay`;
  const pointName = (id: string): string => names[id]?.name ?? 'Name unavailable';
  return <article className="osx-meet-report" id="osx-meet-report">
    <header><h1>Meet report</h1><button type="button" className="osx-report-print" onClick={() => printReport(print)}>Print report</button></header>
    <section><h2>Final team standings</h2><table><thead><tr><th>Place</th><th>Team</th><th>Points</th></tr></thead><tbody>
      {standings.map(team => <tr key={team.teamId}><td>{team.rank}</td><th>{teamNames[team.teamId] ?? 'Name unavailable'}{team.teamId === ownTeamId ? ' (you)' : team.teamId === rivalTeamId ? ' (rival)' : ''}</th><td>{formatPoints(team.points)}</td></tr>)}
    </tbody></table></section>
    <section><h2>Score progression</h2><ScoreChart progression={progression} ownTeamId={ownTeamId} rivalTeamId={rivalTeamId} teamNames={teamNames} /></section>
    <section><h2>Your swimmers</h2><table><thead><tr><th>Swimmer</th><th>Individual</th><th>Relay share</th><th>Total</th></tr></thead><tbody>
      {points.map(row => <tr key={row.swimmerId}><th>{pointName(row.swimmerId)}</th><td>{formatPoints(row.individual)}</td><td>{formatPoints(row.relayShare)}</td><td>{formatPoints(row.total)}</td></tr>)}
    </tbody></table></section>
    <section><h2>Your entries</h2>{facts === null && <p>Seeds are unavailable for this snapshot.</p>}
      {[...eventGroups].map(([eventKey, group]) => <div key={eventKey}><h3>{eventKey}</h3><ul>{group.map((entry, index) => <li key={`${entry.kind}-${index}`}>{title(entry)} — {facts === null ? 'Seed unavailable' : seedLabel(facts.seeds[entryKey(entry)])}</li>)}</ul></div>)}
    </section>
  </article>;
}
