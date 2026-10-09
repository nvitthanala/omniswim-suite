/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wire names for save sequencing on `PUT /api/workspaces/:id`.
 *
 * The client numbers every save it sends for a workspace (1, 2, 3 ...) and tags
 * the whole run with one random id for the page. The server remembers the
 * highest number it applied per workspace and refuses anything at or below it
 * from the same client. That is how a save A that reaches the server after a
 * newer save B stops being written over B.
 *
 * Carried in headers, not in the body, so the body stays a pure workspace patch
 * (the JSON backend merges the patch into the stored document verbatim, and a
 * sequence number must never become workspace data).
 *
 * One file, imported by both the browser client and the server, so the two
 * cannot drift apart on a header name.
 */
export const SAVE_CLIENT_HEADER = 'X-Omni-Client-Id';
export const SAVE_SEQ_HEADER = 'X-Omni-Save-Seq';
/** Set on a response when the request carried no sequence, so the save could not be checked. */
export const SAVE_UNCHECKED_HEADER = 'X-Omni-Save-Unchecked';
/** `code` in the 409 body of a refused out-of-order save. */
export const STALE_SAVE_CODE = 'STALE_SAVE';

export interface SaveToken {
  /** Random id for one page load (one provider mount). */
  readonly clientId: string;
  /** Per-workspace, strictly increasing within one `clientId`. Starts at 1. */
  readonly seq: number;
}

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const SEQ_PATTERN = /^[1-9]\d{0,14}$/;
