/**
 * Build a CSV report from a race analysis for download/sharing.
 *
 * Every metric row carries its provenance and approximate flag; an absent
 * value exports as an empty cell plus its reason, never as 0. Units are read
 * from each Measured value rather than assumed.
 */
import { poolLengthForCourse, raceAnalysisReferenceBands } from '@omniswim/core/lib/raceAnalysis';
import type { Measured, RaceAnalysisResult, RaceConfig } from '../types';

export interface MetricsReport {
  filename: string;
  mimeType: string;
  content: string;
}

interface BuildRaceReportParams {
  swimmerName: string;
  config: RaceConfig;
  result: RaceAnalysisResult;
}

const ROW_HEADER = ['Section', 'Metric', 'Value', 'Unit', 'Provenance', 'Approximate', 'Reason'];

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvEscape).join(',');
}

function measuredRow(section: string, metric: string, value: Measured<number>): string {
  if (value.status === 'absent') {
    return csvRow([section, metric, '', '', '', '', value.reason]);
  }
  return csvRow([section, metric, String(value.value), value.unit, value.provenance, value.approximate ? 'yes' : 'no', '']);
}

export function buildRaceReport({ swimmerName, config, result }: BuildRaceReportParams): MetricsReport {
  const lines: string[] = [];
  const pool = poolLengthForCourse(config.course);
  const eventLabel = `${config.course} ${config.raceDistance}${pool.unit}`;

  lines.push(csvRow(['Swimmer', 'Event', 'Course', 'Cycle Definition']));
  lines.push(csvRow([swimmerName || 'Unknown Swimmer', eventLabel, config.course, config.cycleDefinition]));
  lines.push('');

  lines.push('Reference bands cited below (source)');
  for (const band of raceAnalysisReferenceBands) {
    lines.push(csvEscape(`${band.label}: "${band.quote}" — ${band.sourceUrl} (retrieved ${band.retrievedAt})`));
  }
  lines.push('');

  lines.push(csvRow(ROW_HEADER));

  const raceRows: ReadonlyArray<readonly [string, Measured<number>]> = [
    ['Reaction Time', result.reactionTime],
    ['Flight Time', result.flightTime],
    ['Race Time', result.raceTime],
    ['Race Mean Velocity', result.raceMeanVelocity],
    ['Finish Segment Time', result.finishSegmentTime],
    ['Finish Segment Velocity', result.finishSegmentVelocity],
    ['First-to-Last Stroke Rate Delta', result.firstToLastStrokeRateDelta],
    ['First-to-Last Length Mean Velocity Delta', result.firstToLastLengthMeanVelocityDelta],
  ];
  for (const [label, value] of raceRows) {
    lines.push(measuredRow('Race', label, value));
  }

  for (const turn of result.turns) {
    lines.push(measuredRow(`Turn ${turn.turnIndex + 1}`, `Turn Time (before length ${turn.lengthIndex + 1})`, turn.turnTime));
  }

  for (const length of result.lengths) {
    const section = `Length ${length.lengthIndex + 1}`;
    const rows: ReadonlyArray<readonly [string, Measured<number>]> = [
      ['Breakout Time', length.breakoutTime],
      ['Underwater Velocity', length.underwaterVelocity],
      ['Kick Count', length.kickCount],
      ['Kick Tempo', length.kickTempo],
      ['15 m Time', length.fifteenMetreTime],
      ['0-15 m Velocity', length.zeroToFifteenMetreVelocity],
      ['Cycle Count', length.cycleCount],
      ['Stroke Rate', length.strokeRate],
      ['Distance per Cycle', length.distancePerCycle],
      ['Split', length.split],
      ['Mean Velocity', length.meanVelocity],
    ];
    for (const [label, value] of rows) {
      lines.push(measuredRow(section, label, value));
    }
  }

  const safeName = (swimmerName || 'metrics').replace(/[^\w.-]+/g, '_');
  return {
    filename: `${safeName}-${config.course}${config.raceDistance}-report.csv`,
    mimeType: 'text/csv',
    content: lines.join('\r\n'),
  };
}
