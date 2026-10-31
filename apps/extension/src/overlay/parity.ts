import type { ParityReport } from '@omniswim/swimcloud/browser';

export function trustedParityReport(source: MessageEventSource | null, origin: string, iframe: Window | null, extensionOrigin: string, data: unknown): ParityReport | null {
  if (source !== iframe || origin !== extensionOrigin) return null;
  const message = data as { source?: unknown; kind?: unknown; report?: unknown } | null;
  if (!message || message.source !== 'osx-docked-dashboard' || message.kind !== 'parity-report' || typeof message.report !== 'object' || message.report === null) return null;
  const report = message.report as { kind?: unknown; matches?: unknown; differingEvents?: unknown };
  if (report.kind !== 'not_observed' && !(report.kind === 'compared' && typeof report.matches === 'boolean' && Array.isArray(report.differingEvents))) return null;
  return message.report as ParityReport;
}
