/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Detected-format line, warnings list, unread-stamp summary and error text
 * for AthleteHistoryImportPanel — split out of the panel's own function body.
 */
type Props = {
  formatLabel: string;
  previewCount: number;
  otherWarnings: string[];
  unreadStampSummary: string | null;
  error: string;
};

export default function AthleteHistoryImportMessages({
  formatLabel,
  previewCount,
  otherWarnings,
  unreadStampSummary,
  error,
}: Props) {
  return (
    <>
      {formatLabel ? (
        <p className="text-ui-caption text-theme-secondary mb-2">
          Detected: <span className="text-[var(--text-accent)]">{formatLabel.replace('_', ' ')}</span>
          {previewCount > 0 ? ` · ${previewCount} rows` : null}
        </p>
      ) : null}

      {otherWarnings.length > 0 ? (
        <ul className="text-ui-caption text-amber-400/90 mb-2 list-disc list-inside space-y-1">
          {otherWarnings.map((w, i) => (
            <li key={i} className="break-words">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {unreadStampSummary ? (
        <p className="text-ui-caption text-theme-secondary mb-2 break-words">{unreadStampSummary}</p>
      ) : null}

      {error ? <p className="text-ui-caption text-amber-400 mb-2 break-words">{error}</p> : null}
    </>
  );
}
