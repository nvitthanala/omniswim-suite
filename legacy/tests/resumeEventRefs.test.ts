/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A re-crawl must still be able to plan the per-event pages.
 *
 * ## The bug
 *
 * The crawl's event-results pass plans from the swims pages it parsed **during
 * that run**. Resume skips a swims page whose bytes are already stored. So a
 * re-crawl of a complete capture parsed nothing, gathered no event references,
 * planned zero `meetEvent` pages — and reported success, because it genuinely
 * had nothing new to fetch.
 *
 * The consequence is the one the user actually hit: prelims and finals stay
 * unresolved forever. Rounds are read from `/results/{meetId}/event/{n}/`
 * pages, and re-crawling could never fetch one. The round-resolution code was
 * never at fault; it was starved.
 *
 * Only the app can see the stored bytes, so it derives the references and sends
 * them back with the resume reply. These cases pin both halves: the decision
 * carries them, and an older app that omits the field degrades to the previous
 * behaviour rather than breaking.
 */

import { describe, expect, it } from 'vitest';
import { decideResumeFromRoundTrip } from '../extensions/swimcloud-companion/src/captureResume';

/** A capture reply shaped like the app's, with whatever extras a case needs. */
function reply(extra: Record<string, unknown> = {}) {
  return {
    kind: 'ok' as const,
    response: {
      captureId: 'meet-356467',
      available: true,
      found: true,
      capture: {
        captureId: 'meet-356467',
        subject: { kind: 'meet', meetId: '356467' },
        track: 'browser-extension',
        completeness: 'every-planned-page-fetched',
        pages: [
          {
            canonicalUrl: 'https://www.swimcloud.com/results/356467/team/58/swims/?gender=M',
            resourceKind: 'meetTeamSwims',
            outcome: 'ok',
            retrievedAt: '2026-09-10T04:33:54.662Z',
          },
        ],
        ...extra,
      },
    },
  };
}

describe('resume carries the event refs the app derived', () => {
  it('reads knownEventRefs from the reply', () => {
    const decision = decideResumeFromRoundTrip(reply({ knownEventRefs: ['26', '11', '100'] }) as never);
    expect(decision.found).toBe(true);
    // The load-bearing assertion. Empty here means a re-crawl plans no event
    // pages and prelims/finals stay unresolved, exactly as before the fix.
    expect([...decision.storedEventRefs]).toStrictEqual(['26', '11', '100']);
  });

  it('still skips the swims page whose bytes are stored', () => {
    // The refs must not come at the cost of re-fetching. Resume keeps working.
    const decision = decideResumeFromRoundTrip(reply({ knownEventRefs: ['26'] }) as never);
    expect(
      decision.alreadyCaptured.has('https://www.swimcloud.com/results/356467/team/58/swims/?gender=M'),
    ).toBe(true);
  });

  it('degrades to empty when an older app omits the field', () => {
    // An app build that predates this sends no knownEventRefs. That must fall
    // back to the run's own references, not throw and not invent any.
    const decision = decideResumeFromRoundTrip(reply() as never);
    expect(decision.found).toBe(true);
    expect([...decision.storedEventRefs]).toStrictEqual([]);
  });

  it('drops malformed entries rather than planning a bad URL', () => {
    const decision = decideResumeFromRoundTrip(
      reply({ knownEventRefs: ['26', '', null, 42, { n: 1 }, '11'] }) as never,
    );
    expect([...decision.storedEventRefs]).toStrictEqual(['26', '11']);
  });

  it('is empty on every degraded path, never undefined', () => {
    // Callers spread this straight into the event pass; an undefined here would
    // throw mid-crawl rather than degrade.
    for (const trip of [{ kind: 'timeout' as const }, { kind: 'error' as const, message: 'x' }]) {
      const decision = decideResumeFromRoundTrip(trip as never);
      expect(Array.isArray(decision.storedEventRefs)).toBe(true);
      expect(decision.storedEventRefs).toStrictEqual([]);
    }
  });
});
