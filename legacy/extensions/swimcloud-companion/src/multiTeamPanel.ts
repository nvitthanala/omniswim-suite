/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The multi-team crawl panel: a button and a plain-DOM panel on `www.swimcloud.com`.
 * Impure and thin on purpose. It owns the DOM, the real clock and
 * `chrome.storage.local`; the loop is `./multiTeamDriver.ts`, the conversation
 * with the app is `./multiTeamApp.ts`, the one-crawl lock is `./crawlLock.ts`
 * and every string is `./multiTeamPanelModel.ts`.
 *
 * It runs in the content script because the fetches must be same-origin, in the
 * user's own browser session. `crawler-content.ts` hands it the real `fetchPage`,
 * the worker conversation, the shared pacing clock and the lock manager, so this
 * file adds no second copy of any of them.
 *
 * Styling follows the existing panels (`content.css`, `omniswim-crawler-panel__*`
 * classes). Nothing here is unit-tested; the manual checklist is in the
 * extension README.
 */

import { withCrawlLock, type CrawlLockManager } from './crawlLock';
import {
  resumeKeyForChoices,
  runMultiTeamCrawl,
  type MultiTeamControl,
  type MultiTeamDriverState,
  type MultiTeamFetchedPage,
  type MultiTeamPaceClock,
  type TeamSeasonChoice,
  type TeamSeasonOptionsReport,
} from './multiTeamDriver';
import type { MultiTeamApp } from './multiTeamApp';
import {
  defaultSeasonLabel,
  describeTargetInput,
  forgetButtonVisible,
  formatDriverState,
  formatScopeNote,
  formatSummary,
  multiTeamHostAllowed,
  readSavedSwimmerKeys,
  savedProgressStorageKey,
  type PastedTargets,
} from './multiTeamPanelModel';

const BUTTON_ID = 'omniswim-multiteam-button';
const PANEL_ID = 'omniswim-multiteam-panel';
const SKIP_VALUE = '';

/** What `crawler-content.ts` supplies. */
export interface MultiTeamPanelIo {
  /** One same-origin request. `undefined` is a network error or timeout. */
  fetchPage(url: string): Promise<MultiTeamFetchedPage | undefined>;
  /** Relay, open, mark and flush through the background worker. */
  readonly app: MultiTeamApp;
  /** The last request start time, shared with the meet crawl. */
  readonly paceClock: MultiTeamPaceClock;
  /** `navigator.locks`, or undefined when the browser has none. */
  readonly locks: CrawlLockManager | undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string): HTMLButtonElement {
  const b = element('button', undefined, label);
  b.type = 'button';
  return b;
}

function replaceChildrenWithLines(parent: HTMLElement, lines: readonly string[], className: string): void {
  parent.replaceChildren(...lines.map((line) => element('div', className, line)));
}

async function loadFinished(runKey: string): Promise<readonly string[]> {
  const key = savedProgressStorageKey(runKey);
  try {
    const stored = await chrome.storage.local.get([key]);
    return readSavedSwimmerKeys(stored[key]);
  } catch {
    return [];
  }
}

function saveFinished(runKey: string, keys: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [savedProgressStorageKey(runKey)]: [...keys] }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function clearFinished(runKey: string): Promise<void> {
  try {
    await chrome.storage.local.remove([savedProgressStorageKey(runKey)]);
  } catch {
    // Nothing to clear if storage is unreadable.
  }
}

/** Add the entry button. Safe to call once per page load. Hides itself on any host but www.swimcloud.com. */
export function mountMultiTeamCrawlButton(io: MultiTeamPanelIo): void {
  if (!multiTeamHostAllowed(location.hostname)) return;
  if (document.getElementById(BUTTON_ID) !== null) return;
  const entry = button('Multi-team crawl (Omniswim)');
  entry.id = BUTTON_ID;
  entry.setAttribute('aria-label', 'Crawl several teams and seasons into Omniswim Suite. Opens a panel. Several minutes, many requests.');
  entry.addEventListener('click', () => {
    if (document.getElementById(PANEL_ID) !== null) return;
    openPanel(io);
  });
  document.body.appendChild(entry);
}

