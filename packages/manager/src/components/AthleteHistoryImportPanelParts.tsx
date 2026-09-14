/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Presentational pieces of AthleteHistoryImportPanel — the diff/tag badges
 * shown per previewed swim, and the class-year select options. Split out of
 * a 767-line monolithic component per this repo's `X.tsx` + `XParts.tsx` +
 * `XView.ts` convention (see `crossCourseArbitrageParts.tsx`).
 */

import React from 'react';
import { ClassYear, HistoricalSwim } from '@omniswim/core/types';
import { badgeLabel, buildSwimRowTagSpecs, type ImportDiffStatus } from './athleteHistoryImportView';

export const CLASS_YEAR_OPTIONS: ClassYear[] = [
  ClassYear.FR,
  ClassYear.SO,
  ClassYear.JR,
  ClassYear.SR,
  ClassYear.HS,
];

export function DiffBadge({ status, deltaSec }: { status: ImportDiffStatus; deltaSec?: number }) {
  if (status === 'new') {
    return (
      <span
        className="text-ui-micro text-[var(--text-accent)] border border-[var(--text-accent)]/30 px-1.5 rounded-full"
        title="No existing time for this event/course"
      >
        NEW
      </span>
    );
  }
  if (status === 'improved') {
    const label = deltaSec != null ? deltaSec.toFixed(2) : '0.00';
    return (
      <span
        className="text-ui-micro border border-emerald-400/30 bg-emerald-400/10 text-emerald-300 px-1.5 rounded-full"
        title={`${label}s faster than the existing recorded best`}
      >
        -{label}s
      </span>
    );
  }
  return (
    <span
      className="text-ui-micro text-theme-muted border border-theme-soft px-1.5 rounded-full"
      title="Not faster than the existing recorded best for this event/course"
    >
      SAME
    </span>
  );
}

export function SwimRowTags({
  swim,
  diffStatus,
  deltaSec,
  cutTooltip,
}: {
  swim: HistoricalSwim;
  diffStatus: ImportDiffStatus;
  deltaSec?: number;
  cutTooltip?: string;
}) {
  const stamp = badgeLabel(swim.swimcloudBadge);
  const tags = buildSwimRowTagSpecs(stamp, swim, cutTooltip).filter(tag => tag.show);

  return (
    <div className="flex flex-wrap gap-1 justify-end">
      <DiffBadge status={diffStatus} deltaSec={deltaSec} />
      {tags.map(tag => (
        <span key={tag.key} className={tag.className} title={tag.title}>
          {tag.label}
        </span>
      ))}
    </div>
  );
}
