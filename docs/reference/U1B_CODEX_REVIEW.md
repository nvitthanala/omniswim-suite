# U1-b AutoBuilder panel — Codex review

**Verdict: accept with fixes.** The visible panel and ordinary Accept flow are substantially aligned with the spec, but Accept has a stale-snapshot race and its two-store write is not atomic. The harness and explanation tests also leave claims unproved.

## Blocked on me

None. I reviewed the named scope against the spec text and ran the permitted TypeScript check. I did not run Vitest or npm test, per the brief.

## Changed

- `docs/reference/U1B_CODEX_REVIEW.md`: this review only. No implementation files changed.

## Found

### 1. High — snapshot can change during Accept verification and still be written

**File:** [autoBuilderAccept.ts](../apps/extension/src/dashboard/autoBuilderAccept.ts:191), especially lines 193–197; the panel supplies the snapshot at invocation in [autoBuilderPanel.tsx](../apps/extension/src/dashboard/autoBuilderPanel.tsx:330).

`acceptProposal` checks the snapshot once, then awaits stored-input reads and `verifyProposal`, which itself awaits opponent re-suggests and rescoring. It never checks that the snapshot still matches the tagged result after those awaits. It also checks stored tags/rules before the async verification, not after it. Concrete sequence: Accept starts against snapshot A; opponent re-suggest is pending; the page posts snapshot B or the coach changes a scorer tag; re-suggest resolves; Accept continues and writes the lineup and tags from A while newer state is current. The panel may recalculate its disabled button, but that cannot cancel this in-flight call. **Fix:** pass live snapshot and input getters or a final validation callback into `acceptProposal`, and recheck the tagged snapshot and stored inputs after verification immediately before any write; ensure the checked values correspond to current state.

### 2. High — lineup and tags can half-apply

**File:** [autoBuilderAccept.ts](../apps/extension/src/dashboard/autoBuilderAccept.ts:219), lines 219–225.

The code commits a new LineupRecord first, then writes each tag in a separate operation. It explicitly catches a tag-write failure only to report that the lineup was already saved. A concrete sequence: Accept verifies; the lineup `put` succeeds; an add or removal tag `put`/`delete` fails (for example, revision conflict or storage error); the coach is left with a saved proposed lineup but only some roster changes. **Fix:** add a storage-repo operation that atomically writes the lineup and all affected tags in one IndexedDB readwrite transaction, including revision checks, and return success only after that transaction commits.

### 3. Medium — explanation test does not exercise all binding explanations

**File:** [extensionAutoBuilderPanel.test.ts](../tests/extensionAutoBuilderPanel.test.ts:197), especially lines 197–224.

The test claims to cover explanation kinds, but it creates only `roster_add`, `roster_remove`, and one `unusual_event` with `teammates`; the frozen and non-frozen checks cover only `search_limit`. It never checks the `entry_cap`, `session_load`, `strict_diver_rule`, `load_penalty`, or `objective` wording, despite these being explicit review targets. A copy/paste error or misleading wording in those map entries would pass. **Fix:** table-drive `explanationLine` through every binding value, asserting the exact user-facing reason; retain the frozen-pair override check separately.

### 4. Medium — harness record 11 does not prove the work runs in the dedicated worker

**File:** [s3-workers.spec.ts](../tests/extension-harness/s3-workers.spec.ts:380), lines 380–423; [run-extension-harness.mjs](../scripts/run-extension-harness.mjs:44), line 44.

Record 11 verifies that Run reaches a result, page status says `done`, Cancel reaches `cancelled`, and the result disappears. Those are useful UI assertions, but none observes that `autobuilder.worker` performed the build. The script's added `autobuilder.worker.js` check proves only that the file exists in the bundle. A regression that routes AutoBuild onto the dashboard thread or a different worker could satisfy these checks. **Fix:** add an observable worker-specific assertion (for example, a worker handshake/progress marker) and verify the optimizer worker remains responsive during a build; keep the current flow assertions.

### 5. Low — the “real explanations” rendering test can pass with no explanations

**File:** [extensionAutoBuilderPanel.test.ts](../tests/extensionAutoBuilderPanel.test.ts:228), line 228.

The test compares rendered item count to `proposal.explanations.length` without requiring that the real config-C result contains any explanations. If the fixture result has an empty list, the test passes without rendering an explanation. **Fix:** assert the fixture has at least one explanation and separately render each explanation kind and binding through `AutoBuildResultView`, checking visible text.

## Findings checked with no defect found

- The normal stale-result path is blocked by `acceptBlock`, and a fresh opponent re-suggest/re-score blocks proposals not strictly above current. The race in finding 1 is the gap after that initial check.
- The intended successful path writes scorer tags for roster adds, handles removals per A10 with “non-scorer” default, stores one LineupRecord, and returns a SwimCloud entry-change list. It does not call a simulator write API. The non-atomic partial-failure case is finding 2.
- Goal-seek proof copy treats `bestFound` as changes and describes `upperBound` as a lower bound. Frozen robust pairs are rendered as “not enough swims (n)” and override the normal `search_limit` sentence.
- Request construction reads the current snapshot adapter, coach tags, team and rules, simulator sourcing, session schedule/load preference, selected objective/rival, roster flag, and time limit. The worker client supplies the wall clock as designed.
- Dashboard default tables are genuine duplicates, and the equality assertions compare both full tables with the engine exports; this is not vacuous.
- Dark-mode status is stated in text and result deltas include signs and words; state is not communicated by color alone.

## Checks

- `npx tsc --noEmit -p apps/extension/tsconfig.json` — passed (exit 0).
- Vitest and npm test — not run, as instructed.
