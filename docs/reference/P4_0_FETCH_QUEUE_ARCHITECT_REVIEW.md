# P4.0 fetch queue: architect review

Reviewer: Claude `architect` agent (Opus), 2026-11-05. The author was
Claude `executor` too, so this review breaks the different-provider rule.
User decision R83 allows it while Codex is out of quota and Cursor needs a
sign-in.

## Findings and dispositions

- **HIGH: the 3 s gap reset between runs** (`fetchQueue.ts:180`). Two runs
  in a row started 0 ms apart; the Web Lock was released at the last
  request. **Fixed:** a per-tab pacer keeps the last start, and the run holds
  the lock until it is 3000 ms old. Mutations killed: pacer reset per run;
  lock hold removed.
- **HIGH: cancel could not stop a request in flight** (`fetchQueue.ts:153`,
  no `signal`). A hung request kept `active` and the lock forever.
  **Fixed:** the signal is in the request init, and the fetch is raced
  against it. Mutations killed: signal dropped; race removed.
- **MEDIUM: a `busy` reply used a live run's id** (`overlay.ts`). The panel
  could get two `fetch-end` messages for one run. **Fixed:** such a
  `fetch-run` is dropped and logged. Mutation killed: guard removed.
- **MEDIUM: port loss left the run going** (`dockedPanel.ts:140`).
  **Fixed:** the new `DockedPanel.onDisconnect` aborts the run.
  Mutations killed: binder ignores the disconnect; the panel never calls
  its listeners.
- **LOW, fixed:** duplicate `seasonId` in the season list;
  `performance.now` for pacing; stale "5 KB" comments.
- **LOW, follow-up:** a roster heading check "Season {label}
  {Men|Women}" in the F1.1a panel parser; empty-run semantics; a panel
  check that item indices run 0 to delivered-1; forwarding the season list
  to the panel (`main.ts` passes no `onSeasons`).

## Fix round

The same executor fixed every item above. The architect did not re-review
the fix round. The lead and the advisor checked it on 2026-11-06: the
abandoned fetch promise is caught and its abort listener removed; the lock
is held for the gap and released on every ending; a run queued behind the
hold counts as active, so a third run gets `busy`. A `fetch-end` sent while
the port is reconnecting is still lost; the panel must treat a missing
`fetch-end` after a reconnect as a failed run (F1.1a).

## Rulings on the executor's open choices

1. `refused` stop reason: accepted.
2. A 403 with `cf-mitigated: challenge`: the lead chose `challenge` (the
   header wins at any status, as D7 says). The architect's advisor preferred
   `forbidden` with the header in `detail`; either stops the run.
3. Retry-After rules (over 60 s stops, under 3 s raised to 3 s): accepted.
4. Strict season list: accepted, plus the duplicate-id check.
5. Internal crash: new reason `internal`, with the real delivered count.
6. Port loss: cancel the run.
7. Season list to the panel: follow-up.
8. A failed season request sets the error state: accepted.

## Checked and correct

The real roster that loads the `challenge-platform` script is delivered;
only `_cf_chl_opt` counts as a challenge. Redirects are caught by origin,
path and sorted query. A 200 challenge page cannot pass as data. The bridge
stays under its 10,000 B budget.
