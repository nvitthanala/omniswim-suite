# Explanation limit and planner token: architect review

Reviewer: Claude `architect` agent (Opus), 2026-11-05. The author was Claude
too, so this review breaks the different-provider rule. User decision R83
allows it while Codex is out of quota and Cursor needs a sign-in.

## Findings and dispositions

- **MEDIUM: "Not explained: N swimmers" counted swimmers that were never
  checked** (`packages/engine/src/autobuilder/explain.ts:386`, `:395`).
  The engine queues every owned swimmer with an individual entry and counts
  the ones left in the queue. Some of them have no unusual event.
  **Fixed:** the panel now says "Not checked for unusual events: N
  swimmers". The `ExplanationLimit` doc in `types.ts` and a correction note
  under D5 amendment 12 say the same. The engine is unchanged.
- **LOW: after a meet switch, if meet B's read fails, meet A's schedule and
  preference stay on screen with no end** (`sessionPlannerEditor.tsx`).
  **Not fixed:** it widens follow-up `planner-switch-window` in the state
  file. That follow-up now covers a failed read too.
- **LOW: a click between meet B's commit and its passive effect carried
  meet A's token.** **Fixed:** the token is set in a `useLayoutEffect`, so
  it changes before the browser paints the new meet.

## Checks the reviewer ran

- `SKIP_BUDGET_ENV=local npx vitest run tests/extensionAutoBuilderPanel.test.ts tests/extensionSessionPlannerSubscribe.test.ts`:
  57 passed.
- The HEAD editor swapped in: both orders of the meet-switch test failed at
  their first assertion. The file was restored (sha256 equal before and
  after).
- Checked with no finding: every planner handler after a switch or an
  unmount, read staleness, StrictMode double effects, the limit text (no
  invented number, the "nothing to explain" line hidden when a limit is
  present), and the worker transport.
