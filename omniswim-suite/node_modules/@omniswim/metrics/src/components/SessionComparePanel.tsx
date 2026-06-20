import type { BiomechanicsData } from '../types';
import type { MetricsSession } from '../lib/sessionStore';

type Props = {
  current: BiomechanicsData;
  sessions: MetricsSession[];
  currentLabel: string;
};

export function SessionComparePanel({ current, sessions, currentLabel }: Props) {
  const withData = sessions.filter(s => s.data && s.id);
  if (withData.length === 0) return null;

  return (
    <section className="panel p-4 border border-theme-soft rounded-xl">
      <h3 className="text-ui-label font-bold text-[var(--text-primary)] mb-3">Multi-session compare</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-ui-caption">
          <thead>
            <tr className="text-theme-muted border-b border-theme-soft">
              <th className="text-left py-2 pr-3">Session</th>
              <th className="text-left py-2 pr-3">Avg vel</th>
              <th className="text-left py-2 pr-3">Stroke rate</th>
              <th className="text-left py-2">DPS</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-theme-soft/50 bg-[var(--text-accent)]/5">
              <td className="py-2 pr-3 font-bold">{currentLabel} (current)</td>
              <td className="py-2 pr-3 font-mono">{current.avgVelocity.toFixed(2)} m/s</td>
              <td className="py-2 pr-3 font-mono">{Math.round(current.strokeRate)}</td>
              <td className="py-2 font-mono">{current.distancePerStroke.toFixed(2)} m</td>
            </tr>
            {withData.slice(0, 5).map(s => (
              <tr key={s.id} className="border-b border-theme-soft/50">
                <td className="py-2 pr-3">{s.name}</td>
                <td className="py-2 pr-3 font-mono">{s.data!.avgVelocity.toFixed(2)} m/s</td>
                <td className="py-2 pr-3 font-mono">{Math.round(s.data!.strokeRate)}</td>
                <td className="py-2 font-mono">{s.data!.distancePerStroke.toFixed(2)} m</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LapCompareTable({ data }: { data: BiomechanicsData }) {
  const dps = data.distancePerStroke;
  return (
    <section className="mt-4">
      <h3 className="text-ui-label font-bold text-[var(--text-primary)] mb-2">Lap-by-lap</h3>
      <div className="grid gap-2">
        {data.splits.map(s => {
          const vel = s.distance / s.time;
          const lapDps = vel * (60 / data.strokeRate);
          return (
            <div
              key={s.lap}
              className="flex items-center justify-between text-ui-caption px-3 py-2 rounded-lg border border-theme-soft"
            >
              <span className="text-theme-muted">Lap {s.lap}</span>
              <span className="font-mono tabular-nums">{s.time.toFixed(2)}s</span>
              <span className="font-mono tabular-nums text-[var(--text-accent)]">{vel.toFixed(2)} m/s</span>
              <span className="font-mono tabular-nums text-theme-muted">{lapDps.toFixed(2)} m/str</span>
            </div>
          );
        })}
      </div>
      <p className="text-ui-micro text-theme-muted mt-2">Avg DPS reference: {dps.toFixed(2)} m/stroke</p>
    </section>
  );
}
