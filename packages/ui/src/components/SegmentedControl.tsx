import { useId, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '../lib/cn';

export type SegmentedControlOption<TValue extends string> = {
  value: TValue;
  label: ReactNode;
  description?: ReactNode;
  /** Per-option tooltip. Falls back to `label` (if it's a string) when omitted. */
  title?: string;
  /** Per-option accessible name. Falls back to `label` (if it's a string) when omitted — set this explicitly when `label` is an icon+text node. */
  ariaLabel?: string;
};

type SegmentedControlLayout = 'fill' | 'inline';

type SegmentedControlProps<TValue extends string> = {
  options: Array<SegmentedControlOption<TValue>>;
  value: TValue;
  onChange: (value: TValue) => void;
  ariaLabel: string;
  className?: string;
  /**
   * `'fill'` (default) is this component's original shape: full width,
   * options share the row equally, a `nav-tab-active` indicator slides
   * between them. Built for a sidebar-style tab strip (its first real
   * consumer, `RosterLineupStep.tsx`'s side panel) — unchanged here.
   *
   * `'inline'` matches the compact, accent-tinted toggle hand-rolled at
   * several two/three-option sites across Matrix before this convergence
   * (Diff/Prelims, Merged/PDF only, By Event/By Class, vs Prelims/vs
   * Psych) — sized to its content next to a heading, not stretched to
   * fill a row, with a static (non-animated) accent background on the
   * selected option rather than a sliding indicator. See
   * `plans/2026-09-10/04-MATRIX-DIAGNOSIS.md` §4b/§5 item 3 for why a
   * single new layout, rather than a `size` prop alone, was needed: none
   * of those sites are full-width, and forcing them to be would be a
   * real layout change, not a size tweak.
   */
  layout?: SegmentedControlLayout;
};

export function SegmentedControl<TValue extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  layout = 'fill',
}: SegmentedControlProps<TValue>) {
  const indicatorId = useId();
  const reduce = useReducedMotion();

  if (layout === 'inline') {
    return (
      <div
        className={cn(
          'inline-flex items-center rounded-md border border-theme-soft surface-overlay p-1',
          className
        )}
        role="group"
        aria-label={ariaLabel}
      >
        {options.map(option => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] uppercase font-medium transition-colors',
                selected
                  ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                  : 'text-theme-secondary hover:text-[var(--text-primary)]'
              )}
              aria-pressed={selected}
              aria-label={option.ariaLabel}
              title={option.title ?? (typeof option.label === 'string' ? option.label : undefined)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        // Wraps rather than truncates. In a narrow sidebar column three labels
        // ("Checklist 10", "Arbitrage", "Scenarios") do not fit on one row: fixed
        // padding pushed the last one past the container edge and clipped it,
        // and shrinking to fit reduced all three to "Checkli… Arbitr… Scena…".
        // Wrapping to a second row keeps every label readable and intact.
        'flex flex-wrap w-full gap-1 rounded-2xl border border-theme bg-[var(--surface)] p-1',
        className
      )}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            // `basis` gives each option a preferred width; once three no longer
            // fit, they wrap instead of being squeezed into ellipses.
            className={cn(
              'relative flex-1 basis-24 rounded-xl px-2 lg:px-3 py-2 text-ui-label font-bold text-center transition-colors',
              selected ? 'text-[var(--text-accent)]' : 'nav-tab-inactive'
            )}
            aria-pressed={selected}
            aria-label={option.ariaLabel}
            title={option.title ?? (typeof option.label === 'string' ? option.label : undefined)}
          >
            {selected ? (
              <motion.span
                layoutId={`${indicatorId}-segmented-indicator`}
                className="absolute inset-0 -z-10 rounded-xl nav-tab-active"
                transition={reduce ? { duration: 0 } : { duration: 0.2, ease: [0.77, 0, 0.175, 1] }}
                aria-hidden
              />
            ) : null}
            <span className="relative block">{option.label}</span>
            {option.description ? (
              <span className="relative mt-0.5 block text-ui-micro font-medium normal-case tracking-normal">
                {option.description}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
