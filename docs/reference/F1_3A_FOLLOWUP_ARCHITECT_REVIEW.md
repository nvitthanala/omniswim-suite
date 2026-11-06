# F1.3a follow-up: architect review

Reviewer: Claude `architect` agent (Opus), 2026-11-06. The author was
Claude `executor` too, so this review breaks the different-provider rule.
User decision R83 allows it while Codex is out of quota and Cursor needs a
sign-in. The slice fixes MEDIUM-1, MEDIUM-2, MEDIUM-3, the leg-1 ruling and
the parity test of `F1_3A_FLYOVER_ARCHITECT_REVIEW.md`.

Verdict: nothing blocks the commit except two stale doc lines. Targeted
tests: 6 files, 103 passed. A fast-scorer mutation (a flyover leg valued
as its flat time) fails 2 parity tests.

## Findings and dispositions

- **MEDIUM-A: a flyover leg with no expected leg event was silent**
  (`results.ts:474`). Same shape as MEDIUM-3. **Fixed:** an unknown
  leg event now flags `event_mismatch`.
- **LOW-B: a leg-1 flyover now reaches the AutoBuilder gate** as a hard
  `basis_position` violation that `repairable()` skips, instead of a
  preflight throw. **Fixed:** D5 documents the path; the
  executor found no wrong behaviour (see Fix round).
- **LOW-C: `LegOption.usedConverted` had no reader.** **Fixed:** removed.
- **LOW-D: D2:682 and D5:142 listed the removed error codes.** **Fixed** (the lead also
  fixed D2:676, which still named `ConversionSettings`).
- **LOW-E: no test for a leg-1 flyover on another swimmer's swim.** **Fixed:** test added.

## Rulings

1. Removing `leg_basis_unsupported` and `split_not_scy` from
   `ScoreMeetErrorCode` is safe: nothing switches on them, the code crosses
   `postMessage` as a plain string, and no stored fixture holds them.
2. `snapshotSave` passing `SIMULATOR_SOURCING` is right today. For F1.3b:
   the rescore returns the sourcing it scored with, and `snapshotSave`
   passes that same object (never a second read across awaits). Once the
   flyover is user-set, `builtUnder` records the sourcing (a persisted
   schema change, F1.3b). `extensionSnapshotSaveSourcing.test.ts` must then
   pin "the same object the results used", not the constant.
3. The F1.3b screen reads legs through one new root export, for example
   `relayLegReadout(model, lineup, sourcing)` returning each relay's total
   and each leg's value and `LegEstimate`. Do not export `Index` or
   `Resolved`; do not add this to the persisted `ResultRow`.
4. Not a behaviour change for stored data: the old `relaySwims` already
   marked a relay with a converted flat-start swim as estimated. Only
   flyover legs and non-SCY splits differ, and both used to throw.

## Fix round

The same executor fixed MEDIUM-A and LOW-B to LOW-E on 2026-11-06, each with a
killed mutation. LOW-B trace: a leg-1 flyover on a rival relay stays with
no time, and its `basis_position` violation shows only in
`Results.violations`; on an own relay of a built event the solver replaces
it. The architect did not re-review the fix round.
