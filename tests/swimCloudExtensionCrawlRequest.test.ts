/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the extension's pure crawl-loop helpers
 * (`extensions/swimcloud-companion/src/crawlRequest.ts`). No `chrome.*`, no
 * DOM, no network — see that file's header and
 * `plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md` for what these tests do
 * NOT cover.
 */

import { describe, expect, it } from 'vitest';
import { planMeetTeamSwims } from '@omniswim/swimcloud/crawlPlan';
import {
  crawlStepToFetchRequest,
  stepsStillNeeded,
  unionTeamIds,
} from '../extensions/swimcloud-companion/src/crawlRequest';

describe('crawlStepToFetchRequest', () => {
  it('carries the step canonical URL and resource kind straight through', () => {
    const [step] = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'] });
    expect(crawlStepToFetchRequest(step)).toEqual({
      url: step.canonicalUrl,
      resourceKind: step.resourceKind,
    });
  });
});

describe('stepsStillNeeded', () => {
  it('drops steps whose canonical URL is already fetched, keeping order', () => {
    const steps = planMeetTeamSwims({
      meetId: '356467',
      teamIds: ['58', '59'],
      knownTotalPages: { '58:M': 2, '58:F': 1, '59:M': 1, '59:F': 1 },
    });
    const fetched = new Set([steps[0].canonicalUrl]);
    const remaining = stepsStillNeeded(steps, fetched);
    expect(remaining.length).toBe(steps.length - 1);
    expect(remaining.map((s) => s.canonicalUrl)).not.toContain(steps[0].canonicalUrl);
    // Order preserved for the rest.
    expect(remaining.map((s) => s.canonicalUrl)).toEqual(
      steps.slice(1).map((s) => s.canonicalUrl),
    );
  });

  it('returns every step when nothing has been fetched yet', () => {
    const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'] });
    expect(stepsStillNeeded(steps, new Set())).toEqual(steps);
  });
});

describe('unionTeamIds', () => {
  it('dedupes while preserving first-seen order', () => {
    expect(unionTeamIds(['58', '59'], ['59', '60'])).toEqual(['58', '59', '60']);
  });

  it('handles a wholly disjoint pair', () => {
    expect(unionTeamIds(['1'], ['2'])).toEqual(['1', '2']);
  });

  it('handles an empty side', () => {
    expect(unionTeamIds([], ['1', '2'])).toEqual(['1', '2']);
    expect(unionTeamIds(['1', '2'], [])).toEqual(['1', '2']);
  });
});
