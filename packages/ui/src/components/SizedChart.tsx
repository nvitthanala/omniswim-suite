import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useState,
} from 'react';
import { isChartMeasurementReady } from './ChartShell';

type SizedChartProps = {
  width: number;
  height: number;
  minPixels?: number;
  children: ReactNode;
};

type ChartChildProps = {
  width?: number;
  height?: number;
  responsive?: boolean;
};

/**
 * Injects pixel width/height and responsive={false} into a Recharts chart child.
 * Uses Recharts 3 StaticDiv path — no ResponsiveContainer or % sizing.
 */
export function SizedChart({ width, height, minPixels = 8, children }: SizedChartProps) {
  const w = Math.floor(width);
  const h = Math.floor(height);
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    if (!isChartMeasurementReady({ width: w, height: h }, minPixels)) {
      setMounted(false);
      return;
    }
    const id = requestAnimationFrame(() => setMounted(true));
    return () => {
      cancelAnimationFrame(id);
      setMounted(false);
    };
  }, [w, h, minPixels]);

  if (!mounted || !isChartMeasurementReady({ width: w, height: h }, minPixels)) {
    return null;
  }

  const child = Children.only(children);
  if (!isValidElement(child)) {
    return null;
  }

  return cloneElement(child as ReactElement<ChartChildProps>, {
    width: w,
    height: h,
    responsive: false,
  });
}
