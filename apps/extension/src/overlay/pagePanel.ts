import type { ParityReport } from '@omniswim/swimcloud/browser';

export interface PagePanel {
  readonly host: HTMLElement;
  update(parity: ParityReport | null, compatibilityError?: string): void;
  disconnect(): void;
}

const css = `:host{all:initial;color:var(--osx-fg,CanvasText);font:14px/1.45 system-ui,sans-serif}*{box-sizing:border-box}.panel{border:1px solid var(--osx-border,GrayText);border-radius:8px;background:var(--osx-bg,Canvas);padding:12px;min-width:220px;max-width:300px;color:inherit}.head{display:flex;justify-content:space-between;align-items:center;gap:12px}h2{font-size:16px;margin:0}button{font:inherit;color:inherit;background:var(--osx-bg,Canvas);border:1px solid var(--osx-border,GrayText);border-radius:5px;padding:4px 8px;cursor:pointer}.body[hidden]{display:none}.error{color:var(--osx-bad,Mark)}p{margin:10px 0 0}`;

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
  toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Collapse' : 'Expand'; body.hidden = !open; });
  heading.append(title, toggle); body.append(parity, error); panel.append(heading, body); root.append(style, panel);
  anchor.insertAdjacentElement('afterend', host);
  return {
    host,
    update(report, message) {
      parity.textContent = report === null ? 'Waiting for simulator results' : report.kind === 'not_observed' ? 'Not observed' : report.matches ? 'Matches SwimCloud' : `${report.differingEvents.length} differing events`;
      error.textContent = message ?? '';
    },
    disconnect() { host.remove(); },
  };
}

/** Watches only the simulator results table; keeps at most one closed-root panel across React replacement. */
export function mountPagePanel(doc: Document, getState: () => { parity: ParityReport | null; error?: string }, selector = '#simulator table'): { refresh(): void; disconnect(): void } {
  let currentAnchor: Element | null = null;
  let panel: PagePanel | null = null;
  const sync = (): void => {
    const anchor = doc.querySelector(selector);
    if (anchor === currentAnchor && panel?.host.isConnected) { const s = getState(); panel.update(s.parity, s.error); return; }
    panel?.disconnect(); panel = null; currentAnchor = anchor;
    if (!anchor) return;
    panel = attach(doc, anchor);
    const s = getState(); panel.update(s.parity, s.error);
  };
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(sync) : null;
  observer?.observe(doc.documentElement, { childList: true, subtree: true });
  sync();
  return { refresh: sync, disconnect() { observer?.disconnect(); panel?.disconnect(); } };
}
