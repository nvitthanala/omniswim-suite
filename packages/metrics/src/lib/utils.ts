import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatSecondsToTime } from "@omniswim/core/lib/utils";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** What a missing or unusable time renders as. Never `0.00`: absent is not zero. */
export const MISSING_TIME_MARKER = '—';

/**
 * A time in seconds as `s.ss` or `m:ss.ss`, rounded to the hundredth.
 *
 * This delegates to core's `formatSecondsToTime` so the suite has one time
 * format. It differs from core in two ways, both deliberate:
 *
 * - A missing, non-finite or negative value renders as {@link MISSING_TIME_MARKER}.
 *   Core's formatter has no null case (`NaN` becomes `NaN:NaN`, `Infinity`
 *   becomes `NT`), and the previous local version printed `0.00`, which reads
 *   as a real zero-second time.
 * - The value is rounded to the hundredth before core formats it, so a time
 *   that rounds up to a whole minute reads `1:00.00`, not `60.00` or `1:60.00`.
 *
 * The rounding is `toFixed(2)`, the same rule core uses, so every other value
 * formats exactly as core would. It rounds; it does not truncate.
 */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return MISSING_TIME_MARKER;
  return formatSecondsToTime(Number(seconds.toFixed(2)));
}

export function exportToCSV(data: any, filename: string) {
  const replacer = (key: string, value: any) => value === null ? '' : value; 
  const header = Object.keys(data[0]);
  const csv = [
    header.join(','),
    ...data.map((row: any) => header.map(fieldName => JSON.stringify(row[fieldName], replacer)).join(','))
  ].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
