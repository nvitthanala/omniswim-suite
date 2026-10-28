import type { ParityReport } from '@omniswim/swimcloud/browser';
import type { ScorerTagActionMessage, ScorerTagStateMessage } from '../shared/panelProtocol';

export interface PagePanel {
  readonly host: HTMLElement;
  update(parity: ParityReport | null, compatibilityError?: string): void;
  updateScorers(state: ScorerTagStateMessage | null, send: (action: ScorerTagActionMessage) => void): void;
  disconnect(): void;
}

const css = `:host{all:initial;color:var(--osx-fg,CanvasText);font:14px/1.45 system-ui,sans-serif}*{box-sizing:border-box}.panel{border:1px solid var(--osx-border,GrayText);border-radius:8px;background:var(--osx-bg,Canvas);padding:12px;min-width:220px;max-width:300px;color:inherit}.head{display:flex;justify-content:space-between;align-items:center;gap:12px}h2{font-size:16px;margin:0}button,select{font:inherit;color:inherit;background:var(--osx-bg,Canvas);border:1px solid var(--osx-border,GrayText);border-radius:5px;padding:4px 8px;cursor:pointer}.body[hidden]{display:none}.error{color:var(--osx-bad,Mark)}p{margin:10px 0 0}.group{border-top:1px solid var(--osx-border,GrayText);margin-top:10px;padding-top:8px}.row{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:6px 0}.row label{min-width:0}.row select{max-width:140px}.warning{background:var(--osx-warn-bg);color:var(--osx-warn-fg);padding:2px 5px;border-radius:4px}.cut-row{display:grid;grid-template-columns:minmax(55px,1fr) 1fr 1fr;gap:5px;margin:6px 0;font-size:12px}.cut-head{font-weight:600}.cut-tag{overflow-wrap:anywhere}`;

function appendRulePresetPicker(doc: Document, scorer: HTMLElement, state: ScorerTagStateMessage, send: (action: ScorerTagActionMessage) => void): void {
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
  if (!state.rulePresetRef) { const prompt = doc.createElement('p'); prompt.textContent = 'Choose an OmniSwim rule preset to score scorer tags and suggest rosters.'; scorer.append(prompt); }
}

function renderCutTagRow(doc: Document, item: NonNullable<ScorerTagStateMessage['cutTags']>[number]): HTMLElement {
  const row = doc.createElement('div'); row.className = 'cut-row';
  const name = doc.createElement('span'); name.className = 'cut-tag'; name.textContent = item.swimmerName;
  const real = doc.createElement('span'); real.className = 'cut-tag'; real.textContent = item.real;
  const estimated = doc.createElement('span'); estimated.className = 'cut-tag'; estimated.textContent = item.estimated;
  if (item.estimatedIsEstimate) {
    const badge = doc.createElement('span'); badge.textContent = ' est.'; estimated.append(badge);
    const provenance = doc.createElement('small'); provenance.textContent = item.estimatedProvenance ?? 'Tool-derived provenance'; estimated.append(doc.createElement('br'), provenance);
  }
  row.append(name, real, estimated); return row;
}

type SuggestionResult = NonNullable<ScorerTagStateMessage['suggestions']>[number]['result'];

/** One opponent's suggested roster (R70): the roster, its absent reason, or its error code. Text only. */
function renderSuggestion(doc: Document, state: ScorerTagStateMessage, result: SuggestionResult): HTMLElement {
  const summary = doc.createElement('p'); summary.dataset.osxSuggestion = '';
  if (result.kind === 'suggested') {
    const names = result.swimmerIds.map(id => state.swimmers.find(s => s.id === id)?.name ?? id);
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
    const teamHeading = doc.createElement('strong'); teamHeading.textContent = teamRows[0]?.teamName ?? teamId; group.append(teamHeading);
    for (const eventKey of [...new Set(teamRows.map(r => r.eventKey))]) {
      const heading = doc.createElement('p'); heading.textContent = eventKey; group.append(heading);
      const header = doc.createElement('div'); header.className = 'cut-row cut-head';
      for (const text of ['Swimmer', 'Real SCY', 'Estimated LCM']) { const cell = doc.createElement('span'); cell.textContent = text; header.append(cell); }
      group.append(header);
      for (const item of teamRows.filter(r => r.eventKey === eventKey)) group.append(renderCutTagRow(doc, item));
    }
    details.append(group);
  }
  return details;
}

