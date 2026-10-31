import React from 'react';
import type { Progression, TeamId } from '@omniswim/engine';

export interface ScoreChartProps {
  progression: Progression;
  ownTeamId: TeamId;
  rivalTeamId: TeamId | null;
  teamNames: Readonly<Record<TeamId, string>>;
  width?: number;
  height?: number;
}

const formatTotal = (value: number): string => Number.isInteger(value) ? String(value) : value.toFixed(1);

export function ScoreChart({
  progression,
  ownTeamId,
  rivalTeamId,
  teamNames,
  width = 640,
  height = 300,
}: ScoreChartProps): React.ReactElement {
  const points = progression.points;
  if (points.length === 0) {
    return <p className="osx-score-empty">No scored events</p>;
  }

  const teamIds = Object.keys(points[0]!.totals) as TeamId[];
  const last = points[points.length - 1]!;
  const totals = teamIds.map(id => ({
    id,
    name: teamNames[id] ?? String(id),
    total: last.totals[id] ?? 0,
    role: id === ownTeamId ? 'you' : id === rivalTeamId ? 'rival' : null,
  }));
  const max = Math.max(1, ...points.flatMap(point => teamIds.map(id => point.totals[id] ?? 0)));
  const left = 38;
  const right = 96;
  const top = 14;
  const bottom = 34;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const x = (index: number): number => left + (points.length === 1 ? plotWidth : index * plotWidth / (points.length - 1));
  const y = (value: number): number => top + plotHeight - value / max * plotHeight;
  const gridCount = 5;
  const unplaced = progression.order.kind === 'simulator' && progression.order.reason === 'unplaced'
    ? `these events have no session: ${progression.order.unplaced.map(item => `${item.eventKey} (${item.gender})`).join(', ')}`
    : '';
  const orderLabel = progression.order.kind === 'schedule'
    ? 'Session order'
    : `Simulator order${progression.order.reason === 'no_schedule' ? ' — no session schedule' : ` — ${unplaced}`}`;

  const labelY = new Map<TeamId, number>();
  const labels = totals
    .map(item => ({ ...item, desiredY: y(item.total) }))
    .sort((a, b) => a.desiredY - b.desiredY);
  const minY = top + 6;
  const maxY = top + plotHeight - 6;
  labels.forEach((item, index) => {
    const prior = index === 0 ? minY : (labelY.get(labels[index - 1]!.id) ?? minY) + 12;
    labelY.set(item.id, Math.max(prior, Math.min(maxY, item.desiredY)));
  });
  for (let index = labels.length - 2; index >= 0; index -= 1) {
    const item = labels[index]!;
    const next = labels[index + 1]!;
    labelY.set(item.id, Math.min(labelY.get(item.id) ?? minY, (labelY.get(next.id) ?? maxY) - 12));
  }
  labels.forEach(item => labelY.set(item.id, Math.max(minY, Math.min(maxY, labelY.get(item.id) ?? minY))));

  const accessibleStandings = totals.map(item => `${item.name}${item.role ? ` (${item.role})` : ''} ${formatTotal(item.total)} points`).join(', ');

  return (
    <section className="osx-score-chart">
      <p className="osx-score-order">{orderLabel}</p>
      <svg
        role="img"
        aria-label={`Final standings: ${accessibleStandings}`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        {Array.from({ length: gridCount + 1 }, (_, index) => {
          const value = max * index / gridCount;
          return (
            <g key={index} className="osx-score-grid">
              <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} />
              <text x={left - 5} y={y(value) + 4} textAnchor="end">{formatTotal(value)}</text>
            </g>
          );
        })}
        {points.map((point, index) => (
          <g key={`${point.eventKey}-${point.gender}`}>
            <title>{`${point.eventKey} (${point.gender})`}</title>
            {(index === 0 || index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 6)) === 0) && (
              <text className="osx-score-tick" x={x(index)} y={height - 8} textAnchor="middle">{index + 1}</text>
            )}
          </g>
        ))}
        {teamIds.map(id => {
          const own = id === ownTeamId;
          const rival = !own && id === rivalTeamId;
          const kind = own ? 'own' : rival ? 'rival' : 'other';
          const name = teamNames[id] ?? String(id);
          const endLabelY = labelY.get(id) ?? y(last.totals[id] ?? 0);
          return (
            <g key={id}>
              <polyline
                className={`osx-score-line osx-score-line--${kind}`}
                points={points.map((point, index) => `${x(index)},${y(point.totals[id] ?? 0)}`).join(' ')}
              />
              <text
                className={`osx-score-end-label osx-score-end-label--${kind}`}
                x={width - right + 7}
                y={endLabelY + 4}
              >
                {name}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="osx-score-legend">
        {totals.map(item => (
          <li key={item.id}>
            {item.name}{item.role ? ` (${item.role})` : ''}: {formatTotal(item.total)}
          </li>
        ))}
      </ul>
      <table className="osx-score-hidden">
        <caption>Final team totals</caption>
        <thead>
          <tr><th>Team</th><th>Points</th></tr>
        </thead>
        <tbody>
          {totals.map(item => (
            <tr key={item.id}>
              <th>{item.name}{item.role ? ` (${item.role})` : ''}</th>
              <td>{formatTotal(item.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
