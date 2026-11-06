import { swimmerLabel, teamLabel } from '../shared/names';
import { simulatorSettingsFromRulePreset } from '@omniswim/swimcloud/browser';
import type { ParityReport, SimulatorRuleSettings } from '@omniswim/swimcloud/browser';
import type { CompleteRulePreset } from '@omniswim/engine';
import type { AutoBuildStatusMessage, PanelUiActionMessage, ScorerTagStateMessage, ThemeStateMessage } from '../shared/panelProtocol';
import { bindTheme, createAccentSync, tokenCss } from '../shared/theme';
import type { ThemeController } from '../shared/theme';

export interface PagePanel {
  readonly host: HTMLElement;
  update(parity: ParityReport | null, compatibilityError?: string): void;
  updateScorers(state: ScorerTagStateMessage | null, send: (action: PanelUiActionMessage) => void): void;
  setApplyStatus(status: string): void;
  /** One line about an AutoBuilder run in the docked dashboard. `null` clears it. The host also carries the status in `data-osx-auto-build`. */
  setAutoBuildStatus(message: AutoBuildStatusMessage | null): void;
  /**
   * The coach's theme and accent (D6 section 5). The panel carries the `--osx-*` tokens itself, in its closed root, so the page's styles cannot reach it.
   * The host mirrors the resolved theme in `data-osx-theme`, because a closed root cannot be queried. `null` goes back to light with no accent.
   */
  setThemeState(message: ThemeStateMessage | null): void;
  disconnect(): void;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The status line. It states the run's state in words and never by colour alone. */
export function autoBuildStatusText(message: AutoBuildStatusMessage): string {
  switch (message.status) {
    case 'running': return `AutoBuilder running: ${seconds(message.elapsedMs)} of ${seconds(message.limitMs)}`;
    case 'done': return `AutoBuilder finished in ${seconds(message.elapsedMs)}`;
    case 'cancelled': return `AutoBuilder cancelled after ${seconds(message.elapsedMs)}`;
    case 'failed': return `AutoBuilder stopped with an error after ${seconds(message.elapsedMs)}`;
  }
}

// The font is set on `.panel`, inside the closed root. A rule on the host (`:host`) loses to the page's own rules for that element, so the page's serif would reach the panel.
const css = tokenCss('.panel') + `:host{all:initial;color:var(--osx-fg,CanvasText);font:14px/1.45 system-ui,sans-serif}*{box-sizing:border-box}.panel{font:14px/1.45 var(--osx-font,system-ui,sans-serif);border:1px solid var(--osx-border,GrayText);border-radius:8px;background:var(--osx-bg,Canvas);padding:12px;min-width:220px;max-width:300px;color:var(--osx-fg,CanvasText)}.head{display:flex;justify-content:space-between;align-items:center;gap:12px}h2{font-size:16px;margin:0}button,select{font:inherit;color:inherit;background:var(--osx-bg,Canvas);border:1px solid var(--osx-border,GrayText);border-radius:5px;padding:4px 8px;cursor:pointer}.body[hidden]{display:none}.error{color:var(--osx-bad,Mark)}p{margin:10px 0 0}.group{border-top:1px solid var(--osx-border,GrayText);margin-top:10px;padding-top:8px}.row{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:6px 0}.row label{min-width:0}.row select{max-width:140px}.warning{background:var(--osx-warn-bg);color:var(--osx-warn-fg);padding:2px 5px;border-radius:4px}.cut-row{margin:6px 0;padding:6px 0 0;border-top:1px solid var(--osx-border,GrayText);font-size:12px}.cut-name{display:block;font-weight:600;font-size:13px;overflow-wrap:anywhere}.cut-line{margin:2px 0 0;overflow-wrap:anywhere}.cut-label{font-weight:600}.cut-badge{display:inline-block;margin-left:4px;padding:0 4px;border:1px solid var(--osx-border,GrayText);border-radius:4px;font-size:11px}.cut-note{display:block;opacity:.85}`;

function appendRulePresetPicker(doc: Document, scorer: HTMLElement, state: ScorerTagStateMessage, send: (action: PanelUiActionMessage) => void, apply: (settings: SimulatorRuleSettings | null) => void, applyStatus: string): void {
  const label = doc.createElement('label'); label.textContent = 'OmniSwim scoring rules';
  const select = doc.createElement('select'); select.setAttribute('aria-label', 'Choose OmniSwim scoring rules');
  const blank = doc.createElement('option'); blank.value = ''; blank.textContent = 'Choose a rule preset'; select.append(blank);
  for (const choice of state.rulePresetChoices ?? []) {
    const option = doc.createElement('option'); option.value = JSON.stringify(choice.ref); option.textContent = choice.label; select.append(option);
  }
  select.value = state.rulePresetRef ? JSON.stringify(state.rulePresetRef) : '';
  select.addEventListener('change', () => {
    const choice = state.rulePresetChoices?.find(c => JSON.stringify(c.ref) === select.value);
    if (choice) send({ kind: 'scorer-tag-action', action: 'choose-rule-preset', rulePresetRef: choice.ref });
  });
  scorer.append(label, select);
  const mapping = state.rulePreset ? simulatorSettingsFromRulePreset(state.rulePreset as CompleteRulePreset) : undefined;
  const preview = doc.createElement('p'); preview.dataset.osxApplyPreview = '';
  if (!mapping) preview.textContent = 'Select a resolvable rule preset to preview page settings.';
  else if (mapping.ok) preview.textContent = `Apply will write: ${Object.entries(mapping.settings).map(([key, value]) => `${key}=${value}`).join(', ')}.`;
  else preview.textContent = `Cannot apply: ${mapping.refusals.map(r => `${r.setting}: ${r.reason}`).join(' ')}`;
  const button = doc.createElement('button'); button.type = 'button'; button.textContent = 'Apply'; button.setAttribute('aria-label', 'Apply rule preset to SwimCloud');
  button.addEventListener('click', () => apply(mapping?.ok ? mapping.settings : null));
  scorer.append(button, preview);
  if (applyStatus) { const status = doc.createElement('p'); status.dataset.osxApplyStatus = ''; status.setAttribute('aria-live', 'polite'); status.textContent = applyStatus; scorer.append(status); }
  if (!state.rulePresetRef) { const prompt = doc.createElement('p'); prompt.textContent = 'Choose an OmniSwim rule preset to score scorer tags and suggest rosters.'; scorer.append(prompt); }
}

function renderCutTagRow(doc: Document, item: NonNullable<ScorerTagStateMessage['cutTags']>[number]): HTMLElement {
  const row = doc.createElement('div'); row.className = 'cut-row'; row.dataset.osxCutRow = '';
  const name = doc.createElement('strong'); name.className = 'cut-name'; name.textContent = item.swimmerName;
  const real = cutLine(doc, 'Real SCY', item.real);
  const estimated = cutLine(doc, 'Estimated LCM', item.estimated);
  if (item.estimatedIsEstimate) {
    const badge = doc.createElement('span'); badge.className = 'cut-badge'; badge.textContent = 'est.'; estimated.append(badge);
    const provenance = doc.createElement('small'); provenance.className = 'cut-note'; provenance.textContent = item.estimatedProvenance ?? 'Tool-derived provenance'; estimated.append(provenance);
  }
  row.append(name, real, estimated); return row;
}

/** One labelled line of a cut-tag card: "Real SCY: <value>". The value wraps under the full panel width, not a third of it. */
function cutLine(doc: Document, label: string, value: string): HTMLElement {
  const line = doc.createElement('div'); line.className = 'cut-line';
  const caption = doc.createElement('span'); caption.className = 'cut-label'; caption.textContent = `${label}: `;
  const text = doc.createElement('span'); text.className = 'cut-tag'; text.textContent = value;
  line.append(caption, text); return line;
}

type SuggestionResult = NonNullable<ScorerTagStateMessage['suggestions']>[number]['result'];

/** One opponent's suggested roster (R70): the roster, its absent reason, or its error code. Text only. */
function renderSuggestion(doc: Document, state: ScorerTagStateMessage, result: SuggestionResult): HTMLElement {
  const summary = doc.createElement('p'); summary.dataset.osxSuggestion = '';
  if (result.kind === 'suggested') {
    const names = result.swimmerIds.map(id => swimmerLabel(id, state.swimmers.find(s => s.id === id)?.name));
    summary.textContent = `Suggested: ${names.join(', ')} · ${result.points} points · ${result.spots.numerator}/${result.spots.denominator} spots · ${result.method}`;
  } else if (result.kind === 'absent') {
    summary.textContent = `Suggested roster unavailable: ${result.reason}`;
  } else {
    summary.className = 'error'; summary.setAttribute('role', 'alert'); summary.textContent = `Suggestion error ${result.code}${result.subject ? ` (${result.subject})` : ''}`;
  }
  return summary;
}

function renderCutTags(doc: Document, state: ScorerTagStateMessage | null, open: boolean): HTMLElement {
  const details = doc.createElement('details'); details.open = open; details.dataset.osxCutTags = '';
  const summary = doc.createElement('summary'); summary.textContent = 'Cut tags'; details.append(summary);
  const rows = state?.cutTags ?? [];
  if (!rows.length) { const empty = doc.createElement('p'); empty.textContent = 'No meet swims to tag'; details.append(empty); }
  for (const teamId of [...new Set(rows.map(r => r.teamId))]) {
    const teamRows = rows.filter(r => r.teamId === teamId);
    const group = doc.createElement('div'); group.className = 'group';
    const teamHeading = doc.createElement('strong'); teamHeading.textContent = teamLabel(teamId, teamRows[0]?.teamName); group.append(teamHeading);
    for (const eventKey of [...new Set(teamRows.map(r => r.eventKey))]) {
      const heading = doc.createElement('p'); heading.textContent = eventKey; group.append(heading);
      for (const item of teamRows.filter(r => r.eventKey === eventKey)) group.append(renderCutTagRow(doc, item));
    }
    details.append(group);
  }
  return details;
}

function renderAthleteOutlook(doc: Document, state: ScorerTagStateMessage | null, open: boolean): HTMLElement {
  const details = doc.createElement('details'); details.open = open; details.dataset.osxAthleteOutlook = '';
  const summary = doc.createElement('summary'); summary.textContent = 'Athlete outlook'; details.append(summary);
  const planner = state?.planner;
  if (!planner) { const pending = doc.createElement('p'); pending.textContent = 'Choose a session preset and scoring rules to calculate the outlook.'; details.append(pending); return details; }
  for (const warning of planner.violations) { const row = doc.createElement('p'); row.className = 'warning'; row.textContent = warning; details.append(row); }
  for (const item of planner.perSwimmer) {
    const swimmer = state?.swimmers.find(s => s.id === item.swimmerId);
    const group = doc.createElement('div'); group.className = 'group';
    const heading = doc.createElement('strong'); heading.textContent = swimmerLabel(item.swimmerId, swimmer?.name); group.append(heading);
    if (item.sessions.length === 0) { const pending = doc.createElement('p'); pending.textContent = 'No scheduled sessions are available for this swimmer.'; group.append(pending); }
    for (const session of item.sessions) { const row = doc.createElement('p'); row.textContent = `Day ${session.session.day}, ${session.session.slot}: ${session.races} races · ${session.eventKeys.join(', ')}`; group.append(row); }
    details.append(group);
  }
  return details;
}

function renderMeetSchedule(doc: Document, state: ScorerTagStateMessage | null, open: boolean, send: (action: PanelUiActionMessage) => void): HTMLElement {
  const details = doc.createElement('details'); details.open = open; details.dataset.osxMeetSchedule = '';
  const summary = doc.createElement('summary'); summary.textContent = 'Meet schedule'; details.append(summary);
  const saved = state?.sessionSchedule;
  if (saved?.error) { const error = doc.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert'); error.textContent = saved.error; details.append(error); }
  if (!saved?.preset) {
    const prompt = doc.createElement('p'); prompt.textContent = saved?.note ?? 'Choose a session preset in the docked dashboard before editing the schedule.'; details.append(prompt); return details;
  }
  const editor = doc.createElement('textarea'); editor.setAttribute('aria-label', 'Edit meet schedule JSON'); editor.rows = 9; editor.style.cssText = 'display:block;width:100%;max-width:100%;font:12px/1.4 monospace;color:inherit;background:var(--osx-bg,Canvas);border:1px solid var(--osx-border,GrayText);';
  editor.value = JSON.stringify(saved.preset, null, 2); details.append(editor);
  const save = doc.createElement('button'); save.type = 'button'; save.textContent = 'Save meet schedule';
  save.addEventListener('click', () => {
    try { send({ kind: 'session-preset-edit', preset: JSON.parse(editor.value) as unknown }); }
    catch (error) { const message = doc.createElement('p'); message.className = 'error'; message.setAttribute('role', 'alert'); message.textContent = error instanceof Error ? error.message : String(error); details.querySelector('[data-osx-schedule-local-error]')?.remove(); message.dataset.osxScheduleLocalError = ''; details.append(message); }
  });
  details.append(save);
  return details;
}

function attach(doc: Document, anchor: Element, apply: (settings: SimulatorRuleSettings | null) => void): PagePanel {
  const host = doc.createElement('aside');
  host.dataset.osxPagePanel = '';
  host.style.cssText = 'all:initial;display:block;position:relative;z-index:1;margin:12px 0;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style'); style.textContent = css;
  const panel = doc.createElement('section'); panel.className = 'panel';
  // Light until the dashboard says otherwise. The tokens and the theme attribute live on the panel inside the closed root.
  const themeController: ThemeController = bindTheme(panel, { preference: 'light', onChange: (resolved) => { host.dataset.osxTheme = resolved; } });
  const accent = createAccentSync(panel);
  const heading = doc.createElement('div'); heading.className = 'head';
  const title = doc.createElement('h2'); title.textContent = 'OmniSwim';
  const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.textContent = 'Collapse'; toggle.setAttribute('aria-expanded', 'true');
  const body = doc.createElement('div'); body.className = 'body';
  const parity = doc.createElement('p'); parity.setAttribute('aria-live', 'polite'); parity.dataset.osxParity = '';
  const error = doc.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert'); error.dataset.osxCompatibilityError = '';
  const autoStatus = doc.createElement('p'); autoStatus.setAttribute('aria-live', 'polite'); autoStatus.dataset.osxAutoBuildStatus = ''; autoStatus.hidden = true;
  const scorer = doc.createElement('section'); scorer.dataset.osxScorerTags = '';
  let applyStatus = '';
  let lastState: ScorerTagStateMessage | null = null;
  let lastSend: (action: PanelUiActionMessage) => void = () => undefined;
  toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Collapse' : 'Expand'; body.hidden = !open; });
  heading.append(title, toggle); body.append(parity, error, autoStatus, scorer); panel.append(heading, body); root.append(style, panel);
  // eslint-disable-next-line complexity -- reason: one render pass keeps all existing panel sections synchronized with one trusted state.
  const renderScorers = (state: ScorerTagStateMessage | null, send: (action: PanelUiActionMessage) => void): void => {
    lastState = state; lastSend = send;
    const cutTagsOpen = scorer.querySelector<HTMLDetailsElement>('[data-osx-cut-tags]')?.open ?? true;
    const outlookOpen = scorer.querySelector<HTMLDetailsElement>('[data-osx-athlete-outlook]')?.open ?? true;
    const scheduleOpen = scorer.querySelector<HTMLDetailsElement>('[data-osx-meet-schedule]')?.open ?? true;
    scorer.replaceChildren();
    scorer.append(renderCutTags(doc, state, cutTagsOpen));
    scorer.append(renderAthleteOutlook(doc, state, outlookOpen));
    scorer.append(renderMeetSchedule(doc, state, scheduleOpen, send));
    const title = doc.createElement('h3'); title.textContent = 'Scorer tags'; title.style.cssText = 'font-size:14px;margin:14px 0 6px'; scorer.append(title);
    if (!state) { const waiting = doc.createElement('p'); waiting.textContent = 'Loading saved swimmer tags…'; scorer.append(waiting); return; }
    if (state.error) { const msg = doc.createElement('p'); msg.className = 'error'; msg.dataset.osxTagError = ''; msg.setAttribute('role', 'alert'); msg.textContent = state.error; scorer.append(msg); }
    appendRulePresetPicker(doc, scorer, state, send, apply, applyStatus);
    if (!state.ownTeamId) {
      const prompt = doc.createElement('p'); prompt.textContent = 'Choose your team before tagging scorers.'; scorer.append(prompt);
      const select = doc.createElement('select'); select.setAttribute('aria-label', 'Choose your team');
      const blank = doc.createElement('option'); blank.value = ''; blank.textContent = 'Choose your team'; select.append(blank);
      for (const team of state.teams) { const opt = doc.createElement('option'); opt.value = team.id; opt.textContent = team.name; select.append(opt); }
      select.addEventListener('change', () => { if (select.value) send({ kind: 'scorer-tag-action', action: 'choose-team', teamId: select.value }); }); scorer.append(select); return;
    }
    if (!state.rulePresetRef) return;
    for (const team of state.teams) {
      const teamSwimmers = state.swimmers.filter(s => s.teamId === team.id);
      const genders = [...new Set([...teamSwimmers.map(s => s.gender || 'Unknown'), ...(state.suggestions ?? []).filter(s => s.teamId === team.id).map(s => s.gender)])].sort();
      for (const gender of genders) {
        const group = doc.createElement('div'); group.className = 'group'; const heading = doc.createElement('strong');
        const counted = state.tags.filter(t => t.teamId === team.id && t.role === 'scorer' && teamSwimmers.some(s => s.id === t.swimmerId && (s.gender || 'Unknown') === gender)).length;
        heading.textContent = `${team.name} · ${gender}${team.id === state.ownTeamId ? ` (${counted}${state.scoringTeamSize === undefined ? ' tagged scorers' : ` / ${state.scoringTeamSize} roster spots`})` : ''}`; group.append(heading);
        if (team.id !== state.ownTeamId) {
          const suggestion = state.suggestions?.find(s => s.teamId === team.id && s.gender === gender);
          if (suggestion) group.append(renderSuggestion(doc, state, suggestion.result));
        }
        for (const swimmer of teamSwimmers.filter(s => (s.gender || 'Unknown') === gender)) {
          const row = doc.createElement('div'); row.className = 'row'; const name = doc.createElement('label'); name.textContent = swimmer.name || swimmer.id;
          const select = doc.createElement('select'); select.setAttribute('aria-label', `${swimmer.name || swimmer.id} scorer role`);
          const current = state.tags.find(t => t.teamId === swimmer.teamId && t.swimmerId === swimmer.id)?.role ?? '';
          for (const [value, label] of [['', 'Auto'], ['scorer', 'Scorer'], ['non-scorer', 'Non-scorer'], ['exhibition', 'Exhibition']] as const) { const opt = doc.createElement('option'); opt.value = value; opt.textContent = label; select.append(opt); }
          select.value = current;
          select.addEventListener('change', () => send(select.value ? { kind: 'scorer-tag-action', action: 'set-role', teamId: swimmer.teamId, swimmerId: swimmer.id, role: select.value as 'scorer' | 'non-scorer' | 'exhibition' } : { kind: 'scorer-tag-action', action: 'clear-role', teamId: swimmer.teamId, swimmerId: swimmer.id }));
          row.append(name, select); group.append(row);
        }
        scorer.append(group);
      }
    }
    for (const warning of state.warnings) { const item = doc.createElement('p'); item.className = 'warning'; item.textContent = warning; scorer.append(item); }
  };
  anchor.insertAdjacentElement('afterend', host);
  return {
    host,
    update(report, message) {
      parity.textContent = report === null ? 'Waiting for simulator results' : report.kind === 'not_observed' ? 'Not observed' : report.matches ? 'Matches SwimCloud' : `${report.differingEvents.length} differing events`;
      error.textContent = message ?? '';
    },
    updateScorers: renderScorers,
    setApplyStatus(status) { applyStatus = status; renderScorers(lastState, lastSend); },
    setAutoBuildStatus(message) {
      // Text only, and no re-render of the scorer section: a running build reports several times a second.
      autoStatus.hidden = message === null;
      autoStatus.textContent = message === null ? '' : autoBuildStatusText(message);
      if (message === null) delete host.dataset.osxAutoBuild; else host.dataset.osxAutoBuild = message.status;
    },
    setThemeState(message) {
      themeController.setPreference(message === null ? 'light' : message.preference);
      accent.set(message?.accent);
    },
    disconnect() { accent.dispose(); themeController.dispose(); host.remove(); },
  };
}

/** Watches only the simulator results table; keeps at most one closed-root panel across React replacement. */
export function mountPagePanel(doc: Document, getState: () => { parity: ParityReport | null; error?: string }, selector = '#simulator table'): { refresh(): void; setScorerState(state: ScorerTagStateMessage): void; onScorerAction(send: (action: PanelUiActionMessage) => void): void; onApplyRule(apply: (settings: SimulatorRuleSettings | null) => void): void; setApplyStatus(status: string): void; setAutoBuildStatus(message: AutoBuildStatusMessage | null): void; setThemeState(message: ThemeStateMessage | null): void; disconnect(): void } {
  let currentAnchor: Element | null = null;
  let panel: PagePanel | null = null;
  let scorerState: ScorerTagStateMessage | null = null;
  let scorerAction: (action: PanelUiActionMessage) => void = () => undefined;
  let applyRule: (settings: SimulatorRuleSettings | null) => void = () => undefined;
  let applyStatus = '';
  let autoBuildStatus: AutoBuildStatusMessage | null = null;
  let themeState: ThemeStateMessage | null = null;
  const sync = (): void => {
    const anchor = doc.querySelector(selector);
    if (anchor === currentAnchor && panel?.host.isConnected) { const s = getState(); panel.update(s.parity, s.error); panel.updateScorers(scorerState, scorerAction); return; }
    panel?.disconnect(); panel = null; currentAnchor = anchor;
    if (!anchor) return;
    panel = attach(doc, anchor, settings => applyRule(settings));
    if (applyStatus) panel.setApplyStatus(applyStatus);
    if (autoBuildStatus) panel.setAutoBuildStatus(autoBuildStatus);
    if (themeState) panel.setThemeState(themeState);
    const s = getState(); panel.update(s.parity, s.error); panel.updateScorers(scorerState, scorerAction);
  };
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(sync) : null;
  observer?.observe(doc.documentElement, { childList: true, subtree: true });
  sync();
  return { refresh: sync, setScorerState(state) { scorerState = state; sync(); }, onScorerAction(send) { scorerAction = send; sync(); }, onApplyRule(apply) { applyRule = apply; }, setApplyStatus(status) { applyStatus = status; panel?.setApplyStatus(status); }, setAutoBuildStatus(message) { autoBuildStatus = message; panel?.setAutoBuildStatus(message); }, setThemeState(message) { themeState = message; panel?.setThemeState(message); }, disconnect() { observer?.disconnect(); panel?.disconnect(); } };
}
