/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The drawer's "Remove" action. It is a real <button>, so Tab reaches it and
 * Enter and Space activate it through the browser's own key handling. (A
 * second onKeyDown would fire the action twice.) The hint says what Remove
 * does, for the tooltip and for screen readers.
 */
import { useId } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@omniswim/ui';

export const ATHLETE_REMOVE_HINT =
  'Removes this athlete from the roster. Meet results stay on record. Press Enter or Space to remove.';

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
