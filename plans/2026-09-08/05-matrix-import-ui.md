# Matrix-side changes

Today's `handleSwimCloudImport` is ~140 lines of a good pipeline fed by a
bad input mechanism. The pipeline stays. Only the input changes.

**`OpsModule.tsx` — "+ from SwimCloud" becomes a two-item menu:**

- **"Browse captures…"** (default) — opens the new picker.
- **"From clipboard"** — today's `handleSwimCloudImport`, unchanged, kept
  for single-page captures and because it is the path that has real
  screenshot verification.

**New `packages/matrix/src/components/SwimCloudCapturePicker.tsx`** (a
`worker` task, built against a reported API):

- `GET /api/swimcloud/captures` → a table of capture records: label,
  subject, `updatedAt`, page counts, completeness, warning count.
- Completeness renders honestly. `'every-planned-page-fetched'` shows as
  **"64 of 64 planned pages · team list unverified,"** never as "Complete."
  A `'partial'` capture shows which teams or pages are missing and offers
  "Resume in the extension."
- Selecting one calls `POST /api/swimcloud/captures/{id}/parse`, which
  parses server-side and returns `SwimCloudTeamMeetSwimsParse[]` plus
  aggregated warnings.
- The client then runs `swimCloudTeamMeetSwimsToSwimmerResults` per parse
  and folds them with `mergeSwimCloudResults` — **the existing functions,
  unchanged**. The rest of `handleSwimCloudImport` (same-meet detection by
  the `${meetId}:` id prefix, `meetCopyFromParsed`,
  `buildScoringPatchForParsedPdf`, `resolveKeepRecruits`, the
  `pdfFilename` non-PDF label) is extracted into a shared
  `applySwimCloudRows(...)` that both the picker and the clipboard path
  call.
- A per-team / per-gender checkbox filter, defaulting to all, so a coach
  can import only their own team from a whole-meet capture.
- A "Forget this capture" action, which is the only way to make a
  `'final'` page re-fetchable — matching `SwimCloudFinalEntryImmutableError`'s
  stated escape hatch.

**Why parse server-side.** A whole-meet capture is ~66 pages at ~200 KB, so
~13 MB of HTML. Shipping that to the browser to parse is wasteful when the
server already has it on disk. The parser is pure TypeScript with zero
dependencies, and `server.ts` already imports directly from `packages/core`
under tsx. The conversion to app shapes stays in `packages/matrix`, which
keeps `packages/swimcloud` ignorant of `SwimmerResult` — the isolation
`03-architecture.md` §1 requires and `docs/INVARIANTS.md` records.

**Manager side** gets the step-1 fix from
[04-parsers-and-fixtures.md](04-parsers-and-fixtures.md) "Retired" and
nothing else this round. The roster queue stays as it is.
