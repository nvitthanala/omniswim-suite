/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The fetch-backed dependencies `theoreticalMeetFromCaptures` takes.
 *
 * ```
 * GET  /api/swimcloud/pairing-token        -> { token }
 * GET  /api/swimcloud/captures             -> CaptureListRecord[]      (header X-Omniswim-Capture-Token)
 * POST /api/swimcloud/captures/:id/parse   -> TheoreticalCaptureParse  (same header)
 * ```
 *
 * The token is fetched once per `createCaptureApi` call and reused. No route returns stored page bytes,
 * so `readRosterPageHtml` is left out and the data layer keeps `rosterSeasonId` undefined
 * (its caveat then says the roster season is not known).
 */

import type { TheoreticalCaptureDeps, TheoreticalCaptureParse } from '../../lib/theoreticalMeetFromCaptures';
import { CaptureApiError, type CaptureListRecord } from './theoreticalMeetView';

const PAIRING_TOKEN_ENDPOINT = '/api/swimcloud/pairing-token';
const CAPTURES_ENDPOINT = '/api/swimcloud/captures';
const CAPTURE_TOKEN_HEADER = 'X-Omniswim-Capture-Token';

export interface CaptureApi extends TheoreticalCaptureDeps {
  listCaptures(): Promise<readonly CaptureListRecord[]>;
}

async function send(fetchImpl: typeof fetch, input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (err) {
    throw new CaptureApiError(0, `Could not reach the server (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/** Build the capture API over `fetchImpl`. Each call of this function fetches its own pairing token, once. */
export function createCaptureApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): CaptureApi {
  let token: Promise<string> | undefined;

  const loadToken = async (): Promise<string> => {
    const res = await send(fetchImpl, PAIRING_TOKEN_ENDPOINT);
    if (!res.ok) throw new CaptureApiError(res.status, `Could not get the capture pairing token (HTTP ${res.status}).`);
    const body = (await res.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new CaptureApiError(502, 'The server did not return a usable pairing token.');
    }
    return body.token;
  };

  const headers = async (): Promise<HeadersInit> => {
    // A failed token fetch is not cached: the next call asks again.
    token ??= loadToken().catch(err => {
      token = undefined;
      throw err;
    });
    return { [CAPTURE_TOKEN_HEADER]: await token };
  };

  return {
    async listCaptures() {
      const res = await send(fetchImpl, CAPTURES_ENDPOINT, { headers: await headers() });
      if (!res.ok) throw new CaptureApiError(res.status, `Could not list captures (HTTP ${res.status}).`);
      const body: unknown = await res.json().catch(() => null);
      if (!Array.isArray(body)) throw new CaptureApiError(502, 'The capture list was not a list.');
      return body as CaptureListRecord[];
    },
    async parseCapture(captureId: string): Promise<TheoreticalCaptureParse> {
      const res = await send(fetchImpl, `${CAPTURES_ENDPOINT}/${encodeURIComponent(captureId)}/parse`, {
        method: 'POST',
        headers: await headers(),
      });
      if (!res.ok) throw new CaptureApiError(res.status, `Could not read capture ${captureId} (HTTP ${res.status}).`);
      return (await res.json()) as TheoreticalCaptureParse;
    },
  };
}
