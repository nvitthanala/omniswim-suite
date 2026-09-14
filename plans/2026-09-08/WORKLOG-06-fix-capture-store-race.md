# WORKLOG 06 — fixing the capture-store concurrent-write race (review finding #4)

**2026-09-09, `executor`, direct dispatch after the adversarial review.**

## The fix

A private, module-local `KeyedAsyncMutex` inside `packages/swimcloud/src/captureStore.ts`
(no public API change) — a `Map<string, Promise<void>>` chain, held as
`FileSystemSwimCloudCaptureStore`'s `private readonly writeLock`.
`upsertCapture`, `putPage`, and `deleteCapture` each run their whole body
through `runExclusive(captureId, ...)`. In `putPage`, the page's HTML bytes
are written to disk *inside* the same critical section as the manifest
update, so a reader can never see a page ref before its bytes exist.

Handles the two subtleties a naive version misses: a rejected operation
still releases the lock for what's queued behind it (via
`predecessor.then(op, op)`), and cleanup of a finished chain entry uses an
identity check so a newer chain queued behind an old one is never
mistakenly dropped. No memory leak — measured directly against the private
map (idle key count returns to 0; concurrent key count matches exactly),
not assumed from reading the code.

## Scope, stated explicitly in the class's own doc comment

Protects concurrent async callers **inside one Node process** — the actual
deployment shape here (one local Express server whose route handlers can
overlap; two browser tabs crawling the same meet hit exactly that). Does
**not** protect two separate OS processes writing the same directory —
no on-disk lock, no atomic compare-and-swap. Nothing ships that shape
today; if it ever does, this needs a real file lock, not a bigger
in-process mutex.

## A second, smaller race found and deliberately left alone

`rebuildIndex` has its own separate race: two writes to *different*
captures can interleave their index rebuilds and leave `index.json`
missing an entry. Not fixed, because fixing it would need a lock spanning
every captureId — the exact global bottleneck the fix above was designed
to avoid. Bounded and self-healing: `index.json` is a documented derived
read cache, the capture files themselves stay correct, and the next write
repairs it. Documented in the class's own comment under "Also not
protected," not silently absorbed.

## Verification rigor — the standard this worklog is holding itself to

- The 4 new tests were run **against the unmodified store first** and
  confirmed red with the exact predicted symptom (20 concurrent writes →
  1 surviving page ref, 19 silently gone) — not just written and trusted
  to pass post-fix.
- The "different captureIds don't serialize" test was adversarially
  checked by temporarily hard-coding the mutex to a single global key and
  confirming exactly that one test fails (on the right axis — ordering,
  not the safety properties, which correctly still hold under a global
  lock) — then restoring the file and diffing it byte-identical against a
  backup to confirm no residue.
- Margin measured, not assumed: idle-completion ordering index observed at
  0–1 across 10 runs against a global-lock value of 20 — roughly 20x
  headroom on the same machine, so load affects both sides of the
  comparison equally.

## Result

- `npx vitest run`: 449 passed (up from 445; 4 new).
- `npm run lint --workspaces --if-present`: clean, all 8 workspaces.
- `npm run build -w @omniswim/shell`: succeeds.

No git operations. `docs/reference/SWIMCLOUD_CAPTURE_STATE.json` updated
alongside this file.
