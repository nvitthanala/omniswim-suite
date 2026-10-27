# D4: Read and write the simulator

Status: design draft for R66. Keep SwimCloud's controls as the primary controls. Put OmniSwim results beside the simulator results, with the docked dashboard for work that needs space.

## 1. Write page settings through the page

Use the simulator's own Redux setter actions, after the user selects an OmniSwim rule preset or invokes an explicit Apply action. Do not call the simulator endpoint for settings: it loads team swims, while scoring and limit changes re-score cached data without another request (02-SIMULATOR-RECON.md:146-147,170-173). Do not assign DOM input values as the source of truth: the simulator uses React and Redux, and its controls are not plain form state (02-SIMULATOR-RECON.md:262-266). Recon records a generic `@SETTER/<key>` dispatch and named setters; the page store access is already implemented in the bridge (02-SIMULATOR-RECON.md:264-266; apps/extension/src/bridge/install.ts:220-245).

Write only settings the simulator represents:

- `pointSystem` for the selected point table.
- `maxScorersPerTeam` for its per-event scoring cap. The simulator uses the same cap for relays (02-SIMULATOR-RECON.md:249-252,287-288; packages/swimcloud/src/browser/simulatorRules.ts:155-167).
- Individual per-athlete and per-team limits, relay per-athlete and per-team limits, and total per-athlete limit (02-SIMULATOR-RECON.md:253-255; packages/swimcloud/src/browser/simulatorRules.ts:174-195).

Do not write OmniSwim-only meanings into superficially similar settings. In particular, the page's relay per-team entry limit is not the OmniSwim scoring-relay cap: `simulatorRulePreset` reports both per-team entry limits unmapped (packages/swimcloud/src/browser/simulatorRules.ts:129-131,184-195). Keep the R67 scoring-relay cap and exhibition marks in OmniSwim state until a native page control exists (plans/2026-10-25/README.md:91; packages/swimcloud/src/browser/simulatorRules.ts:161-167). Do not change date, team, gender, course, events, time mode, roster removals, or individual entry edits as part of applying a rule preset; these are distinct user choices (02-SIMULATOR-RECON.md:138-142,239-259).

Treat the private Redux setter names and payload shapes as an adapter contract, not a stable API. Recon says class names change and the store path is a React/Redux internal (02-SIMULATOR-RECON.md:228-230,262-266). Pin tested state keys and setter behavior in synthetic fixtures; on unknown shape or rejected dispatch, show a visible compatibility error and do not claim the write succeeded. Never silently guess a setting or competition value.

Writing through page state avoids fabricating requests or bypassing the user's control. It still depends on private page code and may break after a SwimCloud release. Review SwimCloud's terms before release; this draft makes no claim about permission. If any response is a Cloudflare challenge or HTTP 403, stop the affected operation, surface the error, and make no retry or alternate request (02-SIMULATOR-RECON.md:17-20; plans/2026-10-25/README.md:71,74).

## 2. Read-back and echo control

Keep the existing store subscription as the read-back channel. It emits a debounced snapshot when page state changes (apps/extension/src/bridge/install.ts:236-247). Extend the snapshot-to-overlay handling only if needed to expose the changed rule fields; the bridge already projects `SETTINGS_KEYS` from the store (apps/extension/src/bridge/install.ts:91-99; apps/extension/src/shared/protocol.ts:24-33).

Normalize the settings to a canonical signature. On Apply, record the intended signature and a short-lived write token before dispatch. When the store subscription observes that signature, acknowledge the write, clear the token, and recompute once. For any later distinct signature, treat it as a page-originated edit and re-score. Identical signatures are no-ops. Do not dispatch from the subscription handler. This prevents a feedback loop and makes page edits authoritative after a completed write. Reject or visibly mark partial/unmapped settings; `simulatorRulePreset` already exposes pending and unmapped fields (packages/swimcloud/src/browser/simulatorRules.ts:82-96,184-195).

## 3. Page surface and docked dashboard