function openPanel(io: MultiTeamPanelIo): void {
  const control: MultiTeamControl = { cancelled: false, paused: false };
  let running = false;
  let targets: PastedTargets = { teamIds: [], conferences: [], rejected: [] };
  /** Set while the driver waits for the season choice. */
  let finishChoice: ((choices: readonly TeamSeasonChoice[]) => void) | undefined;
  /** The selection "Forget saved progress" acts on: the dropdowns while choosing, else the last run's choices. */
  let currentSelection: () => string = () => '';
  let choosing = false;

  const root = element('div');
  root.id = PANEL_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Multi-team crawl');

  const title = element('div', 'omniswim-crawler-panel__title', 'Multi-team crawl');

  const inputLabel = element('label', 'omniswim-crawler-panel__line', 'Team links, one per line (or separated by spaces or commas)');
  const input = element('textarea', 'omniswim-multiteam__input');
  input.id = `${PANEL_ID}-input`;
  input.rows = 4;
  input.placeholder = 'https://www.swimcloud.com/team/412/';
  inputLabel.htmlFor = input.id;

  const scope = element('div', 'omniswim-crawler-panel__line omniswim-crawler-panel__resume', formatScopeNote());

  const parseButton = button('Parse links');
  const readButton = button('Read season lists');
  readButton.disabled = true;

  const parsed = element('div', 'omniswim-multiteam__block');
  const choices = element('div', 'omniswim-multiteam__block');
  const startButton = button('Start crawl');
  startButton.hidden = true;
  const forgetButton = button('Forget saved progress');
  forgetButton.hidden = true;

  const headline = element('div', 'omniswim-crawler-panel__line');
  headline.setAttribute('role', 'status');
  headline.setAttribute('aria-live', 'polite');
  const teamLines = element('div', 'omniswim-multiteam__block');
  const notice = element('div', 'omniswim-crawler-panel__line omniswim-crawler-panel__warn');
  const errors = element('div', 'omniswim-multiteam__block');
  const summary = element('div', 'omniswim-multiteam__block');
  const forgetNote = element('div', 'omniswim-crawler-panel__line omniswim-crawler-panel__resume');
  forgetNote.hidden = true;

  const pauseButton = button('Pause');
  pauseButton.hidden = true;
  const cancelButton = button('Close');
  const buttons = element('div', 'omniswim-crawler-panel__buttons');
  buttons.append(parseButton, readButton);
  const runButtons = element('div', 'omniswim-crawler-panel__buttons');
  runButtons.append(startButton, pauseButton, forgetButton, cancelButton);

  root.append(title, inputLabel, input, scope, buttons, parsed, choices, headline, teamLines, notice, errors, summary, forgetNote, runButtons);
  document.body.appendChild(root);
  input.focus();

  /** The button is hidden while a crawl runs past the choice: the driver re-saves its progress as it goes. */
  const updateForgetButton = (): void => {
    forgetButton.hidden = !forgetButtonVisible({ running, choosing, selectionKey: currentSelection() });
  };

  const close = (): void => {
    root.remove();
    document.getElementById(BUTTON_ID)?.focus();
  };

  // Escape closes the panel when no crawl is running. While one runs, Cancel is the deliberate way out.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !running) close();
  });

  const renderParsed = (): void => {
    const lines: HTMLElement[] = [];
    if (targets.teamIds.length > 0) {
      lines.push(element('div', 'omniswim-crawler-panel__line', `Teams to read: ${targets.teamIds.join(', ')}`));
    }
    for (const c of targets.conferences) {
      lines.push(element('div', 'omniswim-crawler-panel__line omniswim-crawler-panel__warn', `Conference ${c.text}: ${c.message}. Nothing is crawled for it.`));
    }
    for (const r of targets.rejected) {
      lines.push(element('div', 'omniswim-crawler-panel__line omniswim-crawler-panel__warn', `Skipped "${r.text}": ${r.message}.`));
    }
    if (lines.length === 0) lines.push(element('div', 'omniswim-crawler-panel__line', 'No links found.'));
    parsed.replaceChildren(...lines);
    readButton.disabled = running || targets.teamIds.length === 0;
  };

  parseButton.addEventListener('click', () => {
    targets = describeTargetInput(input.value);
    renderParsed();
  });

  const render = (state: MultiTeamDriverState): void => {
    const lines = formatDriverState(state);
    headline.textContent = lines.headline;
    replaceChildrenWithLines(teamLines, lines.teams, 'omniswim-crawler-panel__line');
    notice.textContent = lines.notice;
    notice.hidden = lines.notice.length === 0;
    replaceChildrenWithLines(errors, lines.errors, 'omniswim-crawler-panel__line omniswim-crawler-panel__warn');
  };

  const askForSeasons = (reports: readonly TeamSeasonOptionsReport[]): Promise<readonly TeamSeasonChoice[]> =>
    new Promise((resolve) => {
      const selects = new Map<string, HTMLSelectElement>();
      const rows: HTMLElement[] = [];
      for (const report of reports) {
        if (report.options === undefined) continue;
        const row = element('div', 'omniswim-crawler-panel__line');
        const label = element('label', undefined, `Team ${report.teamId} season `);
        const select = element('select');
        select.id = `${PANEL_ID}-season-${report.teamId}`;
        label.htmlFor = select.id;
        const skip = element('option', undefined, 'Skip this team');
        skip.value = SKIP_VALUE;
        select.appendChild(skip);
        for (const option of report.options) {
          const o = element('option', undefined, option.selected ? `${option.label} (page's current season)` : option.label);
          o.value = option.label;
          select.appendChild(o);
        }
        select.value = defaultSeasonLabel(report.options);
        selects.set(report.teamId, select);
        row.append(label, select);
        rows.push(row);
      }
      const pick = (): TeamSeasonChoice[] => {
        const picked: TeamSeasonChoice[] = [];
        for (const [teamId, select] of selects) {
          if (select.value !== SKIP_VALUE) picked.push({ teamId, seasonLabel: select.value });
        }
        return picked;
      };
      choices.replaceChildren(...rows);
      startButton.hidden = false;
      choosing = true;
      currentSelection = () => resumeKeyForChoices(reports, pick());
      updateForgetButton();
      const first = [...selects.values()][0];
      if (first !== undefined) first.focus();
      finishChoice = (picked) => {
        finishChoice = undefined;
        startButton.hidden = true;
        choices.replaceChildren();
        const key = resumeKeyForChoices(reports, picked);
        currentSelection = () => key;
        choosing = false;
        updateForgetButton();
        resolve(picked);
      };
      startButton.onclick = () => finishChoice?.(pick());
    });

  forgetButton.addEventListener('click', () => {
    const key = currentSelection();
    forgetNote.hidden = false;
    if (key === '') {
      forgetNote.textContent = 'There is no selection to forget saved progress for.';
      return;
    }
    void clearFinished(key).then(() => {
      forgetNote.textContent = 'Saved progress for this selection was cleared. The next crawl of it fetches every swimmer again.';
    });
  });

  const endRun = (): void => {
    running = false;
    choosing = false;
    pauseButton.hidden = true;
    startButton.hidden = true;
    updateForgetButton();
    cancelButton.textContent = 'Close';
    cancelButton.disabled = false;
    parseButton.disabled = false;
    input.disabled = false;
    readButton.disabled = targets.teamIds.length === 0;
  };

  readButton.addEventListener('click', () => {
    if (running || targets.teamIds.length === 0) return;
    running = true;
    control.cancelled = false;
    control.paused = false;
    pauseButton.textContent = 'Pause';
    cancelButton.disabled = false;
    readButton.disabled = true;
    parseButton.disabled = true;
    input.disabled = true;
    pauseButton.hidden = false;
    forgetNote.hidden = true;
    updateForgetButton();
    cancelButton.textContent = 'Cancel';
    summary.replaceChildren();
    io.app.reset();

    // One crawl at a time, in every tab. The lock is held until the run ends.
    void withCrawlLock(io.locks, () =>
      runMultiTeamCrawl(
        {
          fetchPage: (url) => io.fetchPage(url),
          relay: (request) => io.app.relay(request),
          openCapture: (subject, planned) => io.app.openCapture(subject, planned),
          markCapture: (subject, completeness, label) => io.app.markCapture(subject, completeness, label),
          flushDownloads: (subjects) => io.app.flushDownloads(subjects),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
          isoNow: () => new Date().toISOString(),
          paceClock: io.paceClock,
          loadFinished,
          saveFinished,
          clearFinished,
          onProgress: render,
          chooseSeasons: askForSeasons,
          control,
        },
        { teamIds: targets.teamIds },
      ),
    )
      .then((outcome) => {
        if (outcome.acquired) replaceChildrenWithLines(summary, formatSummary(outcome.value), 'omniswim-crawler-panel__line');
        else replaceChildrenWithLines(summary, [outcome.message], 'omniswim-crawler-panel__line omniswim-crawler-panel__warn');
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        replaceChildrenWithLines(
          summary,
          [`The crawl stopped on an unexpected error: ${detail}`, 'Nothing already saved is lost. Finished swimmers are remembered.'],
          'omniswim-crawler-panel__line omniswim-crawler-panel__warn',
        );
      })
      .finally(endRun);
  });

  pauseButton.addEventListener('click', () => {
    control.paused = !control.paused;
    pauseButton.textContent = control.paused ? 'Resume' : 'Pause';
  });

  cancelButton.addEventListener('click', () => {
    if (!running) {
      close();
      return;
    }
    control.cancelled = true;
    control.paused = false;
    cancelButton.disabled = true;
    // A driver waiting for the season choice would wait forever otherwise.
    finishChoice?.([]);
  });
}
