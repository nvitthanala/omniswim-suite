# Repo reorganization: active vs legacy

Status: **plan.** Runs in phase P1, after PR #7 (the 2026-10-10 improvement
plan) is merged to `main`. Do it on branch `nvitthanala/extension-redesign`.

## Rules

1. **One mechanical commit for the moves.** `git mv` only. No content edits in
   the same commit except the path fixes the moves force (workspace globs,
   tsconfig references, import paths, CI paths). Git then tracks every file's
   history through the rename.
2. **Legacy stays runnable.** At the reorg commit, the full old gates pass:
   `npm run lint`, `npm test`, `npx vitest run`. Record the counts in the
   state file. Compare them with the PR #7 baseline: 89 script tests passed,
   1 skipped; 4,932 vitest tests passed, 25 skipped.
3. **Nothing is deleted.** Deletion is a separate, later decision.
4. **Extraction comes after the move.** `packages/engine` is created in a
   second commit, by moving pure modules out of `packages/core` and
   re-exporting them from `core`.

## Target layout

```
apps/
  extension/                  NEW (P1 skeleton)
packages/
  engine/                     NEW (extracted from core, second commit)
  core/                       stays; re-exports engine; keeps React hooks + store for legacy
  swimcloud/                  stays; gains a browser-safe entry
legacy/
  apps/shell/                 from apps/shell
  packages/manager/           from packages/manager
  packages/matrix/            from packages/matrix
  packages/metrics/           from packages/metrics
  packages/db/                from packages/db
  packages/ui/                from packages/ui
  backend/                    from backend/
  extensions/swimcloud-companion/   from extensions/swimcloud-companion/
  scripts/                    the legacy-only scripts (see below)
  tests/                      the legacy-only tests (see below)
  Start-OmniSwim-Suite.bat, Start-OmniSwim-Suite-Prod.bat
  SUITE_ROADMAP.md
  README.md                   NEW: what legacy is, how to run it, why frozen
data/                         stays (cutlines, relay-programs, scoring presets are sources)
docs/                         stays; docs/archive keeps history
plans/                        stays
tests/                        active tests only
```

## Moves that need judgment

- **`packages/ui`.** The new look is SwimCloud's, not OmniSwim's, so `ui`
  moves to legacy. If a dashboard component turns out to be worth reusing,
  copy it into `apps/extension` with its tokens, rather than keep `ui` active.
- **`tests/` (320 files, one flat folder).** Classify each file by what it
  imports:
  - Imports only `packages/core` pure modules or `packages/swimcloud`: active.
  - Imports `manager`, `matrix`, `metrics`, `db`, `ui`, `apps/shell`, or the
    crawler extension: legacy.
  - Both: legacy for now. Split later if the engine part matters.
  A script does this classification and writes the list into the state file
  before any move. Review the list by hand.
- **`scripts/` (116 tracked files).** Same rule. The test scripts called from
  `scripts/run-tests.mjs` split into an active runner and
  `legacy/scripts/run-tests.mjs`.
- **`data/`**: `demo-seed.json`, `training/` and `scoring_settings.json` serve
  the legacy app only. Move them to `legacy/data/`. Keep `cutlines/`,
  `relay-programs/`, `scoring_presets/` and `scoring_rules/` at the root.
- **`omniswim-suite/README.md`** (a tracked one-file folder) and the untracked
  `omniswim-suite/data/` in the main clone (open item M3): ask the user. Do
  not move or delete them in the reorg commit.
- **Root `vitest.config.ts`, `playwright.config.ts`, `stryker.config.mjs`,
  `eslint.config.mjs`**: active versions at the root; legacy gets its own
  configs under `legacy/` that point at `legacy/tests`.

## Scripts after the reorg

| Command | Covers |
| --- | --- |
| `npm run lint` | active workspaces and `apps/extension` |
| `npm test` | active script tests and vitest |
| `npm run test:legacy` | the old suite, unchanged |
| `npm run build:extension` | the new extension |

CI runs `test` and `test:legacy` on every push until P2 is green. After that,
`test:legacy` runs weekly and on any change under `legacy/`.

## Acceptance

- `git log --follow` works across the move for a sampled file in each moved
  folder.
- The legacy app still starts with `npm run dev` from `legacy/apps/shell` and
  the old start script.
- The old gates pass at the reorg commit, with counts equal to the baseline.
- After the engine extraction, the core golden snapshots and the optimizer
  guard tests pass unchanged.
