// @vitest-environment happy-dom
/**
 * Phase 3 wording: the first Manager step is "Swimmers", and the recruit form
 * submits an "Add swim" action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { elementWithChildren } from '../../tests/helpers/elementWithChildren';
import { createRoot, type Root } from 'react-dom/client';
import RosterWizardShell from '../packages/manager/src/components/RosterWizardShell';
import RecruitForm from '../packages/manager/src/components/RecruitForm';
import { Gender } from '../../packages/core/src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Manager Swimmers step wording', () => {
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

  it('names the first step Swimmers, not Source', async () => {
    await act(async () => {
      root.render(elementWithChildren(RosterWizardShell, { step: 'source', onStepChange: vi.fn() }, 'body'));
    });
    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map(t => t.textContent ?? '');
    expect(labels[0]).toContain('Swimmers');
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
