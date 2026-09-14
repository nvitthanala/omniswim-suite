# Next steps after the /parse extension (written pre-emptively, per user instruction to leave a solid plan if interrupted)

**Status at time of writing**: `executor` is extending
`apps/shell/lib/swimcloudCaptureRoutes.ts`'s `/parse` route (Phase 2d in
`docs/reference/SWIMCLOUD_CAPTURE_STATE.json`) to also parse `teamRoster`
and `swimmerTimes` pages, not just `meetTeamSwims`. This is the immediate,
in-flight task. Everything below is what comes after it lands.

## Step 1 (mechanical, do first): un-stale the picker's type mirror

`packages/matrix/src/components/SwimCloudCapturePicker.tsx` keeps a local,
hand-written mirror of `SwimCloudCaptureParseResponse` (it can't import the
route's types directly — cross-package boundary, documented in that file's
own header). Once Phase 2d lands, this mirror is out of date: it's missing
whatever fields the route now returns (`rosters`, `swimmerTimes` — exact
names come from Phase 2d's own report, don't guess them, read the
executor's final report or the route file directly).

This step is purely mechanical — add the matching fields to the local
mirror so the picker's TypeScript compiles against the real shape — and
does NOT require a product decision. Route it to `worker`.

## Step 2 (a real decision, not yet made): how does this data actually reach the user?

This is the part that needs a decision before more code gets written, per
this project's standing rule against guessing UI/product shape. The
question genuinely open: **once the picker can see roster and swimmer-times
data, what does a coach actually do with it?**

Candidate shapes, not a recommendation — this needs the user's call:

1. **Read-only browse.** The picker just lets a coach look at a captured
   roster or a swimmer's personal-bests table, with no write path into a
   workspace. Cheapest, but doesn't feed the app's actual scoring/what-if
   machinery.
2. **Feeds recruiting / what-if projection.** `packages/core` already has
   a `psychProjection.ts` and a "Meet Simulator" concept in the app nav
   (seen in the real `/team/58/` capture's own nav bar this session
   archived). A swimmer's personal-bests could plausibly feed exactly that
   kind of projection — but whether that's the right integration point, or
   whether it needs a new one, is a design call this session hasn't made.
3. **Feeds roster-import**, parallel to what `packages/manager`'s
   `RosterImportWizard` already does for a single pasted roster page —
   except now sourced from a captured page instead of a clipboard paste.
   This is the most direct reuse of existing app concepts, but "how does a
   captured roster reconcile with a workspace's existing roster overrides"
   is a real merge-semantics question, not a trivial wire-up.

**Do not build UI for any of these without asking the user which one (or
another shape entirely) they actually want.** The technical foundation
(real parsers, real crawl, real capture storage, real server-side parsing)
is now solid regardless of which UI direction gets picked — that's exactly
why this was worth building before the product question was answered.

## Step 3: manual verification, still entirely unrun

Nobody has loaded the rebuilt extension in a real browser and watched a
real crawl since the last several rounds of fixes (the hang fix, the
roster wiring, the bounded-concurrency swimmer-times pool). The checklist
lives at `plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md`, including the
newest section 6c for watching the concurrency behave correctly in the
Network tab. This is a genuine, not-yet-closed gap — everything downstream
of "does a real crawl actually work end to end" is still resting on unit
tests and code-level reasoning, not an observed real run.

## If resuming this from a fresh session or after an interruption

Read `docs/reference/SWIMCLOUD_CAPTURE_STATE.json` first — it is the
canonical state, more current than this file if the two ever disagree.
Check phase "2d"'s status before redoing anything.
