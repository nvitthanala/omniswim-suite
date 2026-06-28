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

const FALLBACK_CONTENT: Record<ChartShellSize, { width: number; height: number }> = {
  sm: { width: 400, height: 192 },
  md: { width: 400, height: 256 },
  lg: { width: 400, height: 288 },
  fluid: { width: 400, height: 300 },
};

const SHELL_PADDING_PX = 16;

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

export function resolveChartMeasurement(
  measured: { width: number; height: number },
  size: ChartShellSize,
  minPixels = 8
) {
  if (isChartMeasurementReady(measured, minPixels)) {
    return measured;
  }
  const fallback = FALLBACK_CONTENT[size];
  return {
    width: Math.max(0, fallback.width - SHELL_PADDING_PX),
    height: Math.max(0, fallback.height - SHELL_PADDING_PX),
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
  const shellRef = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;

    const update = () => {
      const measured = getChartContentBoxSize(el);
      const resolved = resolveChartMeasurement(measured, size, minPixels);
      setMeasurement(current => {
        if (current.width === resolved.width && current.height === resolved.height) return current;
        return resolved;
      });
    };

    update();
    const raf = requestAnimationFrame(update);

    if (typeof ResizeObserver === 'undefined') {
      return () => cancelAnimationFrame(raf);
    }

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [size, minPixels]);

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
    <div
      ref={shellRef}
      className={['chart-shell', `chart-shell--${size}`, className].filter(Boolean).join(' ')}
      data-chart-ready={state.ready}
      data-chart-w={Math.round(measurement.width)}
      data-chart-h={Math.round(measurement.height)}
    >
      <div className="chart-shell__viewport">{content}</div>
    </div>
  );
}
