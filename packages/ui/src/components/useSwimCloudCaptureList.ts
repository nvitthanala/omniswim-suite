/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s capture-store access: the pairing token fetch
 * and the capture listing. Pure extraction from `SwimCloudCaptureBrowser.tsx`
 * — no behaviour change.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SwimCloudCaptureRecord } from './swimCloudCaptureBrowserView';

export const CAPTURES_ENDPOINT = '/api/swimcloud/captures';
const PAIRING_TOKEN_ENDPOINT = '/api/swimcloud/pairing-token';
const CAPTURE_TOKEN_HEADER = 'X-Omniswim-Capture-Token';

/** Headers for a capture-route call. Never called before the token fetch resolves. */
export const captureAuthHeaders = (token: string): HeadersInit => ({ [CAPTURE_TOKEN_HEADER]: token });

/** Fetches the pairing token once, lists captures, and exposes `refresh`. Lists on mount. */
export function useSwimCloudCaptureList() {
  const [captures, setCaptures] = useState<readonly SwimCloudCaptureRecord[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // `null` = not yet fetched, `undefined` = fetched and unavailable (see
  // `tokenError`), a string = the real pairing token. Every capture-route call
  // below waits on this rather than firing with no header and drawing a
  // guaranteed 401.
  const [pairingToken, setPairingToken] = useState<string | null | undefined>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const loadPairingToken = useCallback(async (): Promise<string | undefined> => {
    try {
      const res = await fetch(PAIRING_TOKEN_ENDPOINT);
      if (!res.ok) {
        setTokenError(
          res.status === 404
            ? 'SwimCloud capture routes are not available on this server (it may not be bound to localhost only).'
            : `Could not obtain the SwimCloud pairing token (HTTP ${res.status}).`
        );
        setPairingToken(undefined);
        return undefined;
      }
      const data = (await res.json()) as { token?: unknown };
      if (typeof data.token !== 'string' || data.token.length === 0) {
        setTokenError('The server did not return a usable pairing token.');
        setPairingToken(undefined);
        return undefined;
      }
      setPairingToken(data.token);
      return data.token;
    } catch (err) {
      setTokenError(`Could not reach the server for the pairing token: ${String(err)}`);
      setPairingToken(undefined);
      return undefined;
    }
  }, []);

  const loadCaptures = useCallback(async (token: string) => {
    setListError(null);
    try {
      const res = await fetch(CAPTURES_ENDPOINT, { headers: captureAuthHeaders(token) });
      if (!res.ok) {
        setListError(`Could not list captures (HTTP ${res.status}).`);
        setCaptures([]);
        return;
      }
      setCaptures((await res.json()) as SwimCloudCaptureRecord[]);
    } catch (err) {
      setListError(`Could not reach the capture store: ${String(err)}`);
      setCaptures([]);
    }
  }, []);

  const refresh = useCallback(async () => {
    const token = pairingToken ?? (await loadPairingToken());
    if (token) await loadCaptures(token);
  }, [pairingToken, loadPairingToken, loadCaptures]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: the first listing runs once, and `refresh` changes identity whenever the pairing token does
  }, []);

  const hasCaptureRows = captures !== null && captures.length > 0;
  const isLoadingList = tokenError === null && (pairingToken === null || captures === null);

  return {
    captures,
    listError,
    pairingToken,
    tokenError,
    loadCaptures,
    refresh,
    hasCaptureRows,
    isLoadingList,
  };
}

export type SwimCloudCaptureList = ReturnType<typeof useSwimCloudCaptureList>;
