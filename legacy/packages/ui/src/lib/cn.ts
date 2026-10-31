import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `text-ui-*` are plain CSS classes in `index.css`, not Tailwind theme keys.
 * Stock tailwind-merge reads an unknown `text-<name>` as a text colour, so
 * `cn('text-ui-micro', 'text-theme-secondary')` would drop one of the two.
 * Registering the four sizes as font sizes keeps both.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['ui-micro', 'ui-caption', 'ui-label', 'ui-body'] }],
    },
  },
});

/**
 * Same convention `packages/metrics/src/lib/utils.ts` already uses. Plain
 * `.filter(Boolean).join(' ')` string-building (this package's previous
 * approach in `Badge`/`Button`) puts a caller's override class *after* the
 * component's own classes in the `className` attribute, but Tailwind
 * resolves conflicting utilities (e.g. `px-2.5` vs. a caller's `px-2`) by
 * their order in the generated stylesheet, not by attribute order — so an
 * override could silently lose. `twMerge` resolves the conflict by utility
 * group instead, so the last one passed to `cn(...)` always wins, the way a
 * caller reading the call site would expect.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
