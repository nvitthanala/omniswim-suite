/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The stylesheet inside the overlay's shadow root (D3 section 4, traps 1 to 4).
 *
 * `all: initial` on the wrapper stops the page's inherited font, color and line-height from
 * leaking in (trap 2). Page rules cannot reach inside a shadow root, but inherited properties do
 * cross it. No font-face at-rule: it does not load in a shadow root, and the family name is reused
 * (trap 3). No `rem`: it follows the page's `html` font-size (trap 4). Sizes are px or em.
 */
import { tokenCss } from '../shared/theme';

export const ROOT_CLASS = 'osx-root';

const RESET = `.${ROOT_CLASS} {
  all: initial;
  display: block;
  box-sizing: border-box;
  font-family: var(--osx-font);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
  color: var(--osx-fg);
}
.${ROOT_CLASS} *, .${ROOT_CLASS} *::before, .${ROOT_CLASS} *::after {
  box-sizing: border-box;
}
`;

/**
 * The docked panel's place. It lives here, not inline, so the narrow rule can change it: page rules
 * cannot reach inside the shadow root, so this is as safe as an inline style.
 *
 * Below SwimCloud's `md` breakpoint (992 px, recon Q16) the page shows its fixed "Options" button
 * (`.btn-fab`, bottom 15 px, right 10 px; measured live 2026-10-26). It opens the settings drawer.
 * The panel moves to the left there and keeps 144 px clear on the right, so it never covers it.
 */
export const PANEL_FRAME_SELECTOR = '[data-osx-panel-frame]';
export const NARROW_MAX_WIDTH_PX = 991.98;

const PANEL = `${PANEL_FRAME_SELECTOR} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 360px;
  height: 240px;
  z-index: 2147483000;
}
${PANEL_FRAME_SELECTOR}[data-osx-size="expanded"] {
  width: min(640px, calc(100vw - 32px));
  height: min(520px, calc(100vh - 32px));
}
[data-osx-panel-error] {
  position: fixed;
  right: 16px;
  bottom: 260px;
  z-index: 2147483001;
  max-width: 340px;
  padding: 8px 12px;
  border: 1px solid var(--osx-bad);
  border-radius: 6px;
  background: var(--osx-bg);
  color: var(--osx-bad);
  font: 14px/1.4 var(--osx-font);
}
[data-osx-panel-error][hidden] { display: none; }
@media (max-width: ${NARROW_MAX_WIDTH_PX}px) {
  ${PANEL_FRAME_SELECTOR} {
    right: auto;
    left: 16px;
    width: min(360px, calc(100vw - 160px));
  }
  ${PANEL_FRAME_SELECTOR}[data-osx-size="expanded"] {
    width: min(640px, calc(100vw - 160px));
  }
}
`;

/** Reset, then tokens. The reset comes first so `all: initial` cannot erase a later declaration. */
export const SHADOW_CSS = RESET + tokenCss(`.${ROOT_CLASS}`) + PANEL;
