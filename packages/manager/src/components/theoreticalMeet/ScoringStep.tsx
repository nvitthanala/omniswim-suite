/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Step 2 of the "Build theoretical meet" dialog: scoring rules, course and event order.
 *
 * The scoring rules are never chosen for the user. A capture does not say which conference a team
 * swims in, and the team division table holds no conference, so nothing here can default it.
 */

import { Badge } from '@omniswim/ui';
import { RELAY_LEG_DISTANCES } from '../../lib/theoreticalMeetSeeds';
import { EVENT_ORDER_CAVEAT } from '../../lib/theoreticalMeetWorkspace';
import type { TheoreticalMeetFlow } from './useTheoreticalMeetFlow';

export function ScoringStep({ flow }: { flow: TheoreticalMeetFlow }) {
  const {
    scoringChoices,
    scoringChoiceId,
    setScoringChoiceId,
    eventOrders,
    eventOrderWorkspaceId,
    setEventOrderWorkspaceId,
    includeExhibition,
    setIncludeExhibition,
    includeRelays,
    setIncludeRelays,
    flyingStartOn,
    setFlyingStartOn,
    flyingStartText,
    setFlyingStartSeconds,
    maxRelaysText,
    setMaxRelaysText,
  } = flow;
  const chosen = scoringChoices.find(choice => choice.id === scoringChoiceId) ?? null;
  const groups = [...new Set(scoringChoices.map(choice => choice.group))];
  const useLoadedOrder = eventOrderWorkspaceId !== null;

  return (
    <div className="space-y-6">
      <section aria-labelledby="tmeet-scoring-heading" className="space-y-2">
        <h3 id="tmeet-scoring-heading" className="text-ui-label font-semibold text-[var(--text-primary)]">
          Scoring rules
        </h3>
        <p className="text-ui-caption text-theme-secondary">
          Choose the rules this meet scores by. The captures do not say which conference a team swims in, so no rule is chosen for you.
        </p>
        <label htmlFor="tmeet-scoring-select" className="block text-ui-caption text-theme-secondary">
          Scoring preset
        </label>
        <select
          id="tmeet-scoring-select"
          className="glass-input w-full text-ui-caption"
          value={scoringChoiceId ?? ''}
          onChange={event => setScoringChoiceId(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">Choose scoring rules</option>
          {groups.map(group => (
            <optgroup key={group} label={group}>
              {scoringChoices
                .filter(choice => choice.group === group)
                .map(choice => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <div className="min-h-[3.5rem] space-y-1 text-ui-caption">
          {chosen !== null ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="info">{chosen.citation}</Badge>
                {chosen.conference !== undefined ? <Badge tone="accent">{`Conference ${chosen.conference}`}</Badge> : null}
              </div>
              <p className="text-theme-secondary">{chosen.description}</p>
            </>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="tmeet-course-heading" className="space-y-1">
        <h3 id="tmeet-course-heading" className="text-ui-label font-semibold text-[var(--text-primary)]">
          Course
        </h3>
        <p className="text-ui-caption text-[var(--text-primary)]">Short course yards (SCY)</p>
        <p className="text-ui-caption text-theme-muted">Long course meters (LCM) and short course meters (SCM) are not supported yet.</p>
      </section>

      <section aria-labelledby="tmeet-exhibition-heading" className="space-y-1">
        <h3 id="tmeet-exhibition-heading" className="text-ui-label font-semibold text-[var(--text-primary)]">
          Exhibition swims
        </h3>
        <label htmlFor="tmeet-exhibition" className="flex items-center gap-2 text-ui-caption text-[var(--text-primary)]">
          <input
            id="tmeet-exhibition"
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-[var(--text-accent)]"
            checked={includeExhibition}
            aria-describedby="tmeet-exhibition-help"
            onChange={event => setIncludeExhibition(event.target.checked)}
          />
          Include exhibition swims
        </label>
        <p id="tmeet-exhibition-help" className="text-ui-caption text-theme-muted">
          Exhibition swims did not score at their meet. Turning this off drops those events entirely: the crawl returns only each swimmer&apos;s best time per event, so there is no slower official time to fall back to.
        </p>
      </section>

      <section aria-labelledby="tmeet-relays-heading" className="space-y-2">
        <h3 id="tmeet-relays-heading" className="text-ui-label font-semibold text-[var(--text-primary)]">
          Relays
        </h3>
        <label htmlFor="tmeet-relays" className="flex items-center gap-2 text-ui-caption text-[var(--text-primary)]">
          <input
            id="tmeet-relays"
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-[var(--text-accent)]"
            checked={includeRelays}
            aria-describedby="tmeet-relays-help"
            onChange={event => setIncludeRelays(event.target.checked)}
          />
          Include relays (estimated)
        </label>
        <p id="tmeet-relays-help" className="text-ui-caption text-theme-muted">
          Relay times are built from each swimmer&apos;s individual best times, so they are estimates and not times any team swam.
        </p>
        {includeRelays ? (
          <div className="space-y-2 pl-6">
            <label htmlFor="tmeet-flying-start" className="flex items-center gap-2 text-ui-caption text-[var(--text-primary)]">
              <input
                id="tmeet-flying-start"
                type="checkbox"
                role="switch"
                className="h-4 w-4 accent-[var(--text-accent)]"
                checked={flyingStartOn}
                aria-describedby="tmeet-flying-start-help"
                onChange={event => setFlyingStartOn(event.target.checked)}
              />
              Take a flying-start gain off legs 2 to 4
            </label>
            <p id="tmeet-flying-start-help" className="text-ui-caption text-theme-muted">
              Off: legs 2 to 4 use the flat-start best, unchanged. On: enter the seconds to subtract per leg distance. The app has no published figure, so there is no default. A box left empty means no adjustment for that distance. Leg 1 is never adjusted.
            </p>
            {flyingStartOn ? (
              <div className="flex flex-wrap gap-3">
                {RELAY_LEG_DISTANCES.map(distance => (
                  <label key={distance} htmlFor={`tmeet-flying-start-${distance}`} className="text-ui-caption text-theme-secondary">
                    {`${distance}-yard legs (seconds)`}
                    <input
                      id={`tmeet-flying-start-${distance}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.01}
                      className="glass-input mt-1 block w-32 text-ui-caption"
                      value={flyingStartText[distance]}
                      placeholder="none"
                      onChange={event => setFlyingStartSeconds(distance, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            <label htmlFor="tmeet-max-relays" className="block text-ui-caption text-theme-secondary">
              Relays per swimmer: at most
              <input
                id="tmeet-max-relays"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                className="glass-input mt-1 block w-32 text-ui-caption"
                value={maxRelaysText}
                placeholder="no limit"
                aria-describedby="tmeet-max-relays-help"
                onChange={event => setMaxRelaysText(event.target.value)}
              />
            </label>
            <p id="tmeet-max-relays-help" className="text-ui-caption text-theme-muted">
              Empty: no limit beyond the entry cap. A number: a swimmer already on that many relays is not offered another leg, so more of the entry cap stays for individual events. The cap itself stays total-only.
            </p>
          </div>
        ) : null}
      </section>

      <fieldset className="space-y-2">
        <legend className="text-ui-label font-semibold text-[var(--text-primary)]">Event order</legend>
        <label className="flex items-start gap-2 text-ui-caption text-[var(--text-primary)]">
          <input
            type="radio"
            name="tmeet-event-order"
            className="mt-0.5 accent-[var(--text-accent)]"
            checked={!useLoadedOrder}
            onChange={() => setEventOrderWorkspaceId(null)}
          />
          <span>
            Program order
            <span className="block text-theme-muted">The standard championship order. No event numbers are invented.</span>
          </span>
        </label>
        {eventOrders.length > 0 ? (
          <div>
            <label className="flex items-start gap-2 text-ui-caption text-[var(--text-primary)]">
              <input
                type="radio"
                name="tmeet-event-order"
                className="mt-0.5 accent-[var(--text-accent)]"
                checked={useLoadedOrder}
                onChange={() => setEventOrderWorkspaceId(eventOrders[0].workspaceId)}
              />
              <span>
                Copy from a loaded meet
                <span className="block text-theme-muted">Uses the event order of a meet already loaded in this app.</span>
              </span>
            </label>
            <label htmlFor="tmeet-event-order-source" className="mt-2 block pl-6 text-ui-caption text-theme-secondary">
              Loaded meet
            </label>
            <select
              id="tmeet-event-order-source"
              className="glass-input ml-6 w-[calc(100%-1.5rem)] text-ui-caption"
              disabled={!useLoadedOrder}
              value={eventOrderWorkspaceId ?? eventOrders[0].workspaceId}
              onChange={event => setEventOrderWorkspaceId(event.target.value)}
            >
              {eventOrders.map(choice => (
                <option key={choice.workspaceId} value={choice.workspaceId}>
                  {`${choice.name} (${choice.eventCount} events)`}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-ui-caption text-theme-muted">
            No loaded meet in this app has event numbers to copy, so events run in program order. {EVENT_ORDER_CAVEAT}
          </p>
        )}
      </fieldset>
    </div>
  );
}
