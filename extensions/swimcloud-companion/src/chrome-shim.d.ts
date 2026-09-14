/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal ambient types for the handful of `chrome.*` APIs this extension
 * calls. `@types/chrome` is not a dependency anywhere in this repo, and
 * pulling it in for three methods would be a heavier dependency than this
 * small, hand-written surface. Not a general-purpose Chrome extension typing
 * — only what `crawler-content.ts` and (informally) `background.js`/
 * `options.js` actually use. Widen this file, don't reach for `any`, if a
 * future change needs more of the API surface.
 */

declare namespace chrome.runtime {
  interface LastError {
    readonly message?: string;
  }
  const lastError: LastError | undefined;
  function sendMessage<TResponse = unknown>(
    message: unknown,
    responseCallback: (response: TResponse) => void,
  ): void;
  interface MessageSender {
    readonly tab?: unknown;
  }
  const onMessage: {
    addListener(
      callback: (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void,
    ): void;
  };
}

declare namespace chrome.storage {
  interface StorageArea {
    /** Callback form, as `options.js` uses it. */
    get(keys: readonly string[], callback: (items: Record<string, unknown>) => void): void;
    /**
     * Promise form, as `background.ts` uses it. Manifest V3 returns a promise
     * from every `chrome.storage` method when no callback is passed; both
     * overloads are real, so both are declared rather than picking one.
     */
    get(keys: readonly string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>, callback?: () => void): void;
    /** Used to clear a capture's buffered fallback pages once combined into one file. */
    remove(keys: readonly string[]): Promise<void>;
  }
  const local: StorageArea;
}

declare namespace chrome.downloads {
  interface DownloadOptions {
    readonly url: string;
    readonly filename?: string;
    readonly conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
    readonly saveAs?: boolean;
  }
  function download(options: DownloadOptions): Promise<number>;
}
