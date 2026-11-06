# F3 code review

## Findings

- **MEDIUM — edits made during a save can be discarded** (`apps/extension/src/dashboard/sessionPlannerEditor.tsx:85-86`). Start saving a schedule, edit another event while the storage promise is pending, then let the save resolve. The handler unconditionally clears `presetDirty` and installs the saved readback, replacing the newer on-screen draft. A refresh alone respects the draft, but this write completion does not.
- **LOW — failed schedule save can leave the draft dirty indefinitely** (`apps/extension/src/dashboard/sessionPlannerEditor.tsx:87`). If saving or its readback fails, the catch reports the error but leaves `presetDirty` true. Subsequent external preset/meet/settings changes refresh choices but never update the selected schedule until the coach selects another preset or a later save succeeds.
- **MEDIUM — user initiated async actions can set state after unmount** (`apps/extension/src/dashboard/sessionPlannerEditor.tsx:70, 86, 92-94`). Start selecting a preset, saving a schedule, or saving a load preference, then unmount before the repository promise settles. These handlers call setters after completion without checking `alive`; the guard only covers `load`. The subscription cleanup itself is returned correctly at line 65, and change-triggered reads are suppressed after unmount.

The new subscription tests should fail against pre-change code: the component previously had no subscription prop or refresh path, so second-context changes would not update the UI. The tests passed against the current code; they do not cover save/edit overlap, failed-save dirty state, or unmount during user initiated writes.

## Checks

- `SKIP_BUDGET_ENV=local npx vitest run tests/engineAutoBuildExplain.test.ts tests/extensionSessionPlannerSubscribe.test.ts` — passed, 2 files / 46 tests.
