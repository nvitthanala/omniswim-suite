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
import {
  TheoreticalMeetBanner,
  THEORETICAL_BANNER_CAVEATS,
  NO_REMOVED_EVENTS_BANNER_LINE,
  bannerCaveatsFor,
  removedEventsBannerLine,
} from '../packages/manager/src/components/theoreticalMeet/TheoreticalMeetBanner';
import { Gender, type TheoreticalRemovedEvent } from '../packages/core/src/types';

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

  describe('removed events', () => {
    const LEGACY_LINE = /Events may have been removed from some lineups/;
    const removed: TheoreticalRemovedEvent[] = [
      { teamName: 'Henderson State University', gender: Gender.MEN, swimmerName: 'Gavin Kock', event: '100 Free SCY', time: '45.52' },
      { teamName: 'Delta State University', gender: Gender.WOMEN, swimmerName: 'Ave Owens', event: '200 IM SCY', time: '2:05.10' },
    ];
    /** The workspace as it comes back from storage, so the list is read after a reload. */
    const reloaded = (loadedMeet: Record<string, unknown>) =>
      JSON.parse(JSON.stringify({ loadedMeet: { meetLabel: THEORETICAL_MEET_LABEL, ...loadedMeet } })) as unknown;
    const panelText = () => {
      const toggle = container.querySelector('button')!;
      act(() => toggle.click());
      return document.getElementById(toggle.getAttribute('aria-controls')!)!;
    };

    it('says nothing new for a meet built before the list was kept', () => {
      render(reloaded({}));
      const panel = panelText();
      expect(panel.textContent).toMatch(LEGACY_LINE);
      expect(panel.textContent).not.toContain('removed from lineups in the build preview');
      expect(panel.querySelectorAll('li').length).toBe(THEORETICAL_BANNER_CAVEATS.length);
      expect(panel.querySelector('[aria-label="Events removed from lineups"]')).toBeNull();
    });

    it('says no event was removed when the list is empty', () => {
      render(reloaded({ theoreticalRemovedEvents: [] }));
      const panel = panelText();
      expect(panel.textContent).toContain(NO_REMOVED_EVENTS_BANNER_LINE);
      expect(panel.textContent).not.toMatch(LEGACY_LINE);
      expect(panel.querySelectorAll('li').length).toBe(THEORETICAL_BANNER_CAVEATS.length);
    });

    it('lists each removed swimmer, event and time after a reload', () => {
      render(reloaded({ theoreticalRemovedEvents: removed }));
      const panel = panelText();
      expect(panel.textContent).toContain(removedEventsBannerLine(2));
      expect(panel.textContent).not.toMatch(LEGACY_LINE);
      const list = panel.querySelector('[aria-label="Events removed from lineups"]')!;
      const items = Array.from(list.querySelectorAll('li')).map(li => li.textContent);
      expect(items).toStrictEqual([
        'Gavin Kock: 100 Free SCY, 45.52 (Henderson State University, Men)',
        'Ave Owens: 200 IM SCY, 2:05.10 (Delta State University, Women)',
      ]);
    });

    it('builds the caveat lines the same way outside the component', () => {
      expect(bannerCaveatsFor(false)).toStrictEqual(THEORETICAL_BANNER_CAVEATS);
      expect(bannerCaveatsFor(false, undefined)).toStrictEqual(THEORETICAL_BANNER_CAVEATS);
      expect(bannerCaveatsFor(false, [])).toContain(NO_REMOVED_EVENTS_BANNER_LINE);
      expect(bannerCaveatsFor(false, removed)).toContain(removedEventsBannerLine(2));
      expect(removedEventsBannerLine(1)).toMatch(/^1 event was removed/);
      for (const lines of [bannerCaveatsFor(false, []), bannerCaveatsFor(false, removed)]) {
        expect(lines.some(line => LEGACY_LINE.test(line))).toBe(false);
        expect(lines).toHaveLength(THEORETICAL_BANNER_CAVEATS.length);
      }
    });
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
