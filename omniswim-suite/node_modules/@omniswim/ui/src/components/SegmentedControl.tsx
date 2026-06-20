type Option<T extends string> = {
  id: T;
  label: string;
};

type Props<T extends string> = {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
  disabled,
}: Props<T>) {
  return (
    <div className={`segmented ${className}`.trim()} role="tablist">
      {options.map(opt => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          disabled={disabled}
          className={`segmented-item ${value === opt.id ? 'segmented-item-active' : ''}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
