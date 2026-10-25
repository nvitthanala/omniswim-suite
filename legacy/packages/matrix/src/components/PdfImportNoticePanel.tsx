/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C5-UI: the visible note on how a meet PDF was read. It shows when the older
 * parser read the file, when the parser raised warnings, or when the import was
 * refused with the rows that blocked it. It does not go away on its own.
 */
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@omniswim/ui';
import type { PdfImportNotice } from '../lib/pdfImportNotice';

const MAX_EXAMPLES_PER_GROUP = 3;

export function PdfImportNoticePanel({
  notice,
  onDismiss,
}: {
  notice: PdfImportNotice;
  onDismiss: () => void;
}) {
  const isError = notice.tone === 'error';
  return (
    <div
      // An error interrupts a screen reader; a warning waits its turn.
      role={isError ? 'alert' : 'status'}
      className={[
        'rounded-lg border p-3 space-y-2',
        isError ? 'border-theme-soft' : 'border-warning bg-warning-faint',
      ].join(' ')}
      data-testid="pdf-import-notice"
      data-tone={notice.tone}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle
            size={16}
            className={['mt-0.5 shrink-0', isError ? 'text-points-negative' : 'text-warning'].join(' ')}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className={['text-ui-label font-bold', isError ? 'text-points-negative' : 'text-warning'].join(' ')}>
              {notice.title}
            </p>
            <p className="text-ui-caption text-theme-secondary mt-0.5">{notice.body}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="Dismiss import notice"
          className="p-1"
          leadingIcon={<X size={14} />}
        />
      </div>

      {notice.legacyReason ? (
        <p className="text-ui-caption text-theme-muted">
          <span className="font-medium text-theme-secondary">Why: </span>
          {notice.legacyReason}
        </p>
      ) : null}

      {notice.rows.length > 0 ? (
        <div>
          <p className="text-ui-caption font-medium text-theme-secondary">
            {notice.rows.length === 1 ? 'The row that blocked the import' : 'The rows that blocked the import'}
          </p>
          <ul className="mt-1 max-h-40 overflow-y-auto space-y-1">
            {notice.rows.map((row, i) => (
              <li key={i} className="text-ui-micro font-mono text-theme-secondary">
                {row}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice.warnings.length > 0 ? (
        <div>
          <p className="text-ui-caption font-medium text-theme-secondary">What the parser flagged</p>
          <ul className="mt-1 space-y-1.5">
            {notice.warnings.map(group => (
              <li key={group.code} className="text-ui-caption text-theme-secondary">
                <span className="font-mono text-theme-muted">{group.code}</span>
                {group.rows > 0 ? ` (${group.rows} ${group.rows === 1 ? 'row' : 'rows'})` : null}
                {group.examples.slice(0, MAX_EXAMPLES_PER_GROUP).map((example, i) => (
                  <span key={i} className="block text-ui-micro text-theme-muted pl-3">
                    {example}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
