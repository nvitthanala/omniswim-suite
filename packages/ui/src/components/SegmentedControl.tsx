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
            className={`flex-1 rounded-xl px-4 py-2 text-ui-label font-bold transition-colors ${
              selected ? 'nav-tab-active' : 'nav-tab-inactive'
            }`}
            aria-pressed={selected}
          >
            <span className="block">{option.label}</span>
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
