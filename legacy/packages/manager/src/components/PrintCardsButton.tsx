/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Print cards": prints one card per event and one per relay for the selected
 * team. It reads the plan the export reads, runs the export's review gate
 * (`validateEntriesForExport`) before it prints, and calls `window.print()`
 * with a sheet that only shows in print (`ui-print-root`).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import type { Gender, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import {
  selectActiveEntries,
  validateEntriesForExport,
  type EntryExportIssue,
} from '@omniswim/core/lib/entryExport';
import { Button } from '@omniswim/ui';
import ExportReviewModal from './ExportReviewModal';
import PrintCards from './PrintCards';
import { buildPrintCards, printCardCount, type PrintCardSet } from './printCardsView';

type SheetProps = {
  cards: PrintCardSet;
  meetLabel: string;
  onDone: () => void;
};

/** Mounts the sheet under `<body>`, opens the print dialog once, and ends when the dialog closes. */
function PrintSheet({ cards, meetLabel, onDone }: SheetProps) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const started = useRef(false);

  useEffect(() => {
    const finish = () => onDoneRef.current();
    window.addEventListener('afterprint', finish);
    if (!started.current) {
      started.current = true;
      if (typeof window.print === 'function') window.print();
      else finish();
    }
    return () => window.removeEventListener('afterprint', finish);
  }, []);

  return createPortal(<PrintCards cards={cards} meetLabel={meetLabel} />, document.body);
}

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  /** The team chosen in the Manager team bar. */
  team: string;
};

export default function PrintCardsButton({ workspace, gender, scoringBundle, team }: Props) {
  const cards = useMemo(
    () => buildPrintCards({ workspace, scoringBundle, gender, team }),
    [workspace, scoringBundle, gender, team]
  );
  const [printing, setPrinting] = useState(false);
  const [issues, setIssues] = useState<EntryExportIssue[] | null>(null);
  const count = printCardCount(cards);
  const disabled = team === '' || count === 0;

  const requestPrint = () => {
    // The same gate as an export: the whole active plan, not only this team.
    const found = validateEntriesForExport(selectActiveEntries(workspace));
    if (found.length > 0) {
      setIssues(found);
      return;
    }
    setPrinting(true);
  };

  const meetLabel = workspace.loadedMeet?.meetLabel || workspace.name || 'Meet';

  return (
    <>
      <Button
        variant="outline"
        size="md"
        onClick={requestPrint}
        disabled={disabled}
        title={
          team === ''
            ? 'Pick a team to print its cards'
            : count === 0
              ? 'This team has no entries or relays to print'
              : `Print ${count} ${count === 1 ? 'card' : 'cards'}, one per page`
        }
        leadingIcon={<Printer size={14} aria-hidden="true" />}
        className="whitespace-nowrap"
      >
        Print cards
      </Button>
      {issues ? (
        <ExportReviewModal
          issues={issues}
          title="Review before print"
          actionLabel="Print anyway"
          subject="print"
          onCancel={() => setIssues(null)}
          onExportAnyway={() => {
            setIssues(null);
            setPrinting(true);
          }}
        />
      ) : null}
      {printing ? <PrintSheet cards={cards} meetLabel={meetLabel} onDone={() => setPrinting(false)} /> : null}
    </>
  );
}
