/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The drawer's "Remove" action. It is a real <button>, so Tab reaches it and
 * Enter and Space activate it through the browser's own key handling. (A
 * second onKeyDown would fire the action twice.) The hint says what Remove
 * does, for the tooltip and for screen readers. The button opens a confirmation
 * (SwimmerDeleteConfirmModal: Hide or Remove). It does not remove on its own,
 * so the hint must not say it does.
 */
import { useId } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@omniswim/ui';

export const ATHLETE_REMOVE_HINT =
  'Opens a confirmation. There you choose to hide this athlete from the What-if projection or to remove them from the roster. Meet results stay on record.';

type Props = {
  athleteName: string;
  onRequestRemove: () => void;
};

export default function AthleteRemoveButton({ athleteName, onRequestRemove }: Props) {
  const hintId = useId();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRequestRemove}
        className="text-theme-muted hover:text-rose-400"
        title={ATHLETE_REMOVE_HINT}
        aria-label={`Remove ${athleteName} from roster`}
        aria-describedby={hintId}
        leadingIcon={<Trash2 size={14} />}
      >
        Remove
      </Button>
      <span id={hintId} className="sr-only">
        {ATHLETE_REMOVE_HINT}
      </span>
    </>
  );
}
