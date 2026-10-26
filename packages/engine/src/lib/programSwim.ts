/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether a meet row is known to be a program swim.
 *
 * The SwimCloud swims list prints a swim with the bare event label ("100
 * Breast"). A post-meet time trial prints the same label, so the page cannot
 * say which it is. The importer stamps such a row `programSwim: 'unconfirmed'`
 * and the user confirms it (`setCreditedSwimProgramStatus`, `swimEditor.ts`).
 *
 * Until then the row is not evidence. It counts toward no best time, no
 * arbitrage field and no cut tag. Team scoring is a separate gate
 * (`isTimeTrial` and the scored-event boundary) and does not read this.
 *
 * A row with no `programSwim` is not unconfirmed. A PDF row and a SwimCloud
 * event-page row state their own program membership and never carry the field.
 */
import type { SwimmerResult } from '../types';

/** True only for a row the swims-list import stamped and no one has confirmed. */
export function isUnconfirmedProgramSwim(row: Pick<SwimmerResult, 'programSwim'>): boolean {
  return row.programSwim === 'unconfirmed';
}
