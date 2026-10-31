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
  const [liveMeasurement, setLiveMeasurement] = useState({ width: 0, height: 0 });
  const [displayMeasurement, setDisplayMeasurement] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const shell = shellRef.current;
    const el = viewport ?? shell;
    if (!el) return;

    const update = () => {
      const viewportSize = viewport ? getChartViewportSize(viewport) : { width: 0, height: 0 };
      const shellSize = shell ? getChartContentBoxSize(shell) : { width: 0, height: 0 };
      const measured = isChartMeasurementReady(viewportSize, minPixels) ? viewportSize : shellSize;
      const liveReady = isChartMeasurementReady(measured, minPixels);
      setLiveMeasurement(current => {
        if (current.width === measured.width && current.height === measured.height) return current;
        return measured;
      });
      setDisplayMeasurement(current => {
        const next = liveReady
          ? { width: Math.floor(measured.width), height: Math.floor(measured.height) }
          : resolveChartMeasurement(measured, size, minPixels);
        if (current.width === next.width && current.height === next.height) return current;
        return next;
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

  const liveReady = isChartMeasurementReady(liveMeasurement, minPixels);

  const state: ChartShellRenderState = {
    width: liveReady ? Math.floor(liveMeasurement.width) : displayMeasurement.width,
    height: liveReady ? Math.floor(liveMeasurement.height) : displayMeasurement.height,
    ready: liveReady,
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
      data-chart-live-ready={liveReady}
      data-chart-w={Math.round(state.width)}
      data-chart-h={Math.round(state.height)}
    >
      <div ref={viewportRef} className="chart-shell__viewport">
        {content}
      </div>
    </div>
  );
}
