/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One "Export entries" menu for the Manager header. It replaces the separate
 * "Export CSV" and "Export HyTek" buttons.
 */

import React from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { Menu, MenuItem } from '@omniswim/ui';

export type EntryExportKind = 'csv' | 'hytek';

type Props = {
  onExport: (kind: EntryExportKind) => void;
};

const TRIGGER_CLASS =
  'btn-accent-outline inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-ui-label font-bold transition-[color,background-color,border-color] duration-150 ease-out';

export default function ExportEntriesMenu({ onExport }: Props) {
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
    </Menu>
  );
}
