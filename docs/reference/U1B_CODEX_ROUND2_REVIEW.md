# U1-b AutoBuilder panel — round 2 review

**Target:** working tree against `b55f9ede`; narrow review of `putMany`, Accept rechecks, the worker harness patch, and the two targeted tests.

## Verdict: accept with fixes

One high-severity concurrency finding remains in Accept. The batch storage primitive is otherwise atomic and consistent with the single-write path for the reviewed behavior. The harness patch is stripped from production output, and neither targeted test is vacuous.

## Findings (ranked)

### High — checked AutoBuilder inputs are not fenced by the batch transaction

**File:** [autoBuilderAccept.ts](../../apps/extension/src/dashboard/autoBuilderAccept.ts:236), especially lines 237–243.

After `verifyProposal` and tag-op planning, the code rechecks coach tags, own team, rule preset reference and resolved preset values, then checks the snapshot by `snapshotKey`. There is no `await` between that final snapshot check and the call to `putMany`. The snapshot check is content-based (`JSON.stringify(snapshot)`), so a repost with identical content does not block.

However, the stored-input reads and the batch write are separate IndexedDB transactions. A competing context can queue a write transaction after the final check's read transaction but before `putMany` opens its readwrite transaction. IndexedDB can run that queued write first. For example: Accept reads tags/team/rules as A; another page queues a team or rule-preset change; Accept's final check completes; the competing write commits; then Accept's batch writes the lineup and tag operations using inputs A. The batch only revision-checks tags it changes, so a team/rule change or a change to an untouched scorer tag is not caught.

**Fix:** carry revision-checked guards for every input that determines the proposal—including own team, rule preset, and the complete relevant coach-tag set—into the same transaction as the lineup/tag writes. Extend the batch API with read-only preconditions or an equivalent transaction callback, and abort the whole batch on mismatch. Add a regression test that queues a competing input write between final validation and batch execution. The current accept tests change the snapshot or a tag during the awaited re-score, and test a stale changed tag after planning; they do not exercise this final-check-to-transaction ordering.

## Checks by requested point

### 1. `StorageRepo.putMany` and `PutManyOp`

**Pass.** `putMany` opens one readwrite transaction over the distinct edited stores plus `meta` ([repo.ts](../../apps/extension/src/storage/repo.ts:209)). Each `applyPut`/`applyDelete` reads the row and checks `expectedRev` inside that transaction immediately before its write (lines 108–139 and 214–217). The awaited requests are IndexedDB requests in that still-active transaction; there is no separate read transaction or caller-visible gap.

A stale put or delete calls `abortWith`, aborting the shared transaction; other errors are caught and also abort it (lines 88–93, 218–223). This rolls back earlier operations and prevents `changeRev` from advancing. Put records pass `assertValidRecord`, the same validator used by `put`, before the transaction opens (lines 175–180, 198–204). `changeRev` is bumped in the transaction after all operations and before commit (lines 95–104, 214–224).

The post-commit notice publishes the deduplicated list of every touched store (lines 209, 224–227). The existing dashboard watcher receives the full notice and checks `stores.includes('tags')`/`includes('settings')`, so a multi-store notice containing either refreshes scorer tag state ([main.tsx](../../apps/extension/src/dashboard/main.tsx:134)). That is the only `watchChanges` consumer found under `apps/extension/src`; session-planner state has no change-bus subscription, so it does not refresh in response to notices for session preset stores. The AutoBuilder batch itself only touches `lineups` and `tags`; its tag component refreshes correctly. If later batch users need session-planner cross-context refresh, that subscriber must be added/expanded.

Deletes check the stored revision and treat a missing key as stale (`repo.ts:134–138`). Duplicate `(store,key)` operations throw `RangeError` during the preflight pass, before transaction creation or writes (`repo.ts:201–207`). `PutManyOp` is exported from `storage/index.ts` (its type is declared in `repo.ts:65–70`). Put revision increments, `updatedAt`, and preservation of existing `createdAt` reuse the same `applyPut` logic as `put`; delete revision behavior matches `delete`.

### 2. Accept race recheck

The final checks occur after `verifyProposal` has awaited opponent re-suggest/score work, and check stored tags, own team, rule reference and resolved values, then snapshot content (`autoBuilderAccept.ts:211–243`). Identical snapshot reposts compare equal by `snapshotKey` (`autoBuilderRequest.ts:39–40`). There is no `await` after the final snapshot check before `putMany`; the remaining issue is the transaction-ordering race described above, not an intervening JavaScript await.

### 3. `workerStarts()` production exclusion

**Pass.** `recordWorkerStarts` patches `globalThis.Worker` only when `installHarness()` runs ([harness.ts](../../apps/extension/src/dashboard/harness.ts:43–61)). `main.tsx` calls that function only inside `if (__OSX_HARNESS__)` (line 222). `build.config.mjs` defines the flag as `false` for normal builds and writes harness builds to `dist-harness/` (lines 20–24, 101–114); esbuild can eliminate the guarded call and its probe. The existing `apps/extension/dist` contains the production dashboard bundle, and searching it for `osxHarness`/`recordWorkerStarts` returned no matches.

### 4. Targeted test vacuity

**No vacuous test found.** `extensionStoragePutMany.test.ts` checks actual inserted/updated/deleted rows, revision bump, notice store coverage, rollback after stale put/delete, validator rejection, duplicate-key rejection, and the empty batch. `extensionAutoBuilderAccept.test.ts` gates the solver to mutate the snapshot or stored tag during the awaited verification, inspects persisted state after refusal, simulates a stale tag at write time, and asserts the successful batch contains the lineup and tag operations. These tests make meaningful assertions; the specific final-check race in finding 1 remains uncovered.

## Blocked on me

none

## Changed

- `docs/reference/U1B_CODEX_ROUND2_REVIEW.md` — added this review; no source files changed.

## Found

- High: Accept can save a proposal after an own-team/rule/untouched-tag change ordered between its final input reads and the batch transaction; see [autoBuilderAccept.ts](../../apps/extension/src/dashboard/autoBuilderAccept.ts:236).
- Session planner does not subscribe to storage change notices; scorer-tag refresh handles multi-store notices containing `tags`.
- No tests run, per instruction. Production `dist` grep found no harness probe identifiers.
