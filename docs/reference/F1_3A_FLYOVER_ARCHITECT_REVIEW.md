# F1.3a engine flyover: architect review

Reviewer: Claude `architect` agent (Opus), 2026-11-05 and 2026-11-06 (the
usage limit interrupted it once). The author was Claude `executor` too, so
this review breaks the different-provider rule. User decision R83 allows
it while Codex is out of quota and Cursor needs a sign-in.

Verdict: commit now. Nothing must be fixed first, because every caller
passes `flyover: unset` and the adapter is yards-only. The first three
items block F1.3b and F1.2, which turn the flyover and converted splits on.

## Findings and dispositions

- **MEDIUM-1: the planner and the report build the index without
  sourcing** (`planner/sessionLoad.ts:24`, `report/facts.ts:44`). Once a
  flyover leg exists, an AutoBuilder run with a load rule and a snapshot
  save both throw `leg_basis_unsupported`. Loud, not silent. **Blocks
  F1.3b:** pass the sourcing settings into `sessionLoad` and
  `captureReportFacts`, and make the `buildIndex` sourcing argument
  required.
- **MEDIUM-2: an estimated relay time can lose its "estimated" label**
  (`report/facts.ts:35` collects only flat-start legs; `usedConverted` is
  dropped at `results.ts:457` and `squads.ts:111`). Silent. **Blocks
  F1.3b, in the same change as MEDIUM-1.**
- **MEDIUM-3: a flyover leg on the wrong event gives "no time" with no
  violation** (`results.ts:455-457`, `:537`; pinned by
  `tests/engineFlyover.test.ts:495`). **Follow-up:** push `event_mismatch`
  whenever the basis swim's event is not the leg event, value still null.
- **LOW-1:** swims are converted at adapt time and splits at score time,
  so `includeConvertedSwims` could differ between them. The same split
  exists for individual events. Follow-up.
- **LOW-2:** five files outside the D7 scope list changed, each only to
  pass the new settings type through. Noted in the commit body.

## Rulings

1. A leg-1 flyover estimate keeps the throw for this commit; nothing
   produces one. Follow-up for F1.3b: no time plus a `basis_position`
   violation, since storage accepts a flyover leg in any position.
2. Planner and report without sourcing: acceptable now; fix before any
   caller sets the flyover or `includeConvertedSwims: true` (MEDIUM-1).
3. The fast scorer's fallback to `scoreMeet` is exact by construction
   (`fastScore.ts:164,168,215`, `evaluate.ts:178,216`), but no parity test
   covers a flyover leg or a converted split. Follow-up: add one.

## Checked and correct

The flyover is subtracted only from a rankable flat swim. Unset never
becomes 0. A real split always wins. Tie-breaks are deterministic.
`recordedEventKeyFor` runs only for a non-SCY course. `lib/**` and
`DB_VERSION` are untouched. Targeted tests: 4 files, 107 passed.
