import React from 'react';
import { Badge } from '@omniswim/ui';
import {
  raceAnalysisReferenceBands,
  UNDERWATER_LEGAL_LIMIT_METRES,
  type ReferenceBand,
} from '@omniswim/core/lib/raceAnalysis';
import type { LengthMetrics, Measured, Problem, RaceAnalysisResult } from '../types';
import { VelocityProfile } from './VelocityProfile';
import { TempoProfile } from './TempoProfile';

const APPROX_CAVEAT =
  'Approximate — derived from an entered or estimated distance, not measured directly from tags.';

function decimalsForMeasured(measured: Extract<Measured<number>, { status: 'value' }>): number {
  if (measured.unit === 'count') return 0;
  if (measured.unit.endsWith('/min')) return 1;
  return 2;
}

function MeasuredValue({ measured }: { measured: Measured<number> }) {
  if (measured.status === 'absent') {
    return (
      <span className="italic text-theme-muted" title={measured.reason}>
        {'not measured'}
      </span>
    );
  }
  const digits = decimalsForMeasured(measured);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[var(--text-primary)]">
        {measured.value.toFixed(digits)}
        {measured.unit !== 'count' ? (
          <span className="ml-1 text-ui-micro opacity-70 text-theme-muted">{measured.unit}</span>
        ) : null}
      </span>
      {measured.approximate ? (
        <Badge tone="neutral" title={APPROX_CAVEAT}>
          {'≈'}
        </Badge>
      ) : null}
    </span>
  );
}

function StatCard({ label, measured, note }: { label: string; measured: Measured<number>; note?: string }) {
  return (
    <div className="surface-card p-4 rounded-xl transition-colors">
      <div className="text-ui-micro text-theme-muted mb-1 uppercase tracking-wider font-bold">{label}</div>
      <div className="text-2xl">
        <MeasuredValue measured={measured} />
      </div>
      {note ? <div className="text-ui-micro text-theme-muted mt-1">{note}</div> : null}
    </div>
  );
}

function BandNote({ bandKey }: { bandKey: ReferenceBand['key'] }) {
  const band = raceAnalysisReferenceBands.find((candidate) => candidate.key === bandKey);
  if (!band) return null;
  const citation = `"${band.quote}" — ${band.label} reference (SwimCloud, retrieved ${band.retrievedAt})`;
  return (
    <a
      href={band.sourceUrl}
      target="_blank"
      rel="noreferrer"
      className="block text-ui-micro text-theme-muted italic border-l-2 border-theme-soft pl-2 mt-3 hover:text-[var(--text-accent)] transition-colors"
    >
      {citation}
    </a>
  );
}

function Section({
  title,
  bandKey,
  children,
}: {
  title: string;
  bandKey?: ReferenceBand['key'];
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em] mb-3">{title}</h3>
      {children}
      {bandKey ? <BandNote bandKey={bandKey} /> : null}
    </section>
  );
}

interface LengthColumn {
  key: string;
  header: string;
  get: (length: LengthMetrics) => Measured<number>;
}

const UNDERWATER_COLUMNS: readonly LengthColumn[] = [
  { key: 'breakoutTime', header: 'BREAKOUT', get: (length) => length.breakoutTime },
  { key: 'underwaterVelocity', header: 'UW VEL', get: (length) => length.underwaterVelocity },
  { key: 'kickCount', header: 'KICKS', get: (length) => length.kickCount },
  { key: 'kickTempo', header: 'KICK TEMPO', get: (length) => length.kickTempo },
];

const FIFTEEN_METRE_COLUMNS: readonly LengthColumn[] = [
  { key: 'fifteenMetreTime', header: '15M TIME', get: (length) => length.fifteenMetreTime },
  { key: 'zeroToFifteenMetreVelocity', header: '0-15M VEL', get: (length) => length.zeroToFifteenMetreVelocity },
];

