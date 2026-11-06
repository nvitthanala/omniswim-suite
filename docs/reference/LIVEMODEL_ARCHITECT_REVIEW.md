# liveModel wiring: architect review

Reviewer: Claude `architect` agent (Opus), 2026-11-06 (the usage limit
interrupted it once). The author was Claude `executor` too, so this review
breaks the different-provider rule. User decision R83 allows it while
Codex is out of quota and Cursor needs a sign-in. Spec:
`plans/2026-10-25/D7-LIVEMODEL-SPEC.md`.

## Findings and dispositions

- **HIGH H1: Accept compared the live key before the slow re-score.** A
  roster save or a season pick during the re-score got past the final
  check. **Fixed:** Accept checks the key again after `changeRev`, after the
  snapshot check.
- **HIGH H2: Accept in season mode wrote the lineup that Save refuses.**
  **Fixed:** Accept refuses in season mode too (lead default, U14).
- **MEDIUM M1: the planner always shows "pending" under NSISC** (the
  planner scores with no tags; pre-existing). **Fixed:** the planner passes
  the kept and suggested tags, only under roster eligibility; NSISC and
  points-pool tests added.
- **MEDIUM M2: the live key held the raw season label**, so a season list
  arriving after a run refused Accept and blamed a season the coach never
  touched. **Fixed:** the key is built from what changes the output.
- **LOW L1:** a live-model error posted an empty tag list with the wrong
  message. **Fixed.**
- **LOW L2, L3:** a roster save republishes twice; the Rosters tab does not
  rerun on a settings change from another context. **Follow-up.**
- **Wording:** three lines in the Rosters tab and the Build panel were
  not true or not plain. **Fixed.**

## Fix round

The same executor fixed H1, H2, M1, M2, L1 and the wording, each with a
killed mutation. The architect did not re-review the fix round. The lead
and the advisor checked it on 2026-11-06 and made two more fixes:

- The planner passed tags under every preset, so a stored tag under a
  points-pool preset (`tags_need_roster_mode`) turned a working Plan tab
  into "pending". It now passes tags only under roster eligibility. A test
  covers it, and removing the gate fails it.
- The second load in Accept reported a not-loaded or unreadable simulator
  as a roster change. It now uses the same messages as the first check.

The executor ran `git stash` and `git stash pop` once in its first pass,
against its brief. The lead checked the tree: the stash list was empty and
the uncommitted state and questions files were intact.

Follow-up: the `acceptBlock` call after `inputsChanged` guards a different
wait before `putMany`, and no test covers it. It stays.

## Rulings on the executor's deviations

a. The T10 source-text check plus the extracted `viewOf`: accepted.
b. Save refusal covers saving a lineup: accepted.
c. The page-panel warning, the Save refusal in the error state and the
   dropped-tags note: accepted.

## Checked and correct

Score, Chart and parity stay on SwimCloud's own rescore. Every other
consumer reads `live`, and no operation loads twice. Tags on `unknown`
swimmers are kept. A team with no record is `not-loaded`, never
`not_member`. Class years resolve for every team. Simulator (current)
applies no membership. `SIMULATOR_SOURCING` equals the removed literals.
Targeted tests: 5 files, 57 passed.
