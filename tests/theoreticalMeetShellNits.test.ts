// @vitest-environment happy-dom
/**
 * Review nits on the theoretical meet shell wiring:
 * - a failed create does not leave a banner behind after the dialog is cancelled;
 * - Metrics never offers a theoretical seed time as a comparison time;
 * - the label check lives in a light core module that the manager still re-exports;
 * - the shell loads the banner only for a theoretical meet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Gender, type Workspace } from '@omniswim/core/types';
import { THEORETICAL_MEET_LABEL, isTheoreticalMeet } from '@omniswim/core/lib/theoreticalMeetLabel';
import * as managerReexport from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import { computeComparisonTime } from '../packages/metrics/src/lib/comparisonTime';
import type { RaceConfig } from '../packages/metrics/src/types';
import { useDialogScopedError, visibleShellError } from '../apps/shell/src/lib/dialogScopedError';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('visibleShellError', () => {
  it('hides the error while the dialog is open and the one it already showed', () => {
    expect(visibleShellError(null, null, false)).toBeNull();
    expect(visibleShellError('boom', null, false)).toBe('boom');
    expect(visibleShellError('boom', null, true)).toBeNull();
    expect(visibleShellError('boom', 'boom', false)).toBeNull();
    expect(visibleShellError('other', 'boom', false)).toBe('other');
  });
});

describe('useDialogScopedError', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  function mount() {
    let latest: string | null = 'unset';
    function Probe({ error, open }: { error: string | null; open: boolean }) {
      latest = useDialogScopedError(error, open);
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (error: string | null, open: boolean) => act(() => root!.render(createElement(Probe, { error, open })));
    return { render, read: () => latest };
  }

  it('does not show the create failure after the dialog is cancelled', () => {
    const h = mount();
    h.render(null, true);
    h.render('Failed to restore workspace', true);
    expect(h.read()).toBeNull();
    h.render('Failed to restore workspace', false);
    expect(h.read()).toBeNull();
  });

  it('still shows a failure that happens with no dialog open, and a new one after the old clears', () => {
    const h = mount();
    h.render('Save failed', false);
    expect(h.read()).toBe('Save failed');
    h.render(null, true);
    h.render('Failed to restore workspace', true);
    h.render('Failed to restore workspace', false);
    expect(h.read()).toBeNull();
    h.render(null, false);
    h.render('Failed to restore workspace', false);
    expect(h.read()).toBe('Failed to restore workspace');
  });
});

describe('computeComparisonTime and theoretical meets', () => {
  const race: RaceConfig = {
    course: 'SCY',
    raceDistance: 100,
    strokePerLength: ['free', 'free'],
    cycleDefinition: 'same-hand',
    fifteenMetreReferenceConfirmed: true,
    isRelayLeg: false,
  };
  const history = [{ name: 'Sam Swimmer', team: 'T', gender: Gender.MEN, event: '100 Free', time: '45.00' }];
  const base = { id: 'w', name: 'W', athleteHistory: history } as unknown as Workspace;

  it('offers the history time on a real workspace', () => {
    expect(computeComparisonTime(base, 'Sam Swimmer', race)).toBe('45.00');
    expect(computeComparisonTime({ ...base, loadedMeet: { pdfFilename: 'm.pdf', uploadedAt: 1 } }, 'Sam Swimmer', race)).toBe('45.00');
  });

  it('offers nothing on a theoretical meet', () => {
    const theoretical = { ...base, loadedMeet: { meetLabel: THEORETICAL_MEET_LABEL, uploadedAt: 1 } } as Workspace;
    expect(computeComparisonTime(theoretical, 'Sam Swimmer', race)).toBeNull();
  });
});

describe('the label module', () => {
  it('is the same check the manager exports', () => {
    expect(managerReexport.THEORETICAL_MEET_LABEL).toBe(THEORETICAL_MEET_LABEL);
    expect(managerReexport.isTheoreticalMeet).toBe(isTheoreticalMeet);
    expect(isTheoreticalMeet({ loadedMeet: { meetLabel: THEORETICAL_MEET_LABEL } })).toBe(true);
    expect(isTheoreticalMeet({ loadedMeet: { meetLabel: 'NSISC 2026' } })).toBe(false);
    expect(isTheoreticalMeet({ loadedMeet: null })).toBe(false);
    expect(isTheoreticalMeet(undefined)).toBe(false);
  });

  it('imports nothing but a type, so the shell and Metrics stay light', () => {
    const src = readFileSync(join(import.meta.dirname, '../packages/core/src/lib/theoreticalMeetLabel.ts'), 'utf8');
    const imports = src.split('\n').filter(l => l.startsWith('import '));
    expect(imports.every(l => l.startsWith('import type '))).toBe(true);
  });

  it('gates the shell banner on the label, not on any loaded meet', () => {
    const app = readFileSync(join(import.meta.dirname, '../apps/shell/src/App.tsx'), 'utf8');
    expect(app).toContain('isTheoreticalMeet(activeWorkspace)');
    expect(app).not.toMatch(/activeWorkspace\?\.loadedMeet \?/);
    expect(app).toContain("from '@omniswim/core/lib/theoreticalMeetLabel'");
  });
});