const STROKE_COLUMNS: readonly LengthColumn[] = [
  { key: 'strokeRate', header: 'RATE', get: (length) => length.strokeRate },
  { key: 'cycleCount', header: 'CYCLES', get: (length) => length.cycleCount },
  { key: 'distancePerCycle', header: 'DIST/CYCLE', get: (length) => length.distancePerCycle },
  { key: 'meanVelocity', header: 'MEAN VEL', get: (length) => length.meanVelocity },
];

function LengthMetricsTable({
  lengths,
  columns,
}: {
  lengths: readonly LengthMetrics[];
  columns: readonly LengthColumn[];
}) {
  const templateColumns = `repeat(${columns.length + 1}, minmax(0, 1fr))`;
  return (
    <div className="surface-card rounded-xl overflow-hidden font-mono text-ui-caption transition-colors">
      <div
        className="grid p-3 border-b border-theme-soft text-theme-muted font-bold bg-[var(--surface-muted)] transition-colors"
        style={{ gridTemplateColumns: templateColumns }}
      >
        <div>{'LEN'}</div>
        {columns.map((column) => (
          <div key={column.key}>{column.header}</div>
        ))}
      </div>
      <div className="divide-y divide-[var(--border-soft)]">
        {lengths.map((length) => (
          <div
            key={length.lengthIndex}
            className="grid p-3 theme-hover-row text-theme-secondary transition-colors"
            style={{ gridTemplateColumns: templateColumns }}
          >
            <div className="text-theme-muted">
              {`L${length.lengthIndex}`}
              {length.lengthIndex === 1 ? (
                <span className="block text-[10px] normal-case opacity-70">{'dive start'}</span>
              ) : null}
            </div>
            {columns.map((column) => (
              <div key={column.key}>
                <MeasuredValue measured={column.get(length)} />
              </div>
            ))}
          </div>
        ))}
        {lengths.length === 0 ? (
          <div className="p-3 text-theme-muted italic">{'No lengths analyzed yet.'}</div>
        ) : null}
      </div>
    </div>
  );
}

function severityTone(severity: string): 'danger' | 'warning' | 'info' | 'neutral' {
  if (severity === 'error') return 'danger';
  if (severity === 'warning') return 'warning';
  if (severity === 'info') return 'info';
  return 'neutral';
}