function attach(doc: Document, anchor: Element): PagePanel {
  const host = doc.createElement('aside');
  host.dataset.osxPagePanel = '';
  host.style.cssText = 'all:initial;display:block;position:relative;z-index:1;margin:12px 0;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style'); style.textContent = css;
  const panel = doc.createElement('section'); panel.className = 'panel';
  const heading = doc.createElement('div'); heading.className = 'head';
  const title = doc.createElement('h2'); title.textContent = 'OmniSwim';
  const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.textContent = 'Collapse'; toggle.setAttribute('aria-expanded', 'true');
  const body = doc.createElement('div'); body.className = 'body';
  const parity = doc.createElement('p'); parity.setAttribute('aria-live', 'polite'); parity.dataset.osxParity = '';
  const error = doc.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert'); error.dataset.osxCompatibilityError = '';
  const scorer = doc.createElement('section'); scorer.dataset.osxScorerTags = '';
  toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Collapse' : 'Expand'; body.hidden = !open; });
  heading.append(title, toggle); body.append(parity, error, scorer); panel.append(heading, body); root.append(style, panel);
  const renderScorers = (state: ScorerTagStateMessage | null, send: (action: ScorerTagActionMessage) => void): void => {
    const cutTagsOpen = scorer.querySelector<HTMLDetailsElement>('[data-osx-cut-tags]')?.open ?? true;
    scorer.replaceChildren();
    scorer.append(renderCutTags(doc, state, cutTagsOpen));
    const title = doc.createElement('h3'); title.textContent = 'Scorer tags'; title.style.cssText = 'font-size:14px;margin:14px 0 6px'; scorer.append(title);
    if (!state) { const waiting = doc.createElement('p'); waiting.textContent = 'Loading saved swimmer tags…'; scorer.append(waiting); return; }
    if (state.error) { const msg = doc.createElement('p'); msg.className = 'error'; msg.dataset.osxTagError = ''; msg.setAttribute('role', 'alert'); msg.textContent = state.error; scorer.append(msg); }
    appendRulePresetPicker(doc, scorer, state, send);
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
    disconnect() { host.remove(); },
  };
}

/** Watches only the simulator results table; keeps at most one closed-root panel across React replacement. */
export function mountPagePanel(doc: Document, getState: () => { parity: ParityReport | null; error?: string }, selector = '#simulator table'): { refresh(): void; setScorerState(state: ScorerTagStateMessage): void; onScorerAction(send: (action: ScorerTagActionMessage) => void): void; disconnect(): void } {
  let currentAnchor: Element | null = null;
  let panel: PagePanel | null = null;
  let scorerState: ScorerTagStateMessage | null = null;
  let scorerAction: (action: ScorerTagActionMessage) => void = () => undefined;
  const sync = (): void => {
    const anchor = doc.querySelector(selector);
    if (anchor === currentAnchor && panel?.host.isConnected) { const s = getState(); panel.update(s.parity, s.error); panel.updateScorers(scorerState, scorerAction); return; }
    panel?.disconnect(); panel = null; currentAnchor = anchor;
    if (!anchor) return;
    panel = attach(doc, anchor);
    const s = getState(); panel.update(s.parity, s.error); panel.updateScorers(scorerState, scorerAction);
  };
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(sync) : null;
  observer?.observe(doc.documentElement, { childList: true, subtree: true });
  sync();
  return { refresh: sync, setScorerState(state) { scorerState = state; sync(); }, onScorerAction(send) { scorerAction = send; sync(); }, disconnect() { observer?.disconnect(); panel?.disconnect(); } };
}
