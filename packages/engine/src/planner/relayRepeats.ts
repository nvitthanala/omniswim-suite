import type { Violation } from '../model/results';
import type { SessionPreset } from './types';

/** Filter the NCAA timed-final-only repeat-relay violation when the schedule proves the event has prelims and finals. */
export function relayRepeatsForSchedule<T extends Violation>(violations: readonly T[], schedule: SessionPreset): T[] {
  const prelimsFinals = new Set<string>();
  for (const event of schedule.events) {
    if (event.format.kind !== 'prelims-finals') continue;
    const genders = event.gender === 'both' ? ['Men', 'Women'] as const : [event.gender];
    for (const gender of genders) prelimsFinals.add(`${event.eventKey}\u0000${gender}`);
  }
  return violations.filter(v => v.kind !== 'relay_swimmer_repeated' || !prelimsFinals.has(`${v.eventKey}\u0000${v.gender}`));
}
