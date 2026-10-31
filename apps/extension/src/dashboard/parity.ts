import type { ParityReport } from '@omniswim/swimcloud/browser';

export function postDockedParityReport(target: Window, report: ParityReport): void {
  target.postMessage({ source: 'osx-docked-dashboard', kind: 'parity-report', report }, 'https://www.swimcloud.com');
}
