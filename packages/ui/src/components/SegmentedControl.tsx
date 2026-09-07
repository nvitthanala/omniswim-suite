import { useId, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

export type SegmentedControlOption<TValue extends string> = {
  value: TValue;
  label: ReactNode;
  description?: ReactNode;
};

type SegmentedControlProps<TValue extends string> = {
  options: Array<SegmentedControlOption<TValue>>;
  value: TValue;
  onChange: (value: TValue) => void;
  ariaLabel: string;
  className?: string;
};

export function SegmentedControl<TValue extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<TValue>) {
  const indicatorId = useId();
  const reduce = useReducedMotion();

  return (
    <div
      className={[
        // Wraps rather than truncates. In a narrow sidebar column three labels
        // ("Checklist 10", "Arbitrage", "Scenarios") do not fit on one row: fixed
        // padding pushed the last one past the container edge and clipped it,
        // and shrinking to fit reduced all three to "Checkli… Arbitr… Scena…".
        // Wrapping to a second row keeps every label readable and intact.
        'flex flex-wrap w-full gap-1 rounded-2xl border border-theme bg-[var(--surface)] p-1',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
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
            className={`relative flex-1 basis-24 rounded-xl px-2 lg:px-3 py-2 text-ui-label font-bold text-center transition-colors ${
              selected ? 'text-[var(--text-accent)]' : 'nav-tab-inactive'
            }`}
            aria-pressed={selected}
            title={typeof option.label === 'string' ? option.label : undefined}
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
