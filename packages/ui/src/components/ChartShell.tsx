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

export function getChartViewportSize(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  return {
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
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
    width: Math.max(0, fallback.width),
    height: Math.max(0, fallback.height),
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const shell = shellRef.current;
    const el = viewport ?? shell;
    if (!el) return;

    const update = () => {
      const measured = viewport ? getChartViewportSize(viewport) : getChartContentBoxSize(shell!);
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
    if (shell && viewport && shell !== viewport) {
      observer.observe(shell);
    }
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
      <div ref={viewportRef} className="chart-shell__viewport">
        {content}
      </div>
    </div>
  );
}
