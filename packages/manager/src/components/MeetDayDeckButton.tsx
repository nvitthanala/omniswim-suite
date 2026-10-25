/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Meet-day view": opens the deck for the selected team. It builds the deck
 * from `buildPrintCards`, the same data the "Print cards" button prints.
 */

import React, { useMemo, useState } from 'react';
import type { Gender, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { Button } from '@omniswim/ui';
import MeetDayDeck from './MeetDayDeck';
import { buildPrintCards, printCardCount } from './printCardsView';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  /** The team chosen in the Manager team bar. */
  team: string;
};

export default function MeetDayDeckButton({ workspace, gender, scoringBundle, team }: Props) {
  const [open, setOpen] = useState(false);
  const cards = useMemo(
    () => buildPrintCards({ workspace, scoringBundle, gender, team }),
    [workspace, scoringBundle, gender, team]
  );
  const count = printCardCount(cards);
  const disabled = team === '' || count === 0;
  const meetLabel = workspace.loadedMeet?.meetLabel || workspace.name || 'Meet';

  return (
    <>
      <Button
        variant="outline"
        size="md"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={
          team === ''
            ? 'Pick a team to open its meet-day view'
            : count === 0
              ? 'This team has no entries or relays to show'
              : `Open ${count} ${count === 1 ? 'event' : 'events'} in large type, one per screen`
        }
        className="whitespace-nowrap"
      >
        Meet-day view
      </Button>
      {open ? <MeetDayDeck cards={cards} meetLabel={meetLabel} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
