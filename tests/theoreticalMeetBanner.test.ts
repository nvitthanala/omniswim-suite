// @vitest-environment happy-dom
/**
 * The theoretical meet banner: absent on a real meet, unmistakable on a theoretical one, caveats behind a
 * disclosure, and built from token classes only (the amber and hex ratchets stay green).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEORETICAL_MEET_LABEL } from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import { TheoreticalMeetBanner, THEORETICAL_BANNER_CAVEATS } from '../packages/manager/src/components/theoreticalMeet/TheoreticalMeetBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('TheoreticalMeetBanner', () => {
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
  const render = (workspace: unknown) => act(() => root.render(createElement(TheoreticalMeetBanner, { workspace: workspace as never })));

  it('renders nothing for a real meet, a blank workspace, or no workspace', () => {
    render({ loadedMeet: { pdfFilename: 'meet.pdf' } });
    expect(container.innerHTML).toBe('');
    render({});
    expect(container.innerHTML).toBe('');
    render(undefined);
    expect(container.innerHTML).toBe('');
  });

  it('says it is a theoretical meet and that relays are not included, with caveats collapsed', () => {
    render({ loadedMeet: { meetLabel: THEORETICAL_MEET_LABEL } });
    expect(container.textContent).toContain('Theoretical meet: seeded from crawled teams.');
    expect(container.textContent).toContain('Relays are not included');
    const toggle = container.querySelector('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(true);
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(panel.querySelectorAll('li').length).toBe(THEORETICAL_BANNER_CAVEATS.length);
    expect(panel.textContent).toMatch(/all-time bests/);
    expect(panel.textContent).toMatch(/Diving is not included/);
    expect(panel.textContent).toMatch(/Exhibition swims/);
  });

  it('uses the warning token classes and no fixed colour', () => {
    const dir = join(import.meta.dirname, '..', 'packages', 'manager', 'src', 'components', 'theoreticalMeet');
    for (const file of readdirSync(dir).filter(name => name.endsWith('.tsx'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/\bamber-|\buppercase\b/);
    }
    const banner = readFileSync(join(dir, 'TheoreticalMeetBanner.tsx'), 'utf8');
    expect(banner).toContain('text-warning');
    expect(banner).toContain('bg-warning-faint');
    expect(banner).toContain('border-warning-faint');
  });
});
