/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "centered card over a full-screen backdrop" shape, built independently
 * 6 times across Manager alone before this — three different backdrop
 * conventions, two of them hardcoding `bg-black/50` instead of the
 * `var(--backdrop)` theme token the other four use. See
 * `plans/2026-09-10/03-MANAGER-DIAGNOSIS.md` §4e.
 *
 * Deliberately minimal: this owns only the backdrop, the card's positioning/
 * dialog semantics, and closing (Escape always; backdrop click when opted
 * in). It does not prescribe a header, footer, or icon shape — every site
 * this replaces has its own header/body/footer content, genuinely different
 * from one another, and `className` on the card gives each caller the exact
 * same control over max-width/padding/rounding it already had. Converging
 * the wrapper is the fix; inventing one true header shape is a different,
 * larger decision this component does not make.
 *
 * `role="dialog"`/`aria-modal="true"` and Escape-to-close are new here —
 * none of the 6 hand-rolled versions had either. A real, positive behavior
 * change, not a silent one: recorded here rather than left implicit.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** The dialog's accessible name. */
  ariaLabel: string;
  /** Applied to the card, not the backdrop — full control over max-width, padding, rounding, and shadow, matching what each site already had. */
  className?: string;
  /** Inline style on the card — several sites set `boxShadow: 'var(--ui-shadow-lg)'` this way rather than as a Tailwind arbitrary value, since that token holds a multi-layer shadow a single bracket value can't express. */
  style?: CSSProperties;
  /**
   * Closes when the backdrop itself (not the card) is clicked. Off by
   * default: of the 6 sites this replaces, only one already had this
   * behavior — turning it on everywhere would be a real interaction change
   * for the other five, not just a markup convergence. Opt in per site to
   * match what that site already did.
   */
  closeOnBackdropClick?: boolean;
  /** `backdrop-blur-sm` on the scrim. Real variance existed here too (3 of the 5 sites had it, 2 didn't) — default matches the more common choice, but pass explicitly per site rather than relying on it. */
  blur?: boolean;
}

export function Modal({
  onClose,
  children,
  ariaLabel,
  className,
  style,
  closeOnBackdropClick = false,
  blur = true,
}: ModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className={cn('fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--backdrop)]', blur && 'backdrop-blur-sm')}
      onClick={closeOnBackdropClick ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={cn('surface-card', className)}
        style={style}
        onClick={closeOnBackdropClick ? event => event.stopPropagation() : undefined}
      >
        {children}
      </div>
    </div>
  );
}
