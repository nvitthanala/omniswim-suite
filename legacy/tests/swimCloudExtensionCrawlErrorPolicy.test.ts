/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the extension's error-handling policy
 * (`extensions/swimcloud-companion/src/crawlErrorPolicy.ts`), pinning the
 * table in `plans/2026-09-08/03-extension-crawler.md`'s "Error handling"
 * section.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyCrawlPageOutcome,
  SWIMCLOUD_CHALLENGE_MESSAGE,
} from '../extensions/swimcloud-companion/src/crawlErrorPolicy';

describe('classifyCrawlPageOutcome', () => {
  it('stops, not retryable, with the exact challenge message on 403', () => {
    const action = classifyCrawlPageOutcome({ kind: 'http-status', httpStatus: 403 });
    expect(action).toEqual({ action: 'stop', retryable: false, message: SWIMCLOUD_CHALLENGE_MESSAGE });
  });

  it('continues on 404', () => {
    expect(classifyCrawlPageOutcome({ kind: 'http-status', httpStatus: 404 })).toEqual({ action: 'continue' });
  });

  it('stops, retryable, on any 5xx', () => {
    for (const status of [500, 502, 503, 599]) {
      const action = classifyCrawlPageOutcome({ kind: 'http-status', httpStatus: status });
      expect(action.action).toBe('stop');
      if (action.action === 'stop') {
        expect(action.retryable).toBe(true);
      }
    }
  });

  it('stops, not retryable, on a network error', () => {
    const action = classifyCrawlPageOutcome({ kind: 'network-error' });
    expect(action.action).toBe('stop');
    if (action.action === 'stop') {
      expect(action.retryable).toBe(false);
    }
  });

  it('continues on ordinary success and other 4xx statuses', () => {
    for (const status of [200, 301, 400, 401, 429]) {
      expect(classifyCrawlPageOutcome({ kind: 'http-status', httpStatus: status })).toEqual({ action: 'continue' });
    }
  });
});
