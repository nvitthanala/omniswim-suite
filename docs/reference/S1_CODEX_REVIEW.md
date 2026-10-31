# S1 code review

Scope: S1 working diff and `tests/extensionStorageS1.test.ts`; ignored the data directory and redesign state JSON. Rulings checked against D6 amendments 2, 4, and 5.

## Findings

- **Medium — `apps/extension/src/dashboard/autoBuilderAccept.ts:230-232`; `apps/extension/src/storage/repo.ts:126-145`.** An Accept that creates a new tag records an undo delete guarded by the written rev (normally 1). If another context deletes that tag and recreates it, the recreated row starts at rev 1 too; Undo's `putMany` then accepts the stale rev and deletes the other context's tag. This is the dashboard's stale-rev reuse case as well: a stale tag action in `main.tsx:236-241` can overwrite a deleted-and-recreated row when its expected rev aliases the reset rev. Existing-row updates ordinarily advance the rev and do not have this collision.
- **No defect — Accept undo atomicity and edited lineup protection (`apps/extension/src/storage/undo.ts:30-37`; `apps/extension/src/dashboard/autoBuilderAccept.ts:224-239`).** All inverse ops are sent in one `putMany`; a stale lineup or tag check aborts the transaction, so no subset is applied. Editing the accepted lineup advances its rev, causing the undo delete to fail as “changed elsewhere.” Deleted tags use `expectedRev: 'new'`, so a re-created tag makes the whole undo fail. The created-tag delete exception is the rev-reuse finding above.
- **No defect — stack order (`apps/extension/src/storage/undo.ts:27-36`; `apps/extension/src/dashboard/snapshotSave.ts:91-103`).** Entries pop from the end. If Accept is followed by Save, the first undo removes that Save; the next undoes Accept, assuming no intervening external edit invalidates it.
- **No defect — cache scope and no-op (`apps/extension/src/storage/repo.ts:256-280`).** Every requested store is checked against `CACHE_STORES` before transaction creation, so a user store is refused. Clearing empty caches leaves `deleted` at zero and does not bump `changeRev` or publish; it cannot make a pending Accept report changed.
- **Verified — fixtures/version (`apps/extension/src/storage/schema.ts:19`).** `tests/fixtures/extension-db` has no diff from HEAD; `DB_VERSION` remains 2.

## Test coverage note

`tests/extensionStorageS1.test.ts` adds “Clear cache bumps changeRev once and names both cache stores, and a clear of nothing announces nothing”; it exercises the new `clearCache` contract and would fail against the pre-change implementation.

## Checks

`SKIP_BUDGET_ENV=local npx vitest run tests/extensionStorageS1.test.ts tests/extensionAutoBuilderPanel.test.ts tests/extensionTabHost.test.ts tests/extensionStorageUndo*.test.ts` — passed, 3 files / 63 tests. Fixture comparison and DB version check passed.
