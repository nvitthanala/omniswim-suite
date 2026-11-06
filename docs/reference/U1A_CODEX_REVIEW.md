# U1-a Codex review

## Blocked on me

none

## Changed

- Added this review only. No implementation or test files changed.
- Checks: `npx tsc --noEmit -p apps/extension/tsconfig.json` passed. Vitest and npm test were not run, as requested.

## Found

### Low — bundle boundary tests do not enforce worker exclusivity

**`tests/extensionBundleBoundaries.test.ts:35-55, 69-88`** checks prohibited input classes, CSP syntax, and the number of emitted scripts, but never asserts that AutoBuilder engine inputs are present in `autobuilder.worker` and absent from `dashboard`, `optimizer.worker`, and other entries. The current build config does put the worker entry at `apps/extension/build.config.mjs:67-74`, and no dashboard import of AutoBuilder was found, so this is a missing regression guard rather than a current bundle leak. A future `main.tsx` import of `@omniswim/engine`'s `autoBuild` could bundle it into `dashboard.js` while all current boundary checks still pass. Add a metafile assertion that the autobuilder source/engine autobuilder inputs occur only in `autobuilder.worker`, and that the worker has those inputs.

### Review of requested behavior

- **Cancel and late messages:** `apps/extension/src/dashboard/autobuilderClient.ts:81-85, 91-100, 140-146` clears the active slot before settling, terminates the worker, and ignores messages from any worker other than the current worker. IDs are monotonic across replacement workers, so a stale response cannot match a later run. The cancel test at `tests/extensionAutoBuildWorker.test.ts:354-389` confirms rejection, isolation from `optimizer.worker`, and a successful next run. It does not manually inject a late old-worker response, but the worker identity check and ID check cover that sequence in the implementation.
- **Errors:** `apps/extension/src/worker/autobuilder.ts:53-58, 60-84` maps `AutoBuildError` and `ScoreMeetError` to copied source/code/subject fields and all other thrown values to `internal`; its `try/catch` includes HiGHS loading, `autoBuild`, and message construction. The client settles a matching error at `apps/extension/src/dashboard/autobuilderClient.ts:96-100`; worker `error` and `messageerror` events reject and discard the active run at lines 102-112. No ordinary worker or solver-load failure path found that leaves the promise pending. The tests cover AutoBuildError, ScoreMeetError, and an internal exception, but not a rejected HiGHS loader; that rejection follows the same worker catch path.
- **Clock:** the shared request type is `Omit<AutoBuildRequest, 'clock'>` at `apps/extension/src/shared/autobuilderProtocol.ts:13-17`. The client refuses a request with a `clock` property before starting/sending at `autobuilderClient.ts:117-120`, and the worker independently refuses one at `worker/autobuilder.ts:63-68`. `'wall'` constructs the function in the worker at line 79; `'none'` does not.
- **Freshness and size:** `tests/extensionBuildFreshness.test.ts:28-39` compares the exact entry-name set, including `autobuilder.worker`; existing freshness checks compare built output to `dist`. `tests/extensionBundleBoundaries.test.ts:103-107` retains the strict `< 10000` UTF-8 byte check for `sim-bridge.js`. These edits add the worker to real checks and do not loosen the bridge limit.
- **Ten worker tests:** no vacuous test found. In particular, the direct-vs-worker test asserts an `improved` result before comparing, and the clock refusal tests assert both rejection and that no worker starts. The cancellation test cancels from a real progress callback and awaits the restarted run.

### Added API surface

- Third `run` argument `{ clock? }`: **useful**. It selects the explicitly specified wall/no-clock behavior while keeping the request itself free of functions.
- `runTimed`: **useful**. The `auto-build-done` protocol includes `loadMs` and `wallMs`; callers can access them without changing the specified `run` result type.
- `AutoBuildRunError { source, code, subject }`: **useful**. It preserves the structured worker error information across `postMessage` while retaining an `Error` rejection.
- `AUTOBUILD_CANCELLED`: **harmless**. It gives callers/tests a stable cancellation reason; the specified API does not constrain the rejection text.
- `AutoBuildProgressUpdate`: **harmless**. It omits protocol-only `kind` and `id` from the callback payload.
- `AutoBuildRun`: **useful** for `runTimed`; it groups the result and the timing fields already in the done message.

**Verdict: accept with fixes.** Add the bundle-exclusivity assertion; no functional blocker was found in U1-a.
