/** Captured source facts needed to render a stored report without the live model. */
import { buildIndex, resolveLineup, scyValue } from '../model/results';
import type { Lineup } from '../model/lineup';
import type { MeetModel, MeetSwim } from '../model/meet';
import type { Hundredths, SwimmerId } from '../model/primitives';
import type { SourcingSettings } from '../sourcing/flyover';

export type ClassYearCode = MeetModel['swimmers'][number]['classYear'];

export type SeedFact =
  | { readonly kind: 'time'; readonly hundredths: Hundredths; readonly estimated: boolean }
  | { readonly kind: 'score'; readonly hundredths: Hundredths }
  | { readonly kind: 'none'; readonly reason: 'no_time' | 'not_convertible' };

export interface ReportFacts {
  readonly payloadVersion: 1;
  readonly seeds: Readonly<Record<string, SeedFact>>;
  readonly classYears: Readonly<Record<SwimmerId, ClassYearCode>>;
}

function chosenIndividualSwim(model: MeetModel, swimmerId: SwimmerId, eventKey: string, value: number, pinnedId: string | null): MeetSwim | undefined {
  if (pinnedId !== null) return model.swims.find(swim => swim.swimId === pinnedId);
  return model.swims
    .filter(swim => swim.swimmerId === swimmerId && swim.eventKey === eventKey && scyValue(swim) === value)
    .sort((a, b) => Number(b.scy.kind === 'recorded-scy') - Number(a.scy.kind === 'recorded-scy'))[0];
}

function noTimeReason(model: MeetModel, swimmerId: SwimmerId, eventKey: string, pinnedId: string | null): 'no_time' | 'not_convertible' {
  const swims = model.swims.filter(swim =>
    swim.swimmerId === swimmerId && swim.eventKey === eventKey && (pinnedId === null || swim.swimId === pinnedId));
  return swims.length > 0 && swims.every(swim => swim.scy.kind === 'not-convertible') ? 'not_convertible' : 'no_time';
}

/**
 * Resolve each lineup seed once, then preserve its selected value and provenance for snapshots. `sourcing` is the settings the
 * lineup is scored under (the dashboard passes `SIMULATOR_SOURCING`): a flyover leg and a converted split have a value only under them.
 * A relay is `estimated` when any leg is valued by an estimate: a flyover leg, a converted split or a converted flat swim.
 */
export function captureReportFacts(model: MeetModel, lineup: Lineup, sourcing: SourcingSettings): ReportFacts {
  const resolved = resolveLineup(model, lineup, buildIndex(model, sourcing)).resolved;
  const seeds: Record<string, SeedFact> = {};
  for (const item of resolved) {
    if (item.value === null) {
      const pinnedId = item.entry.kind === 'individual' ? item.entry.seedSwimId : null;
      seeds[item.key] = {
        kind: 'none',
        reason: item.entry.kind === 'individual'
          ? noTimeReason(model, item.entry.swimmerId, item.entry.eventKey, pinnedId)
          : 'no_time',
      };
      continue;
    }

    if (item.event.kind === 'diving') {
      seeds[item.key] = { kind: 'score', hundredths: item.value };
      continue;
    }

    const selected = item.entry.kind === 'individual'
      ? chosenIndividualSwim(model, item.entry.swimmerId, item.entry.eventKey, item.value, item.entry.seedSwimId)
      : undefined;
    const estimated = item.entry.kind === 'relay'
      ? item.legEstimates !== undefined
      : selected?.scy.kind === 'converted';
    seeds[item.key] = { kind: 'time', hundredths: item.value, estimated };
  }

  const classYears: Record<SwimmerId, ClassYearCode> = {};
  for (const swimmer of model.swimmers) classYears[swimmer.swimmerId] = swimmer.classYear;
  return { payloadVersion: 1, seeds, classYears };
}
