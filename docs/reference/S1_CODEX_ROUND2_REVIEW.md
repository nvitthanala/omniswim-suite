# S1 code review, round 2

Scope: requested storage revision delta, `tests/extensionStorageS1.test.ts`, AutoBuilderPanel UI test and hint. Read-only review except this report.

## Findings

- **Medium — `apps/extension/src/storage/repo.ts:118-125, 151, 217-220`; `apps/extension/src/storage/exportImport.ts:400-402`.** The normal transaction paths bump `changeRev` in the same readwrite transaction as their writes (see a), but they do not reconcile a legacy row revision above `changeRev` when deleting it. Concrete failure: a legacy tag has `rev: 2` and `meta.changeRev` is missing; delete commits `changeRev: 1`, then a create of that key commits `changeRev: 2` and `max(2, 1)`, reusing the old rev 2. A stale context holding the earlier rev 2 then passes the equality check and can overwrite/delete the recreated row. This also means b's absolute no-reuse claim is false, and c stale checks fail for that sequence. A legacy update before deletion itself works: rev 2 updates to 3, and reads remain unchanged.

## Requested checks

a. **No defect** for atomicity: `put`, `putMany`, `delete`, `clearCache` (when it deletes rows), `putCache`, and import all include `meta` in the same IndexedDB readwrite transaction as their mutation. IndexedDB serializes overlapping readwrite transactions on `meta`, so contexts cannot commit the same increment. Empty `putMany`/empty clear/no-row clear do not commit a change.

b. **Defect**, as in the Medium finding: legacy delete/recreate can reuse a prior rev. On a fresh database, rev 1 is valid for a key's first life; it is not reused on the normal sequence.

c. **Partial defect**, as in the Medium finding: legacy reads and ordinary updates work, and a changed row's old rev is rejected after update. But if its rev exceeds missing/low `changeRev`, deleting then recreating can restore an earlier rev and make an old stale token valid again. Missing `changeRev` is otherwise treated as 0.

d. **No assertion weakening beyond changed expected revs.** `extensionStorageClassYear`: `saved.rev` 1→2 and read result `rev` 1→2. `extensionStorageExport`: imported meet `rev === 2` became `rev > 1` plus `rev === readChangeRev(db)`; edited lineup `rev === 2` became `rev === 3` plus `rev === readChangeRev(db)`. `extensionStoragePresets`: two `rev === 1` expectations became `rev === 2`. `extensionStoragePutMany`: created tag's `rev: 1` expectation became `rev: 2`; updated tag's `rev: 2` assertion is unchanged.

e. **No defect** for the round-1 Accept-undo scenario: deleting a tag records `writtenRev: 'absent'`; undo uses `expectedRev: 'new'`. If another context has recreated it, the batch gets `StaleWriteError` and returns `changed elsewhere`; `putMany` aborts atomically, so it writes nothing (including the lineup inverse).

## Checks

`SKIP_BUDGET_ENV=local npx vitest run tests/extensionStorage*.test.ts tests/extensionAutoBuilderPanel*.test.ts` did not expand its globs in PowerShell and Vitest reported no files. Reran with concrete matching file paths; passed: 203 files, 3,418 tests passed and 7 skipped.

