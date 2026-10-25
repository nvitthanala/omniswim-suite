/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One "Export entries" menu for the Manager header. It replaces the separate
 * "Export CSV" and "Export HyTek" buttons.
 */

import React from 'react';
import { Download, FileSpreadsheet, FileText, Globe } from 'lucide-react';
import { Menu, MenuItem } from '@omniswim/ui';

export type EntryExportKind = 'csv' | 'hytek';

type Props = {
  onExport: (kind: EntryExportKind) => void;
  /**
   * Writes the static HTML report. Optional, so a caller without report data keeps the
   * two entry formats only. The file needs no server, so it works when sharing is off.
   */
  onExportReport?: () => void;
};

const TRIGGER_CLASS =
  'btn-accent-outline inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-ui-label font-bold transition-[color,background-color,border-color] duration-150 ease-out';

export default function ExportEntriesMenu({ onExport, onExportReport }: Props) {
  return (
    <Menu
      label="Export entries"
      icon={<Download size={14} aria-hidden="true" />}
      showLabel
      triggerClassName={TRIGGER_CLASS}
    >
      <MenuItem icon={<FileSpreadsheet size={14} aria-hidden="true" />} onSelect={() => onExport('csv')}>
        CSV (spreadsheet)
      </MenuItem>
      <MenuItem icon={<FileText size={14} aria-hidden="true" />} onSelect={() => onExport('hytek')}>
        HyTek entry list
      </MenuItem>
      {onExportReport ? (
        <MenuItem
          icon={<Globe size={14} aria-hidden="true" />}
          onSelect={onExportReport}
          title="One .html file with team scores, the lineup and a key to the terms. It needs no server and prints cleanly."
        >
          Export report (HTML)
        </MenuItem>
      ) : null}
    </Menu>
  );
}
