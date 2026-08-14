import type { ReactNode } from 'react';

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
  return (
    <div
      className={[
        'inline-flex w-full rounded-2xl border border-theme bg-[var(--surface)] p-1',
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
            // `min-w-0` + a padding that eases off at narrow widths: with three
            // options in a sidebar column, fixed px-4 pushed the last label past
            // the container edge and clipped it mid-word.
            className={`flex-1 min-w-0 rounded-xl px-2 sm:px-3 lg:px-4 py-2 text-ui-label font-bold transition-colors ${
              selected ? 'nav-tab-active' : 'nav-tab-inactive'
            }`}
            aria-pressed={selected}
            title={typeof option.label === 'string' ? option.label : undefined}
          >
            <span className="block truncate">{option.label}</span>
            {option.description ? (
              <span className="mt-0.5 block text-ui-micro font-medium normal-case tracking-normal">
                {option.description}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
