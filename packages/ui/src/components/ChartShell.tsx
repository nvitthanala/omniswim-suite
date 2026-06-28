import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

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

export function getChartContentBoxSize(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return {
    width: Math.max(0, rect.width - padX),
    height: Math.max(0, rect.height - padY),
  };
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

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const { width, height } = getChartContentBoxSize(el);
      setMeasurement(current => {
        if (current.width === width && current.height === height) return current;
        return { width, height };
      });
    };

    update();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const state: ChartShellRenderState = {
    ...measurement,
    ready: isChartMeasurementReady(measurement, minPixels),
  };

  const content =
    !state.ready
      ? placeholder ?? defaultPlaceholder()
      : typeof children === 'function'
        ? children(state)
        : children;

  return (
    <div className={['chart-shell', `chart-shell--${size}`, className].filter(Boolean).join(' ')}>
      <div ref={ref} className="chart-shell__viewport">
        {content}
      </div>
    </div>
  );
}
