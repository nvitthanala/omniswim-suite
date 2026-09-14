# 2026-09-09 — the friction fix, and the UI redesign plan

Two things happened this round, in this order:

1. **A real, user-hand-tested bug fix.** The user ran the built auto-fetch
   crawler for real, against a real 234-page meet, and it "exported each
   page one by one with pop ups for every single page." Root-caused from
   the actual code (not guessed), fixed, and written up in
   [`WORKLOG-13-friction-fix-download-batching.md`](WORKLOG-13-friction-fix-download-batching.md).
2. **A thorough UI/architecture redesign plan**, explicitly requested with
   an "at the very least" minimum bar given a scarce remaining weekly quota:
   [`01-UI-REDESIGN-PLAN.md`](01-UI-REDESIGN-PLAN.md).

Read the worklog first if you want to know what changed in the extension.
Read the plan if you're deciding what to build next.

## Standing rules, unchanged from every prior round

No git operations — everything here is a working-tree diff. Every claim
about "what the UI currently does" in the plan document is grounded in a
real file read at the time of writing (line counts, actual JSX structure,
actual duplication), not a description from memory of an earlier round.
