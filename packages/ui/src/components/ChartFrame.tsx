import type { ReactNode } from 'react';

type ChartFrameProps = {
  width: number;
  height: number;
  children: ReactNode;
};

/** Pixel-sized layout box for Recharts; prevents % collapse inside absolute viewports. */
export function ChartFrame({ width, height, children }: ChartFrameProps) {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 8 || h <= 8) {
    return null;
  }
  return (
    <div className="chart-shell__chart" style={{ width: w, height: h, minWidth: 0, minHeight: 0 }}>
      {children}
    </div>
  );
}
