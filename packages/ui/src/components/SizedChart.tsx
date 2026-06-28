import type { ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';
import { isChartMeasurementReady } from './ChartShell';

type SizedChartProps = {
  width: number;
  height: number;
  minPixels?: number;
  children: ReactNode;
};

/**
 * Recharts 3 fast path: numeric width/height on ResponsiveContainer skips DOM
 * resize detection and provides sizing context to chart children.
 * Do not use %/100% here — ChartShell already supplies pixel dimensions.
 */
export function SizedChart({ width, height, minPixels = 8, children }: SizedChartProps) {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!isChartMeasurementReady({ width: w, height: h }, minPixels)) {
    return null;
  }
  return (
    <ResponsiveContainer width={w} height={h}>
      {children}
    </ResponsiveContainer>
  );
}
