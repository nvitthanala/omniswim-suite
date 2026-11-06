# F1.1a roster season and class year: architect review

Reviewer: Claude `architect` agent (Opus), 2026-11-06. The author was
Claude `executor` too, so this review breaks the different-provider rule.
User decision R83 allows it while Codex is out of quota and Cursor needs a
sign-in.

## Findings and dispositions

- **HIGH H1: the browser boundary test failed** (reproduced):
  `rosterFetch.ts` in `packages/swimcloud/src/browser/` imports five
  parser modules from outside it. **Sent back** with ruling 1.
- **MEDIUM M1: "no Class column" was flagged but never shown, and not
  stored.** A renamed header would save every team with no class years and
  wipe the earlier good ones. **Sent back** with ruling 4 (refuse).
- **MEDIUM M2: the Rosters tab said only "the Score tab is not changed".**
  Build, Plan and scorer tags ignore fetched membership too. **Sent back:**
  say so plainly.
- **LOW L1:** a doc comment in `settingsStore.ts` sits on the wrong
  function. **Sent back.**
- **LOW L2, L3:** a posture-off start during a run, or unticking the
  posture mid-run, could leave a run going. **Sent back.**
- **LOW L4:** zero overlap on an old season is reported only as
  "id-join-suspect". **Sent back:** the note also names the real answer.
- **LOW L5, L6:** `enrich.ts` sets `classYear` null for teams without
  class years (the wiring must pass every team); the roster test counts
  are pinned to 2025-26 (user question U12). **Follow-up.**

Checked and correct: no challenge, wrong-season or zero-row page is saved;
no partial run finishes as complete; season ids are copied from the season
list; `fetchPosture` defaults to `off`; no request starts without a click;
the bundle test still scans the dashboard build.

## Rulings

1. **Boundary: an exact allowlist in the test (option A).** The five
   imports reach ten files (`entities`, `html`, `indexed`, `parseCells`,
   `parseElements`, `parseResult`, `rosterPage`, `swimFields`,
   `teamSeasons`, `urlClassifier`). None imports `node:*`,
   `playwright-core` or a package. The test lists them as `SHARED_PURE` and
   checks that the set reached from `browser/` equals the list. Moving the
   parsers (option C) was rejected: D7 section 1 says wrap, do not edit.
2. **Membership may ship unwired** if the state file names the wiring step
   and the tab says so (M2). The wiring belongs in `dashboard/liveModel.ts`
   (decision L), which D7 section 8 never assigned. It must apply rosters
   after `adaptSimulatorSnapshot`, drop or report scorer tags on
   `not_member` swimmers, store the season choice outside component state,
   pass class years for every team, and never touch `rescoreSimulator`.
   Order it before F1.3b, which shares `enrich.ts`.
3. **A stopped run saves nothing: kept.** Possible follow-up: save the
   validated pages before the stop point and say "Saved k of n"; never
   after an out-of-order, wrong-path, incomplete or port-lost failure.
4. **A page with no Class column is refused** (`class-column-missing`).
5. **Membership and class year match D7 section 4.**
