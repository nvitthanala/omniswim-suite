/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The meet-day deck: one event or relay per screen, in large type, read-only,
 * for a phone on deck. It renders the same `PrintCardSet` the printable cards
 * render (`buildPrintCards`), in the same order (events, then relays), so the
 * deck and the paper cannot disagree. Nothing here is scored or estimated; a
 * time that is not stored shows as `NT`.
 *
 * Motion: a short slide-in when the card changes by a button press. A key press
 * does not animate (people repeat it). `prefers-reduced-motion` turns the slide
 * off. The `data-deck-motion` attribute on the card says which one applied.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Badge, Button, Modal } from '@omniswim/ui';
import { RELAY_LEG_TIME_TRIAL_LABEL } from './RelayEligibleSwimmersPanel';
import { PRINT_ESTIMATE_LABEL } from './PrintCards';
import type { PrintCard, PrintCardSet, PrintEventCard, PrintRelayCard } from './printCardsView';

/** Every card in deck order: entries per event, then relays. Same order as the print sheet. */
export function deckCards(set: PrintCardSet): PrintCard[] {
  return [...set.events, ...set.relays];
}

/** The position line, for example `3 of 17`. */
export function deckPositionLabel(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** True while the person asks for reduced motion. Follows a change of the setting. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

type Move = { dir: 1 | -1; animate: boolean } | null;

type Meta = { projectedPoints: number | null };

function CardTitle({
  card,
  meta,
  badge,
}: {
  card: PrintCard;
  meta: Meta;
  badge?: React.ReactNode;
}) {
  return (
    <header className="mb-5 border-b border-theme-soft pb-4">
      <h2 className="text-3xl font-bold leading-tight text-[var(--text-primary)] break-words">
        {card.event}
        {badge ? <span className="ml-3 align-middle">{badge}</span> : null}
      </h2>
      <p className="mt-2 text-lg text-[var(--text-secondary)]">
        <span>Round: {card.round}</span>
        <span className="ml-4">
          Projected points: {meta.projectedPoints === null ? '—' : meta.projectedPoints.toFixed(1)}
        </span>
      </p>
    </header>
  );
}

function EventBody({ card, meta }: { card: PrintEventCard; meta: Meta }) {
  return (
    <>
      <CardTitle card={card} meta={meta} />
      <ol className="m-0 list-none p-0">
        {card.rows.map(row => (
          <li
            key={row.key}
            data-deck-row
            className="flex items-baseline justify-between gap-4 border-b border-theme-soft py-3"
          >
            <div className="min-w-0">
              <p className="text-2xl font-semibold text-[var(--text-primary)] break-words">{row.name}</p>
              <p className="text-base text-[var(--text-secondary)]">
                {row.classYear} · {row.course} · Place {row.place}
              </p>
            </div>
            <p className="shrink-0 font-mono text-3xl font-bold tabular-nums text-[var(--text-primary)]">
              {row.seed}
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

function RelayBody({ card, meta }: { card: PrintRelayCard; meta: Meta }) {
  return (
    <>
      <CardTitle
        card={card}
        meta={meta}
        badge={card.estimate ? <Badge tone="neutral">{PRINT_ESTIMATE_LABEL}</Badge> : null}
      />
      <p className="mb-3 text-xl text-[var(--text-secondary)]">
        Relay time:{' '}
        <span className="font-mono text-3xl font-bold tabular-nums text-[var(--text-primary)]">
          {card.teamTime}
        </span>
      </p>
      <ol className="m-0 list-none p-0">
        {card.legs.map(leg => (
          <li
            key={leg.key}
            data-deck-row
            className="flex items-baseline justify-between gap-4 border-b border-theme-soft py-3"
          >
            <div className="flex min-w-0 items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums text-[var(--text-secondary)]">{leg.leg}</span>
              <p className="min-w-0 text-2xl font-semibold text-[var(--text-primary)] break-words">
                {leg.name}
                {leg.timeTrial ? (
                  <Badge tone="neutral" className="ml-2 normal-case">
                    {RELAY_LEG_TIME_TRIAL_LABEL}
                  </Badge>
                ) : null}
              </p>
            </div>
            <p className="shrink-0 font-mono text-3xl font-bold tabular-nums text-[var(--text-primary)]">
              {leg.time}
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

type Props = {
  cards: PrintCardSet;
  meetLabel: string;
  onClose: () => void;
};

export default function MeetDayDeck({ cards, meetLabel, onClose }: Props) {
  const list = useMemo(() => deckCards(cards), [cards]);
  const total = list.length;
  const [index, setIndex] = useState(0);
  const [move, setMove] = useState<Move>(null);
  const reducedMotion = usePrefersReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // The set can shrink while the deck is open (a lineup edit elsewhere). Stay inside it.
  const at = total === 0 ? 0 : Math.min(index, total - 1);
  const card = list[at];

  const go = useCallback(
    (delta: 1 | -1, viaKey: boolean) => {
      if (total === 0) return;
      const next = Math.min(Math.max(at + delta, 0), total - 1);
      if (next === at) return;
      setMove({ dir: delta, animate: !viaKey });
      setIndex(next);
    },
    [at, total]
  );

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [at]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1, true);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1, true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [go]);

  const slide = !reducedMotion && move?.animate === true;
  // `starting:` is the @starting-style variant: the keyed card enters from the offset and settles.
  const motionClass = slide
    ? move?.dir === 1
      ? 'transition-[opacity,translate] duration-150 ease-out starting:translate-x-6 starting:opacity-0'
      : 'transition-[opacity,translate] duration-150 ease-out starting:-translate-x-6 starting:opacity-0'
    : '';

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Meet-day view"
      blur={false}
      className="flex h-full w-full max-w-none flex-col overflow-hidden rounded-xl bg-[var(--bg)] text-[var(--text-primary)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-theme-soft px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-bold text-[var(--text-primary)]">{cards.team}</p>
          <p className="truncate text-base text-[var(--text-secondary)]">{meetLabel}</p>
        </div>
        <Button
          variant="outline"
          size="lg"
          onClick={onClose}
          leadingIcon={<X size={18} aria-hidden="true" />}
          className="shrink-0 whitespace-nowrap"
        >
          Close
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {card ? (
          <section
            key={`${card.kind}|${card.key}`}
            data-deck-card={card.kind}
            data-deck-motion={slide ? 'slide' : 'none'}
            aria-label={`${card.event}, ${card.round}`}
            className={motionClass}
          >
            {card.kind === 'event' ? (
              <EventBody card={card} meta={cards} />
            ) : (
              <RelayBody card={card} meta={cards} />
            )}
          </section>
        ) : (
          <p className="text-xl text-[var(--text-secondary)]">
            This team has no entries or relays to show.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-theme-soft px-4 py-3">
        <Button
          variant="outline"
          size="lg"
          onClick={() => go(-1, false)}
          disabled={at <= 0}
          leadingIcon={<ChevronLeft size={20} aria-hidden="true" />}
          className="min-h-14 flex-1 text-lg"
        >
          Previous
        </Button>
        <p
          data-deck-position
          aria-live="polite"
          className="shrink-0 text-center text-lg font-bold tabular-nums text-[var(--text-primary)]"
        >
          {total === 0 ? '0 of 0' : deckPositionLabel(at, total)}
        </p>
        <Button
          variant="primary"
          size="lg"
          onClick={() => go(1, false)}
          disabled={total === 0 || at >= total - 1}
          trailingIcon={<ChevronRight size={20} aria-hidden="true" />}
          className="min-h-14 flex-1 text-lg"
        >
          Next
        </Button>
      </div>
    </Modal>
  );
}
