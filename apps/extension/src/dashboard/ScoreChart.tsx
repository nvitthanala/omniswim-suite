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

/**
 * The y-axis ticks for totals up to `max`: from 0 in steps of 1, 2 or 5 times a power of ten, about `count` of them. The last tick is the
 * first step at or above `max`, so it can be higher than the largest total. The plot scales to it.
 */
export function niceTicks(max: number, count = 5): number[] {
  const safe = max > 0 ? max : 1;
  const raw = safe / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  const steps = Math.max(1, Math.ceil(safe / step - 1e-9));
  return Array.from({ length: steps + 1 }, (_, index) => Number((index * step).toPrecision(12)));
}

/** Pixels one character of an end label takes at 11 px, rounded up so the estimate errs on the side of a shorter label. */
const LABEL_CHAR_PX = 6.6;
const GENERIC_WORDS = /\s+(University|College|Univ\.?)$/i;

/**
 * The end label of a team: without a trailing "University" or "College", and cut with an ellipsis when it would still run past the
 * `maxChars` that fit. The full name stays in the label's `<title>` and in the legend.
 */
export function shortTeamName(name: string, maxChars: number): string {
  const trimmed = name.trim();
  const short = trimmed.replace(GENERIC_WORDS, '');
  const base = short === '' ? trimmed : short;
  if (base.length <= maxChars) return base;
  // The label never runs past the budget: with room for one character it is the ellipsis alone, with none it is empty.
  if (maxChars < 1) return '';
  return `${base.slice(0, maxChars - 1).trimEnd()}…`;
}

/** A team's total at a step, or `null` when the step does not state one. A missing total is never 0 (CLAUDE.md, data provenance). */
const totalAt = (point: Progression['points'][number], id: TeamId): number | null => {
  const value = point.totals[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const shownTotal = (total: number | null): string => (total === null ? 'missing' : formatTotal(total));

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

  // Every team any step names, not only the first step's. A step that leaves a team out is reported below, and the team's line stops there.
  const teamIds = [...new Set(points.flatMap(point => Object.keys(point.totals)))] as TeamId[];
  const last = points[points.length - 1]!;
  const nameOf = (id: TeamId): string => teamNames[id] ?? String(id);
  const lastKnown = (id: TeamId): number | null => {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const value = totalAt(points[index]!, id);
      if (value !== null) return value;
    }
    return null;
  };
  const missing = points.flatMap((point, index) => teamIds.filter(id => totalAt(point, id) === null).map(id => ({ id, index, point })));
  const totals = teamIds.map(id => ({
    id,
    name: nameOf(id),
    total: totalAt(last, id),
    role: id === ownTeamId ? 'you' : id === rivalTeamId ? 'rival' : null,
  }));
  const largest = Math.max(1, ...points.flatMap(point => teamIds.map(id => totalAt(point, id) ?? 0)));
  const ticks = niceTicks(largest);
  const max = ticks[ticks.length - 1] ?? largest;
  const left = 38;
  // The room for end labels grows with the chart. A label is shortened to what fits, never clipped.
  const right = width >= 500 ? 150 : 108;
  const labelChars = Math.floor((right - 9) / LABEL_CHAR_PX);
  const top = 14;
  const bottom = 34;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const x = (index: number): number => left + (points.length === 1 ? plotWidth : index * plotWidth / (points.length - 1));
  const y = (value: number): number => top + plotHeight - value / max * plotHeight;
  const unplaced = progression.order.kind === 'simulator' && progression.order.reason === 'unplaced'
    ? `these events have no session: ${progression.order.unplaced.map(item => `${item.eventKey} (${item.gender})`).join(', ')}`
    : '';
  const orderLabel = progression.order.kind === 'schedule'
    ? 'Session order'
    : `Simulator order${progression.order.reason === 'no_schedule' ? ' — no session schedule' : ` — ${unplaced}`}`;

  const labelY = new Map<TeamId, number>();
  const labels = totals
    .flatMap(item => { const known = lastKnown(item.id); return known === null ? [] : [{ ...item, desiredY: y(known) }]; })
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

  const accessibleStandings = totals.map(item => `${item.name}${item.role ? ` (${item.role})` : ''} ${item.total === null ? 'total missing' : `${formatTotal(item.total)} points`}`).join(', ');

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
        {ticks.map((value) => {
          return (
            <g key={value} className="osx-score-grid">
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
          const name = nameOf(id);
          const endLabelY = labelY.get(id);
          // One polyline per unbroken run of stated totals: a gap ends the line, it is not bridged and not drawn as 0.
          const runs: string[][] = [];
          let open = false;
          points.forEach((point, index) => {
            const value = totalAt(point, id);
            if (value === null) { open = false; return; }
            if (!open) runs.push([]);
            runs[runs.length - 1]!.push(`${x(index)},${y(value)}`);
            open = true;
          });
          return (
            <g key={id}>
              {runs.map((run, runIndex) => (
                <polyline key={runIndex} className={`osx-score-line osx-score-line--${kind}`} points={run.join(' ')} />
              ))}
              {runs.flatMap((run, runIndex) => run.length === 1 ? [<circle key={`point-${runIndex}`} className={`osx-score-dot osx-score-dot--${kind}`} cx={run[0]?.split(',')[0]} cy={run[0]?.split(',')[1]} r="3" />] : [])}
              {endLabelY !== undefined && (
                <text
                  className={`osx-score-end-label osx-score-end-label--${kind}`}
                  x={width - right + 7}
                  y={endLabelY + 4}
                >
                  <title>{name}</title>
                  {shortTeamName(name, labelChars)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="osx-score-legend">
        {totals.map(item => (
          <li key={item.id}>
            {item.name}{item.role ? ` (${item.role})` : ''}: {shownTotal(item.total)}
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <p className="osx-status osx-status--warn" role="status" data-testid="chart-missing">
          Data missing: {missing.slice(0, 4).map(m => `${nameOf(m.id)} at step ${m.index + 1} (${m.point.eventKey}, ${m.point.gender})`).join('; ')}
          {missing.length > 4 ? `; and ${missing.length - 4} more` : ''}. A team's line stops where its total is missing. It is never drawn as 0.
        </p>
      )}
      <table className="osx-score-hidden">
        <caption>Final team totals</caption>
        <thead>
          <tr><th>Team</th><th>Points</th></tr>
        </thead>
        <tbody>
          {totals.map(item => (
            <tr key={item.id}>
              <th>{item.name}{item.role ? ` (${item.role})` : ''}</th>
              <td>{shownTotal(item.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
