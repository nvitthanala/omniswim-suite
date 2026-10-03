// @vitest-environment happy-dom
/**
 * Phase 3 wording: the first Manager step is "Athletes", and the recruit form
 * submits an "Add swim" action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RosterWizardShell from '../packages/manager/src/components/RosterWizardShell';
import RecruitForm from '../packages/manager/src/components/RecruitForm';
import { Gender } from '../packages/core/src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Manager Athletes step wording', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('names the first step Athletes, not Source', async () => {
    await act(async () => {
      root.render(createElement(RosterWizardShell, { step: 'source', onStepChange: vi.fn() }, 'body'));
    });
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent ?? '');
    expect(labels[0]).toContain('Athletes');
    expect(labels.join(' ')).not.toContain('Source');
  });

  it.each([true, false])('labels the recruit submit "Add swim" (compact=%s)', async compact => {
    await act(async () => {
      root.render(createElement(RecruitForm, { gender: Gender.MEN, teams: ['Alpha'], onSubmit: vi.fn(), compact }));
    });
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.textContent).toBe('Add swim');
    expect(container.textContent).not.toMatch(/inject/i);
  });
});
