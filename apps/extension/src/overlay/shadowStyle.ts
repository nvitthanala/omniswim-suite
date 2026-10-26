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

/** Reset, then tokens. The reset comes first so `all: initial` cannot erase a later declaration. */
export const SHADOW_CSS = RESET + tokenCss(`.${ROOT_CLASS}`);
