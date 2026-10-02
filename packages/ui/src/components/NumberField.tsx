import { useEffect, useState } from 'react';
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

  useEffect(() => {
    if (!invalid) setDraft(String(value));
  }, [value, invalid]);

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
    onValueChange(parsed);
  };

  return <input {...props} type="text" inputMode="decimal" value={draft} aria-invalid={invalid || undefined} onChange={event => change(event.currentTarget.value)} onBlur={() => { if (invalid) { setDraft(String(value)); setInvalid(false); } }} />;
}
