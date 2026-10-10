// @vitest-environment happy-dom
/**
 * The "Build theoretical meet" flow, from the capture list to Create.
 *
 * - createMeet: a fresh id, never an id the app already holds, and a typed name without a rebuild.
 * - The dialog: calls the data layer with the picked capture ids, shows a disabled capture with its
 *   reason, shows a failed team with Retry, blocks Create until every team is read, and creates a
 *   workspace through `restoreWorkspace` with an unused id.
 *
 * The capture API is faked over the committed fixtures (tests/theoreticalMeetUiFixtures.ts).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../packages/core/src/types';
import { isTheoreticalMeet, THEORETICAL_MEET_LABEL } from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import { TheoreticalMeetDialogContent } from '../packages/manager/src/components/theoreticalMeet/TheoreticalMeetDialog';
import { buildMeet, createMeet, readTeamCapture } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetFlow';
import { fakeCaptureApi, fixtureParse, fixtureRecords, CAPTURE_IDS } from './theoreticalMeetUiFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = CAPTURE_IDS[0];
const B = CAPTURE_IDS[1];

/* -------------------------------------------------------------------------- */
/* createMeet                                                                  */
/* -------------------------------------------------------------------------- */

describe('createMeet', async () => {
  const records = await fixtureRecords();
  const api = fakeCaptureApi();
  const results: Record<string, Awaited<ReturnType<typeof readTeamCapture>>> = {};
  for (const id of [A, B]) results[id] = await readTeamCapture(api, id, records);
  const args = { captureIds: [A, B], resultsByCaptureId: results, scoringChoiceId: 'nsisc' };
  const preview = buildMeet(args, 'preview-id', 1_760_000_000_000);

  it('uses the preview id when it is free and posts the payload as built', async () => {
    const restore = vi.fn(async (w: Workspace) => w);
    const { workspace, built } = await createMeet({ restoreWorkspace: restore, existingWorkspaceIds: () => ['other'] }, args, preview);
    expect(built.workspaceId).toBe('preview-id');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(workspace.id).toBe('preview-id');
    expect(isTheoreticalMeet(workspace)).toBe(true);
    expect(workspace.loadedMeet?.meetLabel).toBe(THEORETICAL_MEET_LABEL);
  });

  it('never posts an id the app holds: it rebuilds under a fresh id', async () => {
    const restore = vi.fn(async (w: Workspace) => w);
    const ids = ['preview-id', 'fresh-1'];
    const { workspace } = await createMeet(
      { restoreWorkspace: restore, existingWorkspaceIds: () => ['preview-id'], newId: () => ids.shift()! },
      args,
      preview
    );
    expect(workspace.id).toBe('fresh-1');
    // Every row id carries the workspace id it was built for.
    const row = workspace.menResults[0];
    expect(row.id).toContain('fresh-1');
    expect(row.id).not.toContain('preview-id');
    expect(restore.mock.calls[0][0].id).toBe('fresh-1');
  });

  it('gives up after five taken ids and posts nothing', async () => {
    const restore = vi.fn(async (w: Workspace) => w);
    await expect(
      createMeet({ restoreWorkspace: restore, existingWorkspaceIds: () => ['preview-id', 'x'], newId: () => 'x' }, args, preview)
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(restore).not.toHaveBeenCalled();
  });

  it('applies the typed name without a rebuild, sanitized, and keeps the default when it is blank', async () => {
    const restore = vi.fn(async (w: Workspace) => w);
    const deps = { restoreWorkspace: restore, existingWorkspaceIds: () => [] as string[] };
    const named = await createMeet(deps, args, preview, '  My <b>meet</b>  ');
    expect(named.workspace.name).toBe('My b meet /b');
    const blank = await createMeet(deps, args, preview, '   ');
    expect(blank.workspace.name).toBe(preview.build.payload.name);
    expect(blank.workspace.name).toMatch(/^Theoretical meet: 2 teams/);
  });
});

/* -------------------------------------------------------------------------- */
/* The dialog                                                                  */
/* -------------------------------------------------------------------------- */

describe('TheoreticalMeetDialogContent', () => {
  let container: HTMLDivElement;
  let root: Root;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    opener = document.createElement('button');
    opener.textContent = 'Build theoretical meet';
    document.body.appendChild(opener);
    opener.focus();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    opener.remove();
  });

  async function tick(ms = 20) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms));
    });
  }

  async function waitFor<T>(read: () => T | null | undefined | false, timeout = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`waitFor timed out. Dialog text: ${document.body.textContent?.slice(0, 600)}`);
      await tick();
    }
  }

  const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
  const button = (name: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

  async function click(el: Element) {
    await act(async () => {
      (el as HTMLElement).click();
    });
  }

  async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function mount(options: { api?: ReturnType<typeof fakeCaptureApi>; existing?: string[]; restore?: (w: Workspace) => Promise<Workspace>; onCreated?: (w: Workspace) => void; onClose?: () => void } = {}) {
    const api = options.api ?? fakeCaptureApi();
    const restore = vi.fn(options.restore ?? (async (w: Workspace) => w));
    const onCreated = vi.fn(options.onCreated);
    const onClose = vi.fn(options.onClose);
    const existing = (options.existing ?? ['existing-workspace']).map(id => ({ id, name: id, menResults: [], womenResults: [] }) as unknown as Workspace);
    act(() => {
      root.render(
        createElement(TheoreticalMeetDialogContent, {
          api,
          workspaces: existing,
          restoreWorkspace: restore,
          onCreated,
          onClose,
          now: () => Date.parse('2026-10-05T00:00:00Z'),
        })
      );
    });
    return { api, restore, onCreated, onClose };
  }

  const captureBox = (id: string) => q<HTMLInputElement>(`input[id="tmeet-capture-${id}"]`);

  it('is a labelled dialog that starts on Teams, with skeleton rows until the list arrives', async () => {
    mount();
    const dialog = q('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Build theoretical meet');
    expect(q('[aria-label="Loading crawled teams"]')).not.toBeNull();
    await waitFor(() => captureBox(A));
    expect(q('[aria-label="Loading crawled teams"]')).toBeNull();
    expect(q('li[aria-current="step"]')?.textContent).toContain('Teams');
    expect(button('Next')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Pick at least one team.');
  });

  it('labels every control and returns focus to the opener on close', async () => {
    mount();
    await waitFor(() => captureBox(A));
    for (const input of document.body.querySelectorAll('input[type="checkbox"]')) {
      expect((input as HTMLInputElement).labels?.length).toBeGreaterThan(0);
    }
    expect(q('button[aria-label="Close"]')).not.toBeNull();
    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    root = createRoot(container);
  });

  it('shows an unfinished capture disabled, with the reason, and a stale one with its age', async () => {
    const records = await fixtureRecords();
    const busy = { ...records[0], captureId: 'team-99-2026-2027', subject: { kind: 'team' as const, teamId: '99', season: '2026-2027' }, completeness: 'in-progress' as const };
    const oldRecords = records.map(r => ({ ...r, pages: r.pages.map(p => ({ ...p, retrievedAt: '2026-08-01T00:00:00.000Z' })) }));
    mount({ api: fakeCaptureApi({ records: [...oldRecords, busy] }) });
    await waitFor(() => captureBox('team-99-2026-2027'));
    const box = captureBox('team-99-2026-2027')!;
    expect(box.disabled).toBe(true);
    expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toMatch(/still running/);
    expect(document.body.textContent).toMatch(/This capture is 65 days old\. Times may be out of date/);
    expect(captureBox(A)!.disabled).toBe(false);
  });

  it('shows how to crawl when no team capture exists', async () => {
    mount({ api: fakeCaptureApi({ records: [] }) });
    await waitFor(() => /No crawled teams yet/.test(document.body.textContent ?? ''));
    expect(document.body.textContent).toContain('Multi-team crawl');
    expect(button('Next')!.disabled).toBe(true);
  });

  it('reads the picked captures only, creates a workspace with an unused id, and reports it', async () => {
    const { api, restore, onCreated } = mount({ existing: ['existing-workspace', 'another'] });
    await waitFor(() => captureBox(A));
    await click(captureBox(A)!);
    await click(captureBox(B)!);
    expect(document.body.textContent).toContain('2 teams picked.');
    await click(button('Next')!);

    // Scoring: nothing is chosen for the user, and Next waits for a choice.
    const select = q<HTMLSelectElement>('#tmeet-scoring-select')!;
    expect(select.value).toBe('');
    expect(button('Next')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Short course yards (SCY)');
    expect(document.body.textContent).toContain('not supported yet');
    // Exhibition swims are included by default, and the line says what turning it off does.
    const exhibition = q<HTMLInputElement>('#tmeet-exhibition')!;
    expect(exhibition.checked).toBe(true);
    expect(document.body.textContent).toContain('Turning this off drops those events entirely');
    await choose(select, 'nsisc');
    await click(button('Next')!);

    const create = await waitFor(() => {
      const b = button('Create theoretical meet');
      return b && !b.disabled ? b : null;
    });
    // Only the picked captures were read, in the order picked. The list was fetched once.
    expect(api.parseCalls).toEqual([A, B]);
    expect(api.listCalls).toBe(1);
    expect(document.body.textContent).toContain('This is not a real meet');
    // Relays are on by default (NSISC has a relay program), so the caveat says they are estimates.
    expect(document.body.textContent).toContain('Relays are estimates');
    expect(document.body.textContent).not.toContain('Relays are not included');
    expect(document.body.textContent).toContain('all-time bests');
    expect(restore).not.toHaveBeenCalled();

    await click(create);
    await waitFor(() => onCreated.mock.calls.length > 0);
    expect(restore).toHaveBeenCalledTimes(1);
    const payload = restore.mock.calls[0][0];
    expect(['existing-workspace', 'another']).not.toContain(payload.id);
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(isTheoreticalMeet(payload)).toBe(true);
    expect(payload.menResults.length).toBeGreaterThan(0);
    expect(payload.menResults.every(row => row.id.includes(payload.id))).toBe(true);
    expect(payload.conference).toBe('NSISC');
    expect(onCreated.mock.calls[0][0].id).toBe(payload.id);
  });

  it('keeps Create off while a team is unread, and offers Retry for a team that failed', async () => {
    const api = fakeCaptureApi({ failParseOnce: [B] });
    const { restore } = mount({ api });
    await waitFor(() => captureBox(A));
    await click(captureBox(A)!);
    await click(captureBox(B)!);
    await click(button('Next')!);
    await choose(q<HTMLSelectElement>('#tmeet-scoring-select')!, 'nsisc');
    await click(button('Next')!);

    const retry = await waitFor(() => button('Retry this team'));
    expect(q('[role="alert"]')?.textContent).toContain('Something went wrong. Try again.');
    expect(button('Create theoretical meet')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('A team could not be read.');
    expect(restore).not.toHaveBeenCalled();

    await click(retry);
    const create = await waitFor(() => {
      const b = button('Create theoretical meet');
      return b && !b.disabled ? b : null;
    });
    expect(api.parseCalls).toEqual([A, B, B]);
    expect(create.disabled).toBe(false);
  });

  it('says in plain words when a roster page did not parse, shows the builder text, and offers no Create', async () => {
    const records = await fixtureRecords();
    const api = fakeCaptureApi({ records });
    const parse = api.parseCapture.bind(api);
    api.parseCapture = async id => ({ ...(await parse(id)), rosters: [] });
    mount({ api });
    await waitFor(() => captureBox(A));
    await click(captureBox(A)!);
    await click(button('Next')!);
    await choose(q<HTMLSelectElement>('#tmeet-scoring-select')!, 'nsisc');
    await click(button('Next')!);
    await waitFor(() => /A roster page was stored but could not be read. Crawl the team again./.test(document.body.textContent ?? ''));
    expect(q('[role="alert"]')?.textContent).toContain('only 0 parsed');
    expect(button('Create theoretical meet')!.disabled).toBe(true);
  });

  it('does not close while the workspace is being created', async () => {
    let release: (w: Workspace) => void = () => undefined;
    const pending = new Promise<Workspace>(resolve => {
      release = resolve;
    });
    const { onClose, onCreated } = mount({ restore: () => pending });
    await waitFor(() => captureBox(A));
    await click(captureBox(A)!);
    await click(button('Next')!);
    await choose(q<HTMLSelectElement>('#tmeet-scoring-select')!, 'nsisc');
    await click(button('Next')!);
    const create = await waitFor(() => {
      const b = button('Create theoretical meet');
      return b && !b.disabled ? b : null;
    });
    await click(create);
    await waitFor(() => button('Creating...'));
    expect(button('Cancel')!.disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      release({ id: 'saved', name: 'saved' } as unknown as Workspace);
    });
    await waitFor(() => onCreated.mock.calls.length > 0);
  });
});

describe('fixtureParse', () => {
  it('returns the stamps the data layer verifies against', async () => {
    const parse = await fixtureParse(A);
    expect(parse.storedPages?.length).toBeGreaterThan(0);
  });
});
