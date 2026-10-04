/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The notice at the top of Matrix and Manager when the workspace is a theoretical meet
 * (`isTheoreticalMeet`). It renders nothing for any other workspace.
 *
 * It uses the warning token classes (`text-warning`, `bg-warning-faint`, `border-warning-faint`), so it
 * reads as "not a real meet" in Dark, Light and custom themes without a fixed colour.
 *
 * The stored workspace does not keep the build report, so the caveats here are the ones that always
 * hold for a theoretical meet. The build dialog shows the full report before the meet is created.
 */

import { useId, useState } from 'react';
import { ChevronDown, FlaskConical } from 'lucide-react';
import type { LoadedMeetMeta } from '@omniswim/core/types';
import { ALL_TIME_BEST_CAVEAT, DIVING_EXCLUDED_CAVEAT, RELAYS_EXCLUDED_CAVEAT } from '../../lib/theoreticalMeetSeeds';
import { THEORETICAL_PLACES_CAVEAT, isTheoreticalMeet } from '../../lib/theoreticalMeetWorkspace';

/** The event order is fixed when the meet is built, and the workspace does not record which order was used. */
const EVENT_ORDER_BANNER_CAVEAT =
  'Event order was fixed when the meet was built. Under a meet-wide scorer cap the order decides which swimmers fill the cap, so totals can move by several percent with event order.';

/** The workspace keeps no build report, so it cannot say how many seeds were exhibition swims or whether they were dropped. */
const EXHIBITION_BANNER_CAVEAT =
  'Exhibition swims did not score at their meet. The build may have included or dropped them, and the workspace does not record which. The build preview showed the count.';

export const THEORETICAL_BANNER_CAVEATS: readonly string[] = [
  ALL_TIME_BEST_CAVEAT,
  RELAYS_EXCLUDED_CAVEAT,
  EVENT_ORDER_BANNER_CAVEAT,
  DIVING_EXCLUDED_CAVEAT,
  EXHIBITION_BANNER_CAVEAT,
  THEORETICAL_PLACES_CAVEAT,
];

export function TheoreticalMeetBanner({ workspace }: { workspace: { readonly loadedMeet?: Pick<LoadedMeetMeta, 'meetLabel'> | null } | null | undefined }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!isTheoreticalMeet(workspace)) return null;
  return (
    <section aria-label="Theoretical meet notice" className="mb-4 rounded-xl border border-warning-faint bg-warning-faint text-ui-caption">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical size={16} className="shrink-0 text-warning" aria-hidden="true" />
          <p className="min-w-0">
            <span className="font-medium text-warning">Theoretical meet: seeded from crawled teams.</span>{' '}
            <span className="text-[var(--text-primary)]">Nobody swam this meet. Relays are not included.</span>
          </p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(value => !value)}
          className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-warning theme-hover-row"
        >
          What this means
          <ChevronDown size={14} className={`transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>
      <div id={panelId} hidden={!open} className="border-t border-warning-faint px-4 py-3">
        <ul className="list-disc space-y-1 pl-5 text-[var(--text-primary)]">
          {THEORETICAL_BANNER_CAVEATS.map(caveat => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
