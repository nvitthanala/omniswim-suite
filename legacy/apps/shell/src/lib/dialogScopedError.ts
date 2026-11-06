/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Keep a failure that the "Build theoretical meet" dialog already showed out of the shell banner.
 *
 * The dialog's create step goes through the provider's `restoreWorkspace`. When that call fails, the
 * provider sets its `error` (shown in the banner at the top of the shell) and the dialog shows its own
 * problem text. If the user then cancels the dialog, the banner would still read "Failed to restore
 * workspace" on a screen where nothing is being created. The provider offers no way to clear that
 * error, so the shell hides it instead:
 *
 * - while the dialog is open, the banner is hidden (the dialog reports the failure);
 * - when the dialog closes, the error that is current at that moment stays hidden;
 * - a different error, or the same error after the provider cleared it, shows again.
 *
 * An unrelated failure that happens to carry the same text as the hidden one stays hidden until the
 * provider reports success once (its error goes back to null). A toast has already announced it.
 */

import { useEffect, useRef, useState } from 'react';

/** The error the shell banner should show. Pure. */
export function visibleShellError(error: string | null, dismissed: string | null, dialogOpen: boolean): string | null {
  if (error === null || dialogOpen || error === dismissed) return null;
  return error;
}

/** The banner text for `error`, given whether the dialog is open. See the file comment. */
export function useDialogScopedError(error: string | null, dialogOpen: boolean): string | null {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !dialogOpen) setDismissed(error);
    wasOpen.current = dialogOpen;
  }, [dialogOpen, error]);
  useEffect(() => {
    if (error === null) setDismissed(null);
  }, [error]);
  return visibleShellError(error, dismissed, dialogOpen);
}
