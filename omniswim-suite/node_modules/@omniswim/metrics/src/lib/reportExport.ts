/**
 * Build a CSV report from computed biomechanics metrics for download/sharing.
 */
import type { BiomechanicsData, RaceConfig } from '../types';

export type MetricsReport = {
  filename: string;
  mimeType: string;
  content: string;
};

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function buildMetricsReport(
  config: RaceConfig,
  data: BiomechanicsData,
  compareTime?: string | null
): MetricsReport {
  const lines: string[] = [];
  lines.push('Section,Metric,Value');
  lines.push(`Race,Swimmer,${csvEscape(config.swimmerName || 'Unknown')}`);
  lines.push(`Race,Event,${csvEscape(`${config.course} ${config.distance} ${config.stroke}`)}`);
  if (compareTime) lines.push(`Race,Roster Best (workspace),${csvEscape(compareTime)}`);
  lines.push('');

  lines.push('Metric,Value,Unit');
  const metrics: Array<[string, number, string]> = [
    ['Average Velocity', data.avgVelocity, 'm/s'],
    ['Stroke Rate', data.strokeRate, 'spm'],
    ['Distance Per Stroke', data.distancePerStroke, 'm'],
    ['Fatigue Index', data.fatigueIndex, '%'],
    ['Underwater Kick Tempo', data.underwaterKickTempo, 'kpm'],
    ['Dive Velocity', data.diveVelocity, 'm/s'],
    ['Dive Distance', data.diveDistance, 'm'],
    ['Velocity 0-15m', data.vel0to15m, 'm/s'],
    ['Velocity 15m-Wall', data.vel15mToWall, 'm/s'],
    ['First Length Velocity', data.firstLengthVel, 'm/s'],
    ['Breakout Distance', data.breakoutDistance, 'm'],
    ['Breakout Time', data.breakoutTime, 's'],
    ['Kicks Count', data.kicksCount, ''],
  ];
  for (const [label, value, unit] of metrics) {
    lines.push(`${csvEscape(label)},${Number.isFinite(value) ? value.toFixed(2) : ''},${unit}`);
  }
  lines.push('');

  lines.push('Lap,Distance (m),Time (s)');
  for (const s of data.splits) {
    lines.push(`${s.lap},${s.distance},${s.time.toFixed(2)}`);
  }

  const name = (config.swimmerName || 'metrics').replace(/[^\w.-]+/g, '_');
  return {
    filename: `${name}-${config.distance}${config.stroke}-report.csv`,
    mimeType: 'text/csv',
    content: lines.join('\r\n'),
  };
}