function ProblemsPanel({ problems }: { problems: readonly Problem[] }) {
  if (problems.length === 0) {
    return (
      <div className="surface-card rounded-xl p-4 text-ui-caption text-theme-muted">
        {'No analysis problems detected.'}
      </div>
    );
  }

  const grouped: Record<string, Problem[]> = {};
  for (const problem of problems) {
    (grouped[problem.severity] ?? (grouped[problem.severity] = [])).push(problem);
  }
  const preferredOrder = ['error', 'warning', 'info'];
  const severityKeys = [
    ...preferredOrder.filter((key) => grouped[key] !== undefined),
    ...Object.keys(grouped).filter((key) => !preferredOrder.includes(key)),
  ];
  const hasError = (grouped.error?.length ?? 0) > 0;

  return (
    <div
      className={
        hasError
          ? 'rounded-xl border-2 border-red-500/60 bg-red-500/10 p-4 transition-colors'
          : 'surface-card rounded-xl p-4 transition-colors'
      }
    >
      {hasError ? (
        <div className="text-ui-caption font-bold text-red-500 dark:text-red-400 mb-3 uppercase tracking-wide">
          {'Analysis incomplete — resolve the error below'}
        </div>
      ) : null}
      <div className="space-y-3">
        {severityKeys.map((severity) => (
          <div key={severity}>
            <div className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted mb-1">{severity}</div>
            <ul className="space-y-1">
              {grouped[severity].map((problem, index) => (
                <li
                  key={`${problem.code}-${index}`}
                  className="flex items-start gap-2 text-ui-caption text-theme-secondary"
                >
                  <Badge tone={severityTone(severity)}>{problem.code}</Badge>
                  <span>
                    {problem.message}
                    {problem.lengthIndex !== undefined ? ` (length ${problem.lengthIndex})` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricsDashboardComponent({ data }: { data: RaceAnalysisResult }) {
  return (
    <div className="space-y-6 flex flex-col h-full">
      <ProblemsPanel problems={data.problems} />

      <section className="grid grid-cols-2 gap-4">
        <StatCard label="Race time" measured={data.raceTime} />
        <StatCard label="Race mean velocity" measured={data.raceMeanVelocity} />
      </section>

      <section>
        <VelocityProfile lengths={data.lengths} turns={data.turns} />
      </section>

      <Section title="Start" bandKey="start">
        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Reaction time" measured={data.reactionTime} />
          <StatCard label="Flight time" measured={data.flightTime} />
        </div>
      </Section>

      <Section title="Underwater" bandKey="underwaterLimit">
        <p className="text-ui-caption text-theme-muted mb-3">
          {`Legal limit: ${UNDERWATER_LEGAL_LIMIT_METRES} m off each wall.`}
        </p>
        <LengthMetricsTable lengths={data.lengths} columns={UNDERWATER_COLUMNS} />
        <p className="text-ui-micro text-theme-muted mt-2">{APPROX_CAVEAT}</p>
      </Section>

      <Section title="15 Metre" bandKey="fifteenMetreTime">
        <LengthMetricsTable lengths={data.lengths} columns={FIFTEEN_METRE_COLUMNS} />
        <p className="text-ui-micro text-theme-muted mt-2">
          {'15 m metrics on lengths after the first are documented approximations (marked ≈).'}
        </p>
      </Section>

      <Section title="Stroke">
        <LengthMetricsTable lengths={data.lengths} columns={STROKE_COLUMNS} />
        <div className="grid grid-cols-2 gap-4 mt-4">
          <StatCard
            label="First to last stroke-rate delta"
            measured={data.firstToLastStrokeRateDelta}
            note="Length 1 starts from a dive, not a push-off — this delta includes the start, not just the mid-race trend."
          />
          <StatCard
            label="First to last velocity delta"
            measured={data.firstToLastLengthMeanVelocityDelta}
            note="Length 1 starts from a dive, not a push-off — this delta includes the start, not just the mid-race trend."
          />
        </div>
        <div className="mt-4">
          <TempoProfile lengths={data.lengths} turns={data.turns} />
        </div>
      </Section>

      <Section title="Turns" bandKey="turnTime">
        <div className="surface-card rounded-xl overflow-hidden font-mono text-ui-caption transition-colors">
          <div className="grid grid-cols-2 p-3 border-b border-theme-soft text-theme-muted font-bold bg-[var(--surface-muted)] transition-colors">
            <div>{'TURN'}</div>
            <div>{'TIME'}</div>
          </div>
          <div className="divide-y divide-[var(--border-soft)]">
            {data.turns.map((turn) => (
              <div
                key={turn.turnIndex}
                className="grid grid-cols-2 p-3 theme-hover-row text-theme-secondary transition-colors"
              >
                <div className="text-theme-muted">
                  {`T${turn.turnIndex} (L${turn.lengthIndex} → L${turn.lengthIndex + 1})`}
                </div>
                <div>
                  <MeasuredValue measured={turn.turnTime} />
                </div>
              </div>
            ))}
            {data.turns.length === 0 ? (
              <div className="p-3 text-theme-muted italic">{'No turns for this race.'}</div>
            ) : null}
          </div>
        </div>
      </Section>

      <Section title="Finish">
        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Finish segment time" measured={data.finishSegmentTime} />
          <StatCard label="Finish segment velocity" measured={data.finishSegmentVelocity} />
        </div>
      </Section>
    </div>
  );
}

export const MetricsDashboard = React.memo(MetricsDashboardComponent);
