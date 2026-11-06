# F2 Code Review: Page Panel Cut Tags

Read-only review of `apps/extension/src/overlay/pagePanel.ts` against `HEAD` and `tests/extensionPagePanelCutTags.test.ts`.

| Severity | File:line | Finding and scenario |
|---|---|---|
| No defect | `apps/extension/src/overlay/pagePanel.ts:64-82` | All row values remain: swimmer name, real value, estimated value, and conditional estimated provenance. For `estimatedIsEstimate`, the `est.` badge and provenance text remain; otherwise neither is appended. Team and event headings remain in `renderCutTags`. The `(name not loaded)` text is carried through unchanged via `item.swimmerName`. |
| No defect | `apps/extension/src/overlay/pagePanel.ts:66-80` | SwimCloud-derived name, real/estimated values, and provenance are assigned with `textContent`; no `innerHTML` is used in this rendering path. Markup-like input is rendered as text. |
| No defect | `apps/extension/src/overlay/pagePanel.ts:69-72` | Badge and provenance append only under `item.estimatedIsEstimate`, and both are children of the Estimated LCM line. A non-estimated value gets neither. |
| No defect | `tests/extensionPagePanelCutTags.test.ts:27-55,58-64` | Both new tests fail against the old table: the layout test finds zero `[data-osx-cut-row]` rows (and lacks `.cut-line`/`.cut-name`); the style test cannot find `.cut-badge` in the old CSS. |

Acceptance run: `SKIP_BUDGET_ENV=local npx vitest run tests/extensionPagePanelCutTags.test.ts tests/extensionPagePanel.test.ts` — passed, 2 files / 7 tests.
