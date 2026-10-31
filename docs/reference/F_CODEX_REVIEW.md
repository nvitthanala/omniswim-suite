# Slice F review

## Findings

- **MEDIUM — `apps/extension/src/dashboard/autoBuilderRequest.ts:139`; `apps/extension/src/overlay/pagePanel.ts:100`.** Raw IDs still appear where names belong if display metadata is missing: force `display` to omit swimmer/team names before generating an AutoBuilder request, or produce a scorer state with no team label; the fallback renders `148001`/`58` as if each were a name. These paths bypass `swimmerLabel`/`teamLabel`.
- **MEDIUM — `apps/extension/src/dashboard/dashboard.css:107`; `apps/extension/src/dashboard/ScoreChart.tsx:175-181`.** `overflow:hidden` clips chart endpoint labels: labels are positioned at `x = width - right + 7` and text extends to the right of that coordinate. At width 320 (compact chart), any label whose rendered text exceeds the remaining margin is cut off. The expanded chart has the same issue when its 600px SVG is constrained by a narrower panel; SVG's `overflow:visible` cannot escape the section clip.
- **LOW — `tests/extension-harness/playwright.config.ts:16`.** The 360-second timeout is global for every test in this config, not scoped to record 14. A hung/slow failure in records 1–13 or any other test in this spec can now take six minutes before timing out.

## Checks

1. The requested grep finds remaining raw-ID fallbacks at `autoBuilderRequest.ts:139`, `pagePanel.ts:100`, and two `main.tsx` scorer-state construction paths (`:211`, `:216`). The `main.tsx` values are names in the message payload and can surface unchanged downstream when the source has no name.
2. Dark muted token is `color-mix(in srgb, CanvasText 72%, Canvas)` in both dashboard root (`dashboard.css:30`) and page panel closed root (`theme.ts:104`, emitted by `tokenCss('.panel')` at `pagePanel.ts:37`). With the dark system Canvas/CanvasText colors, that blend has substantially over 4.5:1 contrast against the dark surface (`Canvas 92% + CanvasText 8%`); the token is identical in both roots. `printTokenCss` remains the source of the print declarations, and dashboard CSS retains its pinned print override at `dashboard.css:213-215`; the targeted acceptance set does not include the dedicated token parity test.
3. `thresholdDirty` stays true forever after invalid blur because the invalid branch at `tabHost.tsx:363-365` does not clear it; subsequent remote refreshes therefore never replace the abandoned draft. A valid save clears it before persistence (`:367`), allowing a racing bus refresh to render the previous stored value temporarily, but `run` awaits the save then refreshes (`:338-343`), so the final saved value is restored. A later remote change does show because dirty is false after a valid save (or initially).
4. As above, endpoint labels are clipped. The chart's expanded rendering uses a 600px SVG (`liveView.tsx` chart call); if panel width is smaller, the section clip also truncates the right edge.
5. Global timeout, not record-specific.
6. New tests that would fail against pre-fix behavior: `tests/extensionPagePanel.test.ts:60` (asserts the font rule inside `.panel`) and `tests/extensionCutTags.test.ts:113` (asserts missing names are labeled as absent). `tests/extensionTabHost.test.ts:250` also exercises preserving a typing draft across a refresh.

## Acceptance run

- `npm run build:extension` — passed.
- `npm run lint` — command started; the tool returned after 30 seconds during `lint:types` output, with no final exit status available.
- `SKIP_BUDGET_ENV=local npx vitest run tests/extensionCutTags.test.ts tests/extensionPagePanel.test.ts tests/extensionTabHost.test.ts tests/extensionScoreChart.test.ts` — passed: 4 files, 43 tests.
