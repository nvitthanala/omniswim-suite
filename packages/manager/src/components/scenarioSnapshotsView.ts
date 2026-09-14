/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for ScenarioSnapshotsPanel and ScenarioSnapshotRow.
 * None of this touches React.
 */

/** Label suffix convention written by this panel: "<name> · <points> pts". */
const LABEL_SUFFIX_RE = / · (-?[\d.]+) pts$/;

export function parseSnapshotLabel(label: string): {
  name: string;
  points: number | null;
  hasPointsSuffix: boolean;
} {
  const m = LABEL_SUFFIX_RE.exec(label);
  if (!m) return { name: label, points: null, hasPointsSuffix: false };
  const points = Number(m[1]);
  return {
    name: label.slice(0, m.index),
    points: Number.isFinite(points) ? points : null,
    hasPointsSuffix: true,
  };
}

export function formatCompactDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDiff(diff: number): string {
  const abs = Math.abs(diff).toFixed(1);
  return diff >= 0 ? `+${abs}` : `-${abs}`;
}

/** Difference between the live projected total and a snapshot's recorded points, if both are known. */
export function computeSnapshotDiff(
  hasPointsSuffix: boolean,
  points: number | null,
  projectedTotal: number | undefined
): number | null {
  if (!hasPointsSuffix || points == null || projectedTotal == null) return null;
  return projectedTotal - points;
}
