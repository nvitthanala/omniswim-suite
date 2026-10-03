/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The multi-team crawl's conversation with the background worker and, through
 * it, the Omniswim app: relay a page, open a capture, mark it, flush the
 * downloads fallback.
 *
 * Pure: the one impure thing, sending a message to the worker under a deadline,
 * is injected as `send`. `crawler-content.ts` passes the real `sendToBackground`;
 * a test passes a fake worker. That makes the rules below a unit test:
 *
 * - **A page is `landed` only on the HTTP path.** The worker answers
 *   `{ relayed: true, via: 'downloads' }` when the app refused the page (a 404
 *   for a capture that was never opened is the known case) and it saved the page
 *   in `chrome.storage.local` instead. That page is not in the app. It is a
 *   `fallback`, counted toward the failure streak, never `landed`.
 * - **Failures in a row stop the run.** `RELAY_FAILURE_STOP_THRESHOLD` fallbacks
 *   or losses in a row return `streak-stop`. The counter is per app object, and
 *   {@link MultiTeamApp.reset} clears it at the start of each run.
 * - **Opening a capture returns its id or nothing.** No id means the app did not
 *   answer (not running, not paired). The driver stops before any roster.
 */

import {
  RELAY_FAILURE_STOP_THRESHOLD,
  RELAY_ROUND_TRIP_TIMEOUT_MS,
  isRoundTripOk,
  roundTripFailureText,
  type BackgroundRoundTrip,
} from './backgroundRoundTrip';
import type {
  MultiTeamCaptureCompleteness,
  MultiTeamFlushResult,
  MultiTeamRelayOutcome,
  MultiTeamRelayRequest,
} from './multiTeamDriver';
import type { SwimCloudCaptureSubject } from '@omniswim/swimcloud/entities';

/** One message to the worker under a deadline. The real one is `sendToBackground`. */
export type SendToWorker = (message: Readonly<Record<string, unknown>>, timeoutMs?: number) => Promise<BackgroundRoundTrip<unknown>>;

interface RelayReply {
  readonly relayed?: boolean;
  readonly via?: string;
}

interface OpenReply {
  readonly captureId?: unknown;
}

interface FlushReply {
  readonly flushed?: boolean;
  readonly pageCount?: number;
  readonly filename?: string;
  readonly error?: string;
}

export interface MultiTeamApp {
  relay(request: MultiTeamRelayRequest): Promise<MultiTeamRelayOutcome>;
  openCapture(subject: SwimCloudCaptureSubject, plannedPageCount: number): Promise<string | undefined>;
  markCapture(subject: SwimCloudCaptureSubject, completeness: MultiTeamCaptureCompleteness): Promise<void>;
  flushDownloads(subjects: readonly SwimCloudCaptureSubject[]): Promise<readonly MultiTeamFlushResult[]>;
  /** Clear the failure streak. Call at the start of every run. */
  reset(): void;
}

export function createMultiTeamApp(send: SendToWorker, now: () => string = () => new Date().toISOString()): MultiTeamApp {
  let consecutiveFailures = 0;

  return {
    reset() {
      consecutiveFailures = 0;
    },

    async relay(request) {
      const trip = await send(
        {
          type: 'omniswim-swimcloud-relay-page',
          subject: request.subject,
          sourceUrl: request.sourceUrl,
          retrievedAt: now(),
          httpStatus: request.httpStatus,
          html: request.html,
        },
        RELAY_ROUND_TRIP_TIMEOUT_MS,
      );
      const reply = isRoundTripOk(trip) ? (trip.value as RelayReply | undefined) : undefined;
      if (reply?.relayed === true && reply.via === 'http') {
        consecutiveFailures = 0;
        return 'landed';
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= RELAY_FAILURE_STOP_THRESHOLD) return 'streak-stop';
      return reply?.relayed === true ? 'fallback' : 'lost';
    },

    async openCapture(subject, plannedPageCount) {
      const trip = await send({ type: 'omniswim-swimcloud-open-capture', subject, plannedPageCount });
      if (!isRoundTripOk(trip)) return undefined;
      const id = (trip.value as OpenReply | undefined)?.captureId;
      return typeof id === 'string' && id.length > 0 ? id : undefined;
    },

    async markCapture(subject, completeness) {
      // Bookkeeping. A failure here must not hide that the pages are saved, so it is not an error.
      await send({ type: 'omniswim-swimcloud-mark-capture', subject, completeness });
    },

    async flushDownloads(subjects) {
      const results: MultiTeamFlushResult[] = [];
      for (const subject of subjects) {
        const trip = await send({ type: 'omniswim-swimcloud-flush-downloads', subject });
        if (!isRoundTripOk(trip)) {
          results.push({ subject, pageCount: 0, error: roundTripFailureText('Flushing the pages saved to Downloads', trip) });
          continue;
        }
        const reply = (trip.value ?? {}) as FlushReply;
        results.push({
          subject,
          pageCount: typeof reply.pageCount === 'number' ? reply.pageCount : 0,
          ...(reply.filename === undefined ? {} : { filename: reply.filename }),
          ...(reply.error === undefined ? {} : { error: reply.error }),
        });
      }
      return results;
    },
  };
}
