/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The inputs and the one message formatter behind the "a blank place cell blocks
 * save" rule (user decision U5, 2026-10-12; core contract in
 * `packages/core/src/lib/scoringPlaceTables.ts`).
 *
 * `NumberField` cannot show "not entered yet": it only publishes a complete
 * number and reverts a blank on blur. A place table that grows, or a relay or
 * diving table that is switched on, needs a cell that really is empty. The
 * inputs here publish `null` for an empty box and never `0`, `NaN` or a guess.
 */
import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import type { BlankPlace, PlaceTableName } from '@omniswim/core/lib/scoringPlaceTables';

export type NullableNumberFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'
> & {
  /** `null` is an empty box. A stored `0` is a real 0 and displays as "0". */
  value: number | null;
  /** `null` fires the moment the box is emptied. Malformed or out-of-range text fires nothing. */
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
};

/**
 * Editable numeric text where an empty box is a legal value (`null`).
 *
 * Mirrors `NumberField` (same step, range and trailing-dot checks, same
 * `lastPublished` re-sync rule) with one difference: an empty string publishes
 * `null` at once. Text that is malformed or out of range publishes nothing and
 * reverts to the last published value on blur, exactly like `NumberField`.
 */
export function NullableNumberField({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  ...props
}: NullableNumberFieldProps) {
  const show = (v: number | null) => (v === null ? '' : String(v));
  const [draft, setDraft] = useState(show(value));
  const [invalid, setInvalid] = useState(false);

  // The last value this field published. The text re-syncs from `value` only
  // when `value` differs from it (an external change such as a preset), so a
  // half-typed "2." is never overwritten by its own echo.
  const lastPublished = useRef<number | null>(value);

  useEffect(() => {
    if (value === lastPublished.current) return;
    lastPublished.current = value;
    setDraft(show(value));
    setInvalid(false);
  }, [value]);

  const change = (next: string) => {
    setDraft(next);
    if (next.trim() === '') {
      setInvalid(false);
      lastPublished.current = null;
      onValueChange(null);
      return;
    }
    const parsed = Number(next);
    const stepRatio = (parsed - (min ?? 0)) / step;
    const validStep = Math.abs(stepRatio - Math.round(stepRatio)) < 1e-8;
    if (
      !Number.isFinite(parsed) ||
      next.endsWith('.') ||
      (min !== undefined && parsed < min) ||
      (max !== undefined && parsed > max) ||
      !validStep
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    lastPublished.current = parsed;
    onValueChange(parsed);
  };

  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      value={draft}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      onChange={event => change(event.currentTarget.value)}
      onBlur={event => {
        if (invalid) {
          setDraft(show(value));
          setInvalid(false);
        }
        props.onBlur?.(event);
      }}
    />
  );
}

/**
 * One "Place N" points cell. An empty cell is `null`: not yet entered, never
 * "worth 0". An empty cell is outlined in the warning colour and marked
 * `aria-invalid` so a coach sees which cell blocks Save without reading the notice.
 */
export function NullablePlacePointInput({
  value,
  onValueChange,
  ariaLabel,
}: {
  value: number | null;
  onValueChange: (value: number | null) => void;
  ariaLabel: string;
}) {
  const blank = value === null;
  return (
    <NullableNumberField
      aria-label={ariaLabel}
      aria-invalid={blank || undefined}
      min={0}
      step={0.01}
      value={value}
      onValueChange={onValueChange}
      className="glass-input w-full font-mono text-xs"
      style={blank ? { borderColor: 'var(--color-warning)' } : undefined}
    />
  );
}

const TABLE_NAME: Record<PlaceTableName, string> = {
  scoringPoints: 'Scoring table',
  relayPoints: 'Relay table',
  divingPoints: 'Diving table',
};

/**
 * Plain-words reason a Save button is disabled, naming each table.
 *
 * One blank: "Relay table: place 1 is blank." Several in one table:
 * "Scoring table: places 9, 10, 11 and 12 are blank." Several tables join with
 * a space. Returns `null` when there is nothing blank, so a host can render the
 * result directly.
 */
export function describeBlankPlaces(blanks: readonly BlankPlace[]): string | null {
  if (blanks.length === 0) return null;
  const byTable = new Map<PlaceTableName, number[]>();
  for (const b of blanks) {
    byTable.set(b.table, [...(byTable.get(b.table) ?? []), b.place]);
  }
  return [...byTable.entries()]
    .map(([table, places]) => {
      if (places.length === 1) return `${TABLE_NAME[table]}: place ${places[0]} is blank.`;
      const head = places.slice(0, -1).join(', ');
      return `${TABLE_NAME[table]}: places ${head} and ${places[places.length - 1]} are blank.`;
    })
    .join(' ');
}

/**
 * The visible reason next to a disabled Save button. Renders nothing when no
 * cell is blank. Give the Save button `aria-describedby={id}` so a screen
 * reader hears the reason with the button.
 */
export function BlankPlacesNotice({ blanks, id }: { blanks: readonly BlankPlace[]; id?: string }) {
  const text = describeBlankPlaces(blanks);
  if (!text) return null;
  return (
    <p id={id} role="status" className="text-ui-caption text-[var(--color-warning)] min-w-0">
      {text} Fill each blank place to save.
    </p>
  );
}
