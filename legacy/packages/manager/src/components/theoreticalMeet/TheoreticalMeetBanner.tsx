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
 * hold for a theoretical meet. The one part it does keep is the list of events removed in the build
 * preview (`theoreticalRemovedEvents`). The banner lists those. A meet built before the list was kept
 * shows the "may have been removed" line instead. The build dialog shows the full report before the
 * meet is created.
 */

import { useId, useState } from 'react';
import { ChevronDown, FlaskConical } from 'lucide-react';
import type { LoadedMeetMeta, SwimmerResult, TheoreticalRemovedEvent } from '@omniswim/core/types';
import { ALL_TIME_BEST_CAVEAT, DIVING_EXCLUDED_CAVEAT, RELAYS_ESTIMATED_CAVEAT, RELAYS_EXCLUDED_CAVEAT } from '../../lib/theoreticalMeetSeeds';
import {
  THEORETICAL_PLACES_CAVEAT,
  isEstimatedRelayRow,
  isTheoreticalMeet,
  theoreticalRemovedEvents,
} from '../../lib/theoreticalMeetWorkspace';

/** The event order is fixed when the meet is built, and the workspace does not record which order was used. */
const EVENT_ORDER_BANNER_CAVEAT =
  'Event order was fixed when the meet was built. Under a meet-wide scorer cap the order decides which swimmers fill the cap, so totals can move by several percent with event order.';

/** The workspace keeps no build report, so it cannot say how many seeds were exhibition swims or whether they were dropped. */
const EXHIBITION_BANNER_CAVEAT =
  'Exhibition swims did not score at their meet. The build may have included or dropped them, and the workspace does not record which. The build preview showed the count.';

/**
 * The preview lets the user remove events from lineups. A meet built before the list was kept cannot say
 * which. This line stays for that case. A meet that holds the list replaces it (`bannerCaveatsFor`).
 */
const REMOVED_EVENTS_BANNER_CAVEAT =
  'Events may have been removed from some lineups in the build preview, and the workspace does not record which. The build preview showed the count.';

/** The meet records the list and it is empty: the build removed nothing. */
export const NO_REMOVED_EVENTS_BANNER_LINE = 'No events were removed from lineups in the build preview.';

/** The meet records a list with entries. The entries follow this line, one per removed event. */
export function removedEventsBannerLine(count: number): string {
  return count === 1
    ? '1 event was removed from a lineup in the build preview:'
    : `${count} events were removed from lineups in the build preview:`;
}

/** One removed event as the banner lists it: swimmer, event, time, then team and gender. */
export function removedEventLabel(removed: TheoreticalRemovedEvent): string {
  const time = removed.time ? `, ${removed.time}` : '';
  return `${removed.swimmerName}: ${removed.event}${time} (${removed.teamName}, ${removed.gender})`;
}

export const THEORETICAL_BANNER_CAVEATS: readonly string[] = [
  ALL_TIME_BEST_CAVEAT,
  RELAYS_EXCLUDED_CAVEAT,
  EVENT_ORDER_BANNER_CAVEAT,
  DIVING_EXCLUDED_CAVEAT,
  EXHIBITION_BANNER_CAVEAT,
  REMOVED_EVENTS_BANNER_CAVEAT,
  THEORETICAL_PLACES_CAVEAT,
];

type BannerWorkspace = {
  readonly loadedMeet?: Pick<LoadedMeetMeta, 'meetLabel' | 'theoreticalRemovedEvents'> | null;
  readonly menResults?: readonly Pick<SwimmerResult, 'isRelay' | 'event'>[] | null;
  readonly womenResults?: readonly Pick<SwimmerResult, 'isRelay' | 'event'>[] | null;
};

/** The meet holds relay rows. In a theoretical meet each is an estimate (`isEstimatedRelayRow`). */
export function theoreticalMeetHasRelays(workspace: BannerWorkspace | null | undefined): boolean {
  if (!isTheoreticalMeet(workspace)) return false;
  const rows = [...(workspace?.menResults ?? []), ...(workspace?.womenResults ?? [])];
  return rows.some(row => isEstimatedRelayRow(workspace, row));
}

/**
 * The caveats the banner lists. With relay rows the relay line says they are estimates.
 *
 * `removed` is what `theoreticalRemovedEvents` read. `undefined` means the meet was built before the list
 * was kept, so the "may have been removed" line stays. `[]` and a non-empty list replace that line with
 * what the build recorded.
 */
export function bannerCaveatsFor(
  hasRelays: boolean,
  removed?: readonly TheoreticalRemovedEvent[],
): readonly string[] {
  if (!hasRelays && removed === undefined) return THEORETICAL_BANNER_CAVEATS;
  return THEORETICAL_BANNER_CAVEATS.map(line => {
    if (hasRelays && line === RELAYS_EXCLUDED_CAVEAT) return RELAYS_ESTIMATED_CAVEAT;
    if (removed !== undefined && line === REMOVED_EVENTS_BANNER_CAVEAT) {
      return removed.length === 0 ? NO_REMOVED_EVENTS_BANNER_LINE : removedEventsBannerLine(removed.length);
    }
    return line;
  });
}

export function TheoreticalMeetBanner({ workspace }: { workspace: BannerWorkspace | null | undefined }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!isTheoreticalMeet(workspace)) return null;
  const hasRelays = theoreticalMeetHasRelays(workspace);
  const removed = theoreticalRemovedEvents(workspace);
  const removedLine = removed && removed.length > 0 ? removedEventsBannerLine(removed.length) : null;
  return (
    <section aria-label="Theoretical meet notice" className="mb-4 rounded-xl border border-warning-faint bg-warning-faint text-ui-caption">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical size={16} className="shrink-0 text-warning" aria-hidden="true" />
          <p className="min-w-0">
            <span className="font-medium text-warning">Theoretical meet: seeded from crawled teams.</span>{' '}
            <span className="text-[var(--text-primary)]">{`Nobody swam this meet. ${hasRelays ? 'Relays are estimates.' : 'Relays are not included.'}`}</span>
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
          {bannerCaveatsFor(hasRelays, removed).map(caveat => (
            <li key={caveat}>
              {caveat}
              {removedLine !== null && caveat === removedLine && removed ? (
                <ul
                  aria-label="Events removed from lineups"
                  className="mt-1 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-theme-secondary custom-scrollbar"
                >
                  {removed.map((item, index) => (
                    <li key={`${index}|${item.teamName}|${item.gender}|${item.swimmerName}|${item.event}`}>
                      {removedEventLabel(item)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
