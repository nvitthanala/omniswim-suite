import React from 'react';
import { entryCsv } from '@omniswim/engine';
import type { Lineup, ReportFacts, Results, RoleLabel } from '@omniswim/engine';

export interface EntryCsvButtonProps {
  lineup: Lineup;
  results: Results;
  facts: ReportFacts | null;
  roles: ReadonlyMap<string, RoleLabel>;
  fileName: string;
  download?: CsvDownload;
}

export type CsvDownload = (content: string, fileName: string, mimeType: string) => void;
export const CSV_MIME_TYPE = 'text/csv;charset=utf-8';

export const downloadCsv: CsvDownload = (content, fileName, mimeType) => {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
export const downloadEntryCsv = (content: string, fileName: string, download: CsvDownload = downloadCsv): void => download(content, fileName, CSV_MIME_TYPE);

export function EntryCsvButton({ lineup, results, facts, roles, fileName, download = downloadCsv }: EntryCsvButtonProps): React.ReactElement {
  if (facts === null) return <div className="osx-report-export">
    <button type="button" disabled>Download entry CSV</button>
    <p>This snapshot has no seed facts, so the entry CSV cannot be made. Save a new snapshot from the docked panel.</p>
  </div>;
  const csv = entryCsv(lineup, results, facts, roles);
  if (csv.issues.length > 0) return <div className="osx-report-export">
    <ul aria-label="CSV issues">{csv.issues.map((issue, index) => <li key={`${issue.kind}-${index}`}>{issue.message}</li>)}</ul>
  </div>;
  return <button type="button" onClick={() => downloadEntryCsv(csv.content, fileName, download)}>Download entry CSV ({csv.count})</button>;
}
