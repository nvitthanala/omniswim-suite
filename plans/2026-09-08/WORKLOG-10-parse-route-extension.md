# WORKLOG 10 — extending the server-side /parse route to roster and swimmer-times pages

**2026-09-09, `executor`, direct dispatch.** User instruction: "build
whatever is needed for the server side parse."

## What shipped

`apps/shell/lib/swimcloudCaptureRoutes.ts`'s `POST /:id/parse` now parses
all three page kinds a capture can hold, not just `meetTeamSwims`:

```ts
export interface SwimCloudCaptureParseResponse {
  readonly captureId: string;
  readonly subject: SwimCloudCaptureSubject;
  readonly parses: readonly SwimCloudTeamMeetSwimsParse[];       // unchanged
  readonly rosters: readonly SwimCloudRosterParse[];             // new
  readonly swimmerTimes: readonly SwimCloudSwimmerTimesParse[];  // new
  readonly warnings: readonly string[];                          // now aggregates all three
}
```

`meetTeamSwims` behavior is byte-for-byte unchanged — same warning strings,
same ordering, same try/catch scoping (only the parser call itself is
wrapped, so a throw after warnings were pushed can't produce a mixed
state). Extended via a `kind`-tagged union dispatch (`parsePageOfKind`)
rather than adding branches inside the existing try, specifically to
preserve that property while adding two more kinds.

**Mutation-proven**, not just green: dropping `'teamRoster'` from the
parseable-kinds list fails 4 tests; letting a roster parse succeed but
never collecting it into the response fails the same 4 — confirming the
tests catch both a routing regression and a collection regression, not
just a happy path.

## Verified

- `npx vitest run`: 625 passed (up from 618; 7 new tests, all real-fixture
  spot-checked — a mixed capture holding all three parseable kinds at once,
  confirmed none clobbers another).
- `npm run lint --workspaces --if-present`: all 8 workspaces clean.
- `npm run build -w @omniswim/shell`: succeeds.

## Immediate follow-up, done in the same round (mechanical, not a design call)

The route's own report flagged `packages/matrix/src/components/
SwimCloudCapturePicker.tsx`'s local type mirror as stale in four precise
spots. Fixed directly (no subagent — small, exactly specified, no judgment
needed): the two new type imports, the two new mirror fields (with a doc
comment stating plainly that neither is surfaced in this component's UI
yet), the header comment's contract description, and a toast that would
otherwise have told a coach "nothing parseable here" on a capture that had
in fact successfully parsed a roster or a swimmer's times. Also fixed the
one test fixture (`tests/swimCloudCapturePicker.test.ts`) whose mocked
response predated the two new required fields. Re-verified: 625/625 still
green, lint clean, build succeeds.

## What's genuinely still open — a decision, not a task

`rosters` and `swimmerTimes` now reach the picker's TypeScript but nothing
renders them. The real question — **what does a coach actually do with a
roster or a swimmer's personal-bests once they can see them?** — is not
answered anywhere in this initiative and should not be guessed at. Three
candidate shapes (read-only browse; feed a recruiting/what-if projection;
feed roster-import parallel to `RosterImportWizard`'s existing clipboard
path) are recorded in `plans/2026-09-08/NEXT-STEPS-post-parse-extension.md`,
none chosen. Building UI for any of them without asking first would repeat
the exact mistake this initiative's `CLAUDE.md` rules exist to prevent.

No git operations.
