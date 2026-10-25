/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `isLoopbackHost` — the single predicate that decides whether this server is
 * reachable from another machine.
 *
 * Lifted verbatim out of `server.ts` on 2026-09-08 so the SwimCloud capture
 * routes (`./swimcloudCaptureRoutes.ts`) can gate their own registration on the
 * *same* function the startup banner and `warnIfNetworkExposed()` already use.
 * A security predicate with two implementations has one implementation too
 * many: a second copy that drifts would let the capture routes register on an
 * address the exposure warning still considers safe, or the reverse.
 *
 * `server.ts` imports it back and its call sites are unchanged.
 */

/** True only for addresses that cannot be reached from another machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  // Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1), then match the whole 127.0.0.0/8 block.
  const v4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return /^127(\.\d{1,3}){3}$/.test(v4);
}
