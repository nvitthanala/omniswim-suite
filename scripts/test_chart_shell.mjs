/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards ChartShell's core render gate: Recharts should not mount while its
 * measured parent is effectively collapsed, then should mount once dimensions
 * become usable.
 *
 * Rule: never wrap ChartShell-sized charts in ResponsiveContainer — pass pixel
 * width/height directly to LineChart/BarChart/AreaChart instead.
 */
import {
  getChartContentBoxSize,
  isChartMeasurementReady,
} from '../packages/ui/src/components/ChartShell.tsx';

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

// Render-prop contract: pixel dimensions must exceed minPixels before charts mount.
const minPixels = 8;
for (const { width, height, expectedReady } of [
  { width: 300, height: 200, expectedReady: true },
  { width: 8, height: 200, expectedReady: false },
]) {
  const ready = isChartMeasurementReady({ width, height }, minPixels);
  if (ready !== expectedReady) {
    throw new Error(`render-prop gate: ${width}x${height} expected ready=${expectedReady}, got ${ready}`);
  }
}

console.log('chart shell render-prop gate checks passed');

// Content-box sizing: subtract padding from border-box measurements.
const contentBoxCases = [
  { rect: { width: 300, height: 200 }, padding: { left: 8, right: 8, top: 8, bottom: 8 }, expected: { width: 284, height: 184 } },
  { rect: { width: 100, height: 50 }, padding: { left: 0, right: 0, top: 0, bottom: 0 }, expected: { width: 100, height: 50 } },
  { rect: { width: 20, height: 20 }, padding: { left: 12, right: 12, top: 4, bottom: 4 }, expected: { width: 0, height: 12 } },
];

for (const { rect, padding, expected } of contentBoxCases) {
  const el = {
    getBoundingClientRect: () => rect,
  };
  const style = {
    paddingLeft: `${padding.left}px`,
    paddingRight: `${padding.right}px`,
    paddingTop: `${padding.top}px`,
    paddingBottom: `${padding.bottom}px`,
  };
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => style;

  const size = getChartContentBoxSize(el);
  globalThis.getComputedStyle = originalGetComputedStyle;

  if (size.width !== expected.width || size.height !== expected.height) {
    throw new Error(
      `content-box size expected ${JSON.stringify(expected)}, got ${JSON.stringify(size)}`
    );
  }
}

console.log('chart shell content-box sizing checks passed');
