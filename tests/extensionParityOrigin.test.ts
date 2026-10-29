import { describe, expect, it, vi } from 'vitest';
import { postDockedParityReport } from '../apps/extension/src/dashboard/parity';
import { trustedParityReport } from '../apps/extension/src/overlay/parity';

const report = { kind: 'not_observed' } as const;

describe('docked parity origin', () => {
  it('posts only to the SwimCloud origin', () => {
    const target = { postMessage: vi.fn() } as unknown as Window;
    postDockedParityReport(target, report);
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'parity-report', report }), 'https://www.swimcloud.com');
  });

  it('ignores forged page and wrong-origin messages', () => {
    const iframe = {} as Window;
    const data = { source: 'osx-docked-dashboard', kind: 'parity-report', report };
    expect(trustedParityReport({} as Window, 'https://chrome-extension://abc', iframe, 'chrome-extension://abc', data)).toBeNull();
    expect(trustedParityReport(iframe, 'https://www.swimcloud.com', iframe, 'chrome-extension://abc', data)).toBeNull();
    expect(trustedParityReport(iframe, 'chrome-extension://abc', iframe, 'chrome-extension://abc', data)).toEqual(report);
  });
});
