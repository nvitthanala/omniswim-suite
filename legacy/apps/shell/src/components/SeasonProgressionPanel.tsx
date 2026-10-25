import { useId, useMemo, useState } from 'react';
import { buildSeasonProgressions } from '@omniswim/core/lib/seasonAnalytics';
import type { SeasonProgressions, SwimmerProgression } from '@omniswim/core/lib/seasonAnalytics';
import type { Workspace } from '@omniswim/core/types';
import {
  SPARK_BOX,
  describeDrop,
  describeRepeatSwims,
  describeSwimmerProgression,
  describeUnreadableTimes,
  formatSeconds,
  progressionEventLabel,
  sparkGeometry,
} from '../lib/seasonProgressionView';

/**
 * One swimmer's measured times, one point per meet. A meet the swimmer missed is
 * a gap: no point and no line across it. The first swim is a hollow ring, the
 * best swim a solid dot, and the drop between them a vertical bar, so the three
 * read without color. No line runs past the last swim.
 */
function SwimmerSpark({ swimmer, meets, textId }: { swimmer: SwimmerProgression; meets: SeasonProgressions['meets']; textId: string }) {
  const geometry = useMemo(
    () => sparkGeometry(swimmer.points.map(p => (p ? p.seconds : null))),
    [swimmer.points]
  );
  const first = geometry.marks[swimmer.firstIndex];
  const best = geometry.marks[swimmer.bestIndex];
  const hasDrop = swimmer.dropSeconds !== null && swimmer.dropSeconds > 0 && first && best;
  const { width, height, padBottom } = SPARK_BOX;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={textId}
      className="w-full h-auto block"
      data-testid="progression-spark"
    >
      <line
        x1={0}
        x2={width}
        y1={height - padBottom + 2}
        y2={height - padBottom + 2}
        style={{ stroke: 'var(--border-soft)' }}
        strokeWidth={1}
      />
      {geometry.paths.map(d => (
        <path key={d} d={d} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: 'var(--text-secondary)' }} />
      ))}
      {hasDrop ? (
        <g data-testid="progression-drop">
          <line
            x1={first.x}
            x2={best.x}
            y1={first.y}
            y2={first.y}
            strokeWidth={1}
            strokeDasharray="3 3"
            style={{ stroke: 'var(--text-muted)' }}
          />
          <line x1={best.x} x2={best.x} y1={first.y} y2={best.y} strokeWidth={3} style={{ stroke: 'var(--color-success)' }} />
        </g>
      ) : null}
      {geometry.marks.map((m, i) => {
        if (m === null) return null;
        const isFirst = i === swimmer.firstIndex;
        const isBest = i === swimmer.bestIndex;
        return (
          <circle
            key={meets[i]?.id ?? i}
            cx={m.x}
            cy={m.y}
            r={isBest ? 5 : 4}
            strokeWidth={2}
            style={{
              stroke: isBest ? 'var(--color-success)' : isFirst ? 'var(--text-primary)' : 'var(--text-secondary)',
              fill: isBest ? 'var(--color-success)' : isFirst ? 'var(--surface-muted)' : 'var(--text-secondary)',
            }}
          />
        );
      })}
      {geometry.xs.map((x, i) => (
        <text
          key={`n-${meets[i]?.id ?? i}`}
          x={x}
          y={height - 4}
          textAnchor="middle"
          fontSize={10}
          style={{ fill: 'var(--text-muted)' }}
        >
          {i + 1}
        </text>
      ))}
    </svg>
  );
}

function ProgressionKey() {
  return (
    <ul aria-label="How to read the small charts" className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-ui-caption text-theme-secondary">
      <li className="flex items-center gap-2">
        <svg width="16" height="12" aria-hidden="true">
          <circle cx="8" cy="6" r="4" strokeWidth="2" style={{ stroke: 'var(--text-primary)', fill: 'var(--surface-muted)' }} />
        </svg>
        First swim of the season
      </li>
      <li className="flex items-center gap-2">
        <svg width="16" height="12" aria-hidden="true">
          <circle cx="8" cy="6" r="5" strokeWidth="2" style={{ stroke: 'var(--color-success)', fill: 'var(--color-success)' }} />
        </svg>
        Best swim
      </li>
      <li className="flex items-center gap-2">
        <svg width="16" height="12" aria-hidden="true">
          <line x1="8" x2="8" y1="0" y2="12" strokeWidth="3" style={{ stroke: 'var(--color-success)' }} />
        </svg>
        Drop: how much faster the best swim is than the first
      </li>
    </ul>
  );
}

type PanelProps = {
  workspaces: Workspace[];
  /** The team the team picker resolved (`SeasonTrends.team`). `null` when none is chosen. */
  team: string | null;
};

/**
 * Season progression: each swimmer's measured times at one event, meet by meet.
 * The team comes from the page's team picker. The event picker is local.
 */
