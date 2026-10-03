/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The multi-team crawl panel: a button and a plain-DOM panel on any
 * www.swimcloud.com page. Impure and thin on purpose. It owns the DOM, the
 * real clock and `chrome.storage.local`; the loop is `./multiTeamDriver.ts`
 * and every string is `./multiTeamPanelModel.ts`.
 *
 * It runs in the content script because the fetches must be same-origin, in the
 * user's own browser session. `crawler-content.ts` hands it the real
 * `fetchPage` and the relay to the background worker, so this file adds no
 * second copy of either.
 *
 * Styling follows the existing panels (`content.css`, `omniswim-crawler-panel__*`
 * classes). Nothing here is unit-tested; the manual checklist is in the
 * extension README.
 */

import {
  runMultiTeamCrawl,
  type MultiTeamControl,
  type MultiTeamDriverState,
  type MultiTeamFetchedPage,
  type MultiTeamRelayOutcome,
  type MultiTeamRelayRequest,
  type TeamSeasonChoice,
  type TeamSeasonOptionsReport,
} from './multiTeamDriver';
import {
  defaultSeasonLabel,
  describeTargetInput,
  formatDriverState,
  formatScopeNote,
  formatSummary,
  type PastedTargets,
} from './multiTeamPanelModel';

const BUTTON_ID = 'omniswim-multiteam-button';
const PANEL_ID = 'omniswim-multiteam-panel';
/** `chrome.storage.local` key for the finished swimmer keys. Swimmer keys only. */
const FINISHED_STORAGE_KEY = 'omniswimMultiTeamFinishedSwimmers';
const SWIMMER_KEY = /^swimmer\|[1-9][0-9]{0,17}$/;
const SKIP_VALUE = '';

/** What `crawler-content.ts` supplies. */
export interface MultiTeamPanelIo {
  /** One same-origin request. `undefined` is a network error or timeout. */
  fetchPage(url: string): Promise<MultiTeamFetchedPage | undefined>;
  relay(request: MultiTeamRelayRequest): Promise<MultiTeamRelayOutcome>;
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

async function loadFinished(): Promise<readonly string[]> {
  try {
    const stored = await chrome.storage.local.get([FINISHED_STORAGE_KEY]);
    const value = stored[FINISHED_STORAGE_KEY];
    // Unreadable storage is "nothing finished": swimmers are fetched again, the safe error.
    return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string' && SWIMMER_KEY.test(k)) : [];
  } catch {
    return [];
  }
}

function saveFinished(keys: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [FINISHED_STORAGE_KEY]: [...keys] }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Add the entry button. Safe to call once per page load. */
export function mountMultiTeamCrawlButton(io: MultiTeamPanelIo): void {
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

  const headline = element('div', 'omniswim-crawler-panel__line');
  headline.setAttribute('role', 'status');
  headline.setAttribute('aria-live', 'polite');
  const teamLines = element('div', 'omniswim-multiteam__block');
  const notice = element('div', 'omniswim-crawler-panel__line omniswim-crawler-panel__warn');
  const errors = element('div', 'omniswim-multiteam__block');
  const summary = element('div', 'omniswim-multiteam__block');

  const pauseButton = button('Pause');
  pauseButton.hidden = true;
  const cancelButton = button('Close');
  const buttons = element('div', 'omniswim-crawler-panel__buttons');
  buttons.append(parseButton, readButton);
  const runButtons = element('div', 'omniswim-crawler-panel__buttons');
  runButtons.append(startButton, pauseButton, cancelButton);

  root.append(title, inputLabel, input, scope, buttons, parsed, choices, headline, teamLines, notice, errors, summary, runButtons);
  document.body.appendChild(root);
  input.focus();

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
      choices.replaceChildren(...rows);
      startButton.hidden = false;
      const first = [...selects.values()][0];
      if (first !== undefined) first.focus();
      finishChoice = (picked) => {
        finishChoice = undefined;
        startButton.hidden = true;
        choices.replaceChildren();
        resolve(picked);
      };
      startButton.onclick = () => {
        const picked: TeamSeasonChoice[] = [];
        for (const [teamId, select] of selects) {
          if (select.value !== SKIP_VALUE) picked.push({ teamId, seasonLabel: select.value });
        }
        finishChoice?.(picked);
      };
    });

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
    cancelButton.textContent = 'Cancel';
    summary.replaceChildren();

    void runMultiTeamCrawl(
      {
        fetchPage: (url) => io.fetchPage(url),
        relay: (request) => io.relay(request),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        isoNow: () => new Date().toISOString(),
        loadFinished,
        saveFinished,
        onProgress: render,
        chooseSeasons: askForSeasons,
        control,
      },
      { teamIds: targets.teamIds },
    )
      .then((result) => {
        replaceChildrenWithLines(summary, formatSummary(result), 'omniswim-crawler-panel__line');
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        replaceChildrenWithLines(summary, [`The crawl stopped on an unexpected error: ${detail}`, 'Nothing already saved is lost. Finished swimmers are remembered.'], 'omniswim-crawler-panel__line omniswim-crawler-panel__warn');
      })
      .finally(() => {
        running = false;
        pauseButton.hidden = true;
        cancelButton.textContent = 'Close';
        cancelButton.disabled = false;
        parseButton.disabled = false;
        input.disabled = false;
        readButton.disabled = targets.teamIds.length === 0;
      });
  });

  pauseButton.addEventListener('click', () => {
    control.paused = !control.paused;
    pauseButton.textContent = control.paused ? 'Resume' : 'Pause';
  });

  cancelButton.addEventListener('click', () => {
    if (!running) {
      root.remove();
      return;
    }
    control.cancelled = true;
    control.paused = false;
    cancelButton.disabled = true;
    // A driver waiting for the season choice would wait forever otherwise.
    finishChoice?.([]);
  });
}
