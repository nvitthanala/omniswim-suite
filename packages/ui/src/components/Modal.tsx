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
 *
 * Focus: on open, move focus to the first focusable descendant (or the
 * dialog itself); trap Tab/Shift+Tab inside; on close restore focus to the
 * element that had focus when the modal opened.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../lib/cn';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
const modalStack: HTMLElement[] = [];

function listFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    el =>
      !el.matches(':disabled') &&
      !el.closest('[hidden]') &&
      !el.closest('[aria-hidden="true"]') &&
      el.getAttribute('tabindex') !== '-1'
  );
}

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (dialog) {
      modalStack.push(dialog);
      modalStack.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      );
      const focusables = listFocusable(dialog);
      const target = focusables[0] ?? dialog;
      target.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const activeDialog = dialogRef.current;
      if (!activeDialog || modalStack[modalStack.length - 1] !== activeDialog) return;

      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = listFocusable(activeDialog);
      if (focusables.length === 0) {
        event.preventDefault();
        activeDialog.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (!activeDialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey) {
        if (active === first || active === activeDialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = dialog ? modalStack.lastIndexOf(dialog) : -1;
      if (index !== -1) modalStack.splice(index, 1);
      const previous = previouslyFocusedRef.current;
      if (previous && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  return (
    <div
      className={cn('fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--backdrop)]', blur && 'backdrop-blur-sm')}
      onClick={closeOnBackdropClick ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn('surface-card', className)}
        style={style}
        onClick={closeOnBackdropClick ? event => event.stopPropagation() : undefined}
      >
        {children}
      </div>
    </div>
  );
}