export function SeasonProgressionPanel({ workspaces, team }: PanelProps) {
  const [pickedEvent, setPickedEvent] = useState<string | null>(null);
  const eventSelectId = useId();
  const textIdBase = useId();

  const progressions = useMemo(
    () => buildSeasonProgressions(workspaces, { team, eventKey: pickedEvent }),
    [workspaces, team, pickedEvent]
  );
  const { events, meets, swimmers, selectedEventKey } = progressions;
  const unreadable = describeUnreadableTimes(progressions.unreadableTimeRows);
  const repeats = describeRepeatSwims(progressions);

  return (
    <div className="panel p-5 mb-6" data-testid="season-progression">
      <h2 className="text-ui-label font-bold text-[var(--text-primary)] mb-1">Swimmer progress by event</h2>
      <p className="text-ui-caption text-theme-muted mb-4">
        Each small chart is one swimmer at one event, one point per meet. Only swims that were timed at a meet are
        shown. A meet the swimmer missed is left as a gap. Nothing is predicted. Dives are scored in points, so they
        are not shown here.
      </p>

      {team === null ? (
        <p className="text-ui-caption text-theme-muted" data-testid="season-progression-empty">
          Choose a team in the team score panel above to see its swimmers.
        </p>
      ) : events.length === 0 ? (
        <p className="text-ui-caption text-theme-muted" data-testid="season-progression-empty">
          No timed swims for {team} in the loaded meets yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <label htmlFor={eventSelectId} className="text-ui-caption font-medium text-theme-secondary">
              Event
            </label>
            <select
              id={eventSelectId}
              value={selectedEventKey ?? ''}
              onChange={event => setPickedEvent(event.target.value || null)}
              className="glass-input rounded-lg py-1.5 px-2 text-ui-caption min-w-[14rem] max-w-full"
            >
              {events.map(option => (
                <option key={option.key} value={option.key}>
                  {progressionEventLabel(option)}
                </option>
              ))}
            </select>
          </div>

          {unreadable ? (
            <p className="text-ui-caption text-warning mt-1" data-testid="season-progression-unreadable">
              {unreadable}
            </p>
          ) : null}
          {repeats ? (
            <p className="text-ui-caption text-theme-muted mt-1" data-testid="season-progression-repeats">
              {repeats}
            </p>
          ) : null}

          {swimmers.length === 0 ? (
            <p className="mt-3 text-ui-caption text-theme-muted" data-testid="season-progression-empty">
              No swimmer has a readable time for this event yet.
            </p>
          ) : (
            <>
              <p className="mt-3 text-ui-caption text-theme-secondary" data-testid="season-progression-meets">
                Meets, left to right, in the order they appear in your workspace list (a meet has no date here, so the list
                order stands in for time):{' '}
                {meets.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 ? '; ' : ''}
                    <span className="font-medium text-[var(--text-primary)]">{i + 1}</span> {m.label}
                  </span>
                ))}
              </p>
              <ProgressionKey />

              <ul className="mt-4 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" aria-label="Swimmer progress">
                {swimmers.map((s, index) => {
                  const textId = `${textIdBase}-${index}`;
                  return (
                    <li
                      key={s.name}
                      className="rounded-lg border border-theme-soft bg-[var(--surface-muted)] p-3 min-w-0"
                      data-testid="progression-card"
                    >
                      <h3 className="text-ui-label font-bold text-[var(--text-primary)] truncate">{s.name}</h3>
                      <SwimmerSpark swimmer={s} meets={meets} textId={textId} />
                      <p className="text-ui-caption text-theme-secondary">
                        <span className="font-mono tabular-nums">{s.firstTime}</span>
                        {s.dropSeconds === null ? null : (
                          <>
                            {' → '}
                            <span className="font-mono tabular-nums text-[var(--color-success)]">{s.bestTime}</span>
                          </>
                        )}
                        <span className="block text-theme-muted">{describeDrop(s.dropSeconds)}</span>
                        <span id={textId} className="sr-only">
                          {describeSwimmerProgression(s, meets)}
                        </span>
                      </p>
                    </li>
                  );
                })}
              </ul>

              <p className="mt-4 text-ui-caption text-theme-muted">
                The same swims as a table. A dash means the swimmer has no timed swim at that meet.
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-ui-caption" data-testid="progression-table">
                  <thead>
                    <tr className="text-theme-muted border-b border-theme-soft">
                      <th scope="col" className="text-left py-2 pr-4">Swimmer</th>
                      <th scope="col" className="text-left py-2 pr-4">First</th>
                      <th scope="col" className="text-left py-2 pr-4">Best</th>
                      <th scope="col" className="text-left py-2 pr-4">Drop</th>
                      {meets.map((m, i) => (
                        <th key={m.id} scope="col" className="text-left py-2 pr-4" title={m.label}>
                          Meet {i + 1}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {swimmers.map(s => (
                      <tr key={s.name} className="border-b border-theme-soft/50">
                        <th scope="row" className="text-left py-2 pr-4 font-medium">{s.name}</th>
                        <td className="py-2 pr-4 font-mono tabular-nums">{s.firstTime}</td>
                        <td className="py-2 pr-4 font-mono tabular-nums text-[var(--text-accent)]">{s.bestTime}</td>
                        <td className="py-2 pr-4 font-mono tabular-nums">
                          {s.dropSeconds === null ? 'one swim' : formatSeconds(s.dropSeconds)}
                        </td>
                        {s.points.map((p, i) => (
                          <td key={meets[i]?.id ?? i} className="py-2 pr-4 font-mono tabular-nums text-theme-muted">
                            {p ? (
                              p.time
                            ) : (
                              <>
                                <span aria-hidden="true">—</span>
                                <span className="sr-only">no timed swim</span>
                              </>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
