import type { ParityReport } from '@omniswim/swimcloud/browser';
import type { ScorerTagActionMessage, ScorerTagStateMessage } from '../shared/panelProtocol';

export interface PagePanel {
  readonly host: HTMLElement;
  update(parity: ParityReport | null, compatibilityError?: string): void;
  updateScorers(state: ScorerTagStateMessage | null, send: (action: ScorerTagActionMessage) => void): void;
  disconnect(): void;
}

const css = `:host{all:initial;color:var(--osx-fg,CanvasText);font:14px/1.45 system-ui,sans-serif}*{box-sizing:border-box}.panel{border:1px solid var(--osx-border,GrayText);border-radius:8px;background:var(--osx-bg,Canvas);padding:12px;min-width:220px;max-width:300px;color:inherit}.head{display:flex;justify-content:space-between;align-items:center;gap:12px}h2{font-size:16px;margin:0}button,select{font:inherit;color:inherit;background:var(--osx-bg,Canvas);border:1px solid var(--osx-border,GrayText);border-radius:5px;padding:4px 8px;cursor:pointer}.body[hidden]{display:none}.error{color:var(--osx-bad,Mark)}p{margin:10px 0 0}.group{border-top:1px solid var(--osx-border,GrayText);margin-top:10px;padding-top:8px}.row{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:6px 0}.row label{min-width:0}.row select{max-width:140px}.warning{background:var(--osx-warn-bg);color:var(--osx-warn-fg);padding:2px 5px;border-radius:4px}`;

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
    scorer.replaceChildren();
    const title = doc.createElement('h3'); title.textContent = 'Scorer tags'; title.style.cssText = 'font-size:14px;margin:14px 0 6px'; scorer.append(title);
    if (!state) { const waiting = doc.createElement('p'); waiting.textContent = 'Loading saved swimmer tags…'; scorer.append(waiting); return; }
    if (state.error) { const msg = doc.createElement('p'); msg.className = 'error'; msg.dataset.osxTagError = ''; msg.setAttribute('role', 'alert'); msg.textContent = state.error; scorer.append(msg); }
    if (!state.ownTeamId) {
      const prompt = doc.createElement('p'); prompt.textContent = 'Choose your team before tagging scorers.'; scorer.append(prompt);
      const select = doc.createElement('select'); select.setAttribute('aria-label', 'Choose your team');
      const blank = doc.createElement('option'); blank.value = ''; blank.textContent = 'Choose your team'; select.append(blank);
      for (const team of state.teams) { const opt = doc.createElement('option'); opt.value = team.id; opt.textContent = team.name; select.append(opt); }
      select.addEventListener('change', () => { if (select.value) send({ kind: 'scorer-tag-action', action: 'choose-team', teamId: select.value }); }); scorer.append(select); return;
    }
    for (const team of state.teams) {
      const teamSwimmers = state.swimmers.filter(s => s.teamId === team.id);
      const genders = [...new Set(teamSwimmers.map(s => s.gender || 'Unknown'))].sort();
      for (const gender of genders) {
        const group = doc.createElement('div'); group.className = 'group'; const heading = doc.createElement('strong');
        const counted = state.tags.filter(t => t.teamId === team.id && t.role === 'scorer' && teamSwimmers.some(s => s.id === t.swimmerId && (s.gender || 'Unknown') === gender)).length;
        heading.textContent = `${team.name} · ${gender}${team.id === state.ownTeamId ? ` (${counted}${state.scoringTeamSize === undefined ? ' tagged scorers' : ` / ${state.scoringTeamSize} roster spots`})` : ''}`; group.append(heading);
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
