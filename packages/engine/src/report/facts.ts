/** Captured source facts needed to render a stored report without the live model. */
import { buildIndex, resolveLineup, scyValue } from '../model/results';
import type { Lineup } from '../model/lineup';
import type { MeetModel, MeetSwim } from '../model/meet';
import type { Hundredths, SwimmerId } from '../model/primitives';

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

function relaySwims(model: MeetModel, lineupEntry: Extract<Lineup['entries'][number], { kind: 'relay' }>): MeetSwim[] {
  return lineupEntry.legs.flatMap(leg => {
    if (leg.basis.kind !== 'flat-start-swim') return [];
    const swimId = leg.basis.swimId;
    const swim = model.swims.find(candidate => candidate.swimId === swimId);
    return swim === undefined ? [] : [swim];
  });
}

/** Resolve each lineup seed once, then preserve its selected value and provenance for snapshots. */
export function captureReportFacts(model: MeetModel, lineup: Lineup): ReportFacts {
  const resolved = resolveLineup(model, lineup, buildIndex(model)).resolved;
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
    const relatedSwims = item.entry.kind === 'relay' ? relaySwims(model, item.entry) : selected ? [selected] : [];
    seeds[item.key] = {
      kind: 'time',
      hundredths: item.value,
      estimated: relatedSwims.some(swim => swim.scy.kind === 'converted'),
    };
  }

  const classYears: Record<SwimmerId, ClassYearCode> = {};
  for (const swimmer of model.swimmers) classYears[swimmer.swimmerId] = swimmer.classYear;
  return { payloadVersion: 1, seeds, classYears };
}
