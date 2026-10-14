/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The printable sheet: one card per event and one per relay, each on its own
 * page. It only renders what `buildPrintCards` read from the workspace. The
 * sheet is hidden on screen and shown by the `@media print` rules of
 * `ui-print-root` in `packages/ui/src/index.css`.
 */

import React from 'react';
import { Badge } from '@omniswim/ui';
import { RELAY_LEG_TIME_TRIAL_LABEL } from './RelayEligibleSwimmersPanel';
import type { PrintCardSet, PrintEventCard, PrintRelayCard } from './printCardsView';

/** The word a relay card prints where its time is an estimate. */
export const PRINT_ESTIMATE_LABEL = 'Estimate';

type CardMeta = {
  meetLabel: string;
  projectedPoints: number | null;
};

function CardHeader({
  meetLabel,
  title,
  team,
  round,
  projectedPoints,
  badge,
}: CardMeta & { title: string; team: string; round: string; badge?: React.ReactNode }) {
  return (
    <header className="mb-4 border-b border-black pb-2">
      <p className="text-ui-caption">{meetLabel}</p>
      <h2 className="text-heading-2 font-bold">
        {title}
        {badge ? <span className="ml-3 align-middle">{badge}</span> : null}
      </h2>
      <p className="text-ui-body">
        <span>Team: {team}</span>
        <span className="ml-4">Round: {round}</span>
        <span className="ml-4">
          Projected points: {projectedPoints === null ? '—' : projectedPoints.toFixed(1)}
        </span>
      </p>
    </header>
  );
}

function EventCard({ card, meta }: { card: PrintEventCard; meta: CardMeta }) {
  return (
    <section className="ui-print-page" data-print-card="event" aria-label={`${card.event}, ${card.round}`}>
      <CardHeader {...meta} title={card.event} team={card.team} round={card.round} />
      <table className="w-full border-collapse text-ui-body">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="py-1 pr-3 font-bold">Swimmer</th>
            <th className="py-1 pr-3 font-bold">Class</th>
            <th className="py-1 pr-3 font-bold">Seed time</th>
            <th className="py-1 pr-3 font-bold">Course</th>
            <th className="py-1 font-bold">Place</th>
          </tr>
        </thead>
        <tbody>
          {card.rows.map(row => (
            <tr key={row.key} className="border-b border-black/40">
              <td className="py-1 pr-3">{row.name}</td>
              <td className="py-1 pr-3">{row.classYear}</td>
              <td className="py-1 pr-3 font-mono tabular-nums">{row.seed}</td>
              <td className="py-1 pr-3">{row.course}</td>
              <td className="py-1 tabular-nums">{row.place}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RelayCard({ card, meta }: { card: PrintRelayCard; meta: CardMeta }) {
  return (
    <section className="ui-print-page" data-print-card="relay" aria-label={`${card.event}, ${card.round}`}>
      <CardHeader
        {...meta}
        title={card.event}
        team={card.team}
        round={card.round}
        badge={card.estimate ? <Badge tone="neutral" className="ui-print-badge">{PRINT_ESTIMATE_LABEL}</Badge> : null}
      />
      <p className="mb-3 text-ui-body">
        Relay time: <span className="font-mono tabular-nums">{card.teamTime}</span>
      </p>
      <table className="w-full border-collapse text-ui-body">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="py-1 pr-3 font-bold">Leg</th>
            <th className="py-1 pr-3 font-bold">Swimmer</th>
            <th className="py-1 font-bold">Leg time</th>
          </tr>
        </thead>
        <tbody>
          {card.legs.map(leg => (
            <tr key={leg.key} className="border-b border-black/40">
              <td className="py-1 pr-3 tabular-nums">{leg.leg}</td>
              <td className="py-1 pr-3">
                {leg.name}
                {leg.timeTrial ? (
                  <Badge tone="neutral" className="ui-print-badge ml-2 normal-case">
                    {RELAY_LEG_TIME_TRIAL_LABEL}
                  </Badge>
                ) : null}
              </td>
              <td className="py-1 font-mono tabular-nums">{leg.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type Props = {
  cards: PrintCardSet;
  meetLabel: string;
};

/** The sheet itself. Mount it as a direct child of `<body>` (see `PrintCardsButton`). */
export default function PrintCards({ cards, meetLabel }: Props) {
  const meta: CardMeta = { meetLabel, projectedPoints: cards.projectedPoints };
  return (
    <div className="ui-print-root" data-print-root>
      {cards.events.map(card => (
        <EventCard key={`event|${card.key}`} card={card} meta={meta} />
      ))}
      {cards.relays.map(card => (
        <RelayCard key={`relay|${card.key}`} card={card} meta={meta} />
      ))}
    </div>
  );
}