Render an OmniSwim results panel adjacent to the simulator's results table, in a dedicated extension-owned shadow root. Include the exact parity line and event differences; the report distinguishes no observed scores from a comparison and does not treat missing points as zero (packages/swimcloud/src/browser/parity.ts:9-18,56-67,69-105). Include real and estimated cut tags together (plans/2026-10-25/README.md:93), scorer tags with an explicit coach tagging step before scoring (plans/2026-10-25/README.md:89), and editable suggested opponent rosters (plans/2026-10-25/README.md:94). Never put invented or unsupported cut values into tags.

Keep saved meets, preset management, lineup editing, optimizer controls, charts, exports, history loading progress, and settings in the docked dashboard: these need larger workflows or durable storage, not a crowded results table (plans/2026-10-25/01-REDESIGN-PLAN.md:20-25; plans/2026-10-25/D3-STORAGE-AND-BUILD.md:78-80). The page panel links to those workflows where appropriate.

Use a shadow root for the new in-page panel so SwimCloud CSS cannot restyle its internal controls and extension styles cannot leak into the page. The existing docked host already uses a shadow root (apps/extension/src/overlay/overlay.ts:53-70). Prefer a closed root for this small results panel; keep its DOM references inside the isolated content script. Shadow DOM is style and DOM encapsulation, not a security boundary: page scripts can observe or remove the host element. Keep all data validation and trusted state in the ISOLATED world, and treat MAIN-world messages as forgeable (plans/2026-10-25/D3-STORAGE-AND-BUILD.md:209-218; apps/extension/src/overlay/overlay.ts:77-86). The dashboard remains an extension-origin iframe and uses its nonce-named runtime port (apps/extension/src/overlay/dockedPanel.ts:8-13,65-72,94-103; apps/extension/src/dashboard/panelPort.ts:5-8,37-50).

## 4. MAIN-world byte budget

Do not add dispatch UI, rendering, validation libraries, or result computation to `sim-bridge`. Keep it limited to discovering the page store, copying a strict snapshot, posting it, and the smallest guarded setter adapter. Its entry is required to stay under 5 KB; the prior measured minified bridge was 4,975 bytes (plans/2026-10-25/D3-STORAGE-AND-BUILD.md:77,707-710). Move setting selection, write tokens, signature comparison, result panels, and error presentation to `sim-overlay` and the isolated dashboard. Keep shared protocol constants dependency-free (apps/extension/src/shared/protocol.ts:1-7). If a setter implementation cannot fit within the byte cap, defer writes and use the extension UI to explain the unsupported control; do not relax the cap.

## 5. Phases and acceptance

1. **Adapter contract.** Add synthetic DOM/store fixtures for supported settings, setter action payloads, missing keys, page rerenders, and unrecognized store shapes. Assert the bridge snapshot includes each supported setting, rejects missing values, and never falls back to defaults. Assert no request is created by a settings write.
2. **Read/write loop.** In fixtures, change each supported setting through the page and confirm one recompute. Apply a preset and confirm one matching read-back, no second dispatch, and no duplicate recompute for identical snapshots. Confirm partial/unmapped settings remain explicit.
3. **Page panel.** Fixture the results anchor and a missing/replaced anchor. Verify the panel mounts beside results, survives supported rerendering, reports parity `not_observed` distinctly, and displays both cut tags. Verify styles remain inside shadow DOM and page events do not reach SwimCloud handlers.
4. **Harness.** Extend `npm run test:extension-harness` to check a real simulator session using recorded sanitized fixtures: page-originated settings edits, extension Apply writes, parity update, panel placement, challenge/403 stop behavior, and docked iframe connectivity. Stop the test on challenge/403; no retry. Preserve the existing bridge size assertion and prove the harness fails if a forbidden retry or write loop is introduced (plans/2026-10-25/D3-STORAGE-AND-BUILD.md:77,280-281).

## Open questions for the user

- Should applying a saved preset immediately update supported SwimCloud settings, or should every write require a separate Apply click?
- Should the in-page results panel default open, or begin collapsed beside the results?
