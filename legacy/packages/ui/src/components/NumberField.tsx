import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';

export type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'> & {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
};

/** Editable numeric text that only publishes complete, valid values. */
export function NumberField({ value, onValueChange, min, max, step = 1, ...props }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);

  // The last value this field published. The draft text re-syncs from `value`
  // only when `value` differs from it (an external change). Re-syncing on every
  // validity flip made "2." -> "2.0" snap back to "2" and turned ".05" into 25.
  const lastPublished = useRef(value);

  useEffect(() => {
    if (value === lastPublished.current) return;
    lastPublished.current = value;
    setDraft(String(value));
    setInvalid(false);
  }, [value]);

  const change = (next: string) => {
    setDraft(next);
    const parsed = next.trim() === '' ? Number.NaN : Number(next);
    const stepRatio = (parsed - (min ?? 0)) / step;
    const validStep = Math.abs(stepRatio - Math.round(stepRatio)) < 1e-8;
    if (!Number.isFinite(parsed) || next.endsWith('.') || (min !== undefined && parsed < min) || (max !== undefined && parsed > max) || !validStep) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    lastPublished.current = parsed;
    onValueChange(parsed);
  };

  return <input {...props} type="text" inputMode="decimal" value={draft} aria-invalid={invalid || undefined} onChange={event => change(event.currentTarget.value)} onBlur={() => { if (invalid) { setDraft(String(value)); setInvalid(false); } }} />;
}
