import { type ReactNode, useEffect, useRef, useState } from 'react';

export type ChartShellSize = 'sm' | 'md' | 'lg' | 'fluid';

export type ChartShellRenderState = {
  ready: boolean;
  width: number;
  height: number;
};

type ChartShellProps = {
  size?: ChartShellSize;
  className?: string;
  children: ReactNode | ((state: ChartShellRenderState) => ReactNode);
  placeholder?: ReactNode;
  minPixels?: number;
};

export function isChartMeasurementReady(
  measurement: Pick<ChartShellRenderState, 'width' | 'height'>,
  minPixels = 8
) {
  return measurement.width > minPixels && measurement.height > minPixels;
}

function defaultPlaceholder() {
  return (
    <div className="chart-shell__placeholder" aria-hidden>
      <div className="skeleton-block h-full w-full rounded-lg" />
    </div>
  );
}

export function ChartShell({
  size = 'md',
  className,
  children,
  placeholder,
  minPixels = 8,
}: ChartShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      const rect = el?.getBoundingClientRect();
      if (rect) setMeasurement({ width: rect.width, height: rect.height });
      return;
    }

    const update = () => {
      const rect = el.getBoundingClientRect();
      setMeasurement(current => {
        if (current.width === rect.width && current.height === rect.height) return current;
        return { width: rect.width, height: rect.height };
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const state: ChartShellRenderState = {
    ...measurement,
    ready: isChartMeasurementReady(measurement, minPixels),
  };

  return (
    <div ref={ref} className={['chart-shell', `chart-shell--${size}`, className].filter(Boolean).join(' ')}>
      {state.ready
        ? typeof children === 'function'
          ? children(state)
          : children
        : placeholder ?? defaultPlaceholder()}
    </div>
  );
}
