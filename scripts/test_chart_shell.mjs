/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards ChartShell's core render gate: Recharts should not mount while its
 * measured parent is effectively collapsed, then should mount once dimensions
 * become usable.
 */
import { isChartMeasurementReady } from '../packages/ui/src/components/ChartShell.tsx';

const cases = [
  [{ width: 0, height: 0 }, false],
  [{ width: 300, height: 0 }, false],
  [{ width: 0, height: 200 }, false],
  [{ width: 8, height: 200 }, false],
  [{ width: 300, height: 200 }, true],
];

for (const [measurement, expected] of cases) {
  const actual = isChartMeasurementReady(measurement);
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(measurement)} readiness to be ${expected}, got ${actual}`
    );
  }
}

console.log('chart shell readiness checks passed');
