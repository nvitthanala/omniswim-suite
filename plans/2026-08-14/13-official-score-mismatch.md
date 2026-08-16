# 13 — Computed totals disagree with the published official scores

**Severity: P1. Pre-existing.** Found 2026-08-16, by an agent noticing a test
nobody runs.

`scripts/test_nsisc_team_totals.mjs` compares the engine's computed team totals
against the meet's **official published scores**. It is the closest thing this
repo has to a ground-truth check on scoring.

**It is not registered in `scripts/run-tests.mjs`, so `npm test` has never run
it.** And it fails:

```
OK    Women University of West Florida : 1239.00  official 1239     delta   0.00
FAIL  Women Delta State University     :  936.00  official  916     delta +20.00
OK    Women Ouachita Baptist University:  536.00  official  536     delta   0.00
OK    Women Henderson State University :  476.00  official  476     delta   0.00
OK    Men   Henderson State University : 1056.00  official 1056     delta   0.00
OK    Men   Ouachita Baptist University: 1029.50  official 1029.5   delta   0.00
FAIL  Men   Delta State University     :  874.50  official  875.5   delta  -1.00
```

**Six of eight match exactly. Both failures are Delta State**, and they fail in
opposite directions: women **+20**, men **−1**.

## Why this matters

Every other finding in this folder is reasoned from the app's own output. This
one compares that output to what actually happened at the meet. A 20-point
overstatement for one team is a scoring defect with a published answer to check
against — the most tractable kind of correctness bug this repo can have, and the
only one where "right" is not a matter of interpretation.

That the numbers are exact for three of four teams argues against a broad engine
fault and for something specific to Delta State's rows: a relay attribution, a
diver, an exhibition swim, a disqualification, or a roster-eligibility difference.

## Why nobody noticed

The test is not in the `TESTS` manifest. It is one line to add, and adding it
turns `npm test` red until the discrepancy is resolved — which is the correct
outcome, but it should be a deliberate choice rather than a surprise.

Note the parallel with the `console.assert` finding in
[06](06-testing-verification.md): the suite's most valuable checks were the ones
not actually running. Two independent instances of the same failure mode now.

## Proposed

1. **Diagnose Delta State first.** Both deltas are small and specific. Dump the
   scored rows for Delta State women and compare event by event against the
   published results PDF. 20 points is roughly one relay (2 × 10) or a diving
   placement — start there. The men's −1 smells like a half-point tie split or a
   relay half-rate rounding.
2. **Then register the test.** Once the discrepancy is explained, either the
   engine is fixed and the test passes, or the official figure is understood to
   differ for a documented reason and the expectation is annotated with it.
3. **Do not "fix" it by adjusting the expected values to match the engine.** That
   inverts the test — it would pin whatever the app currently does, which is the
   trap [06 §1](06-testing-verification.md) already flags for the skipped
   `test_nsisc_output.json` fixture.

## Related

[06 §1](06-testing-verification.md) records two *other* scoring tests skipped for
a missing fixture. Between them, **the three checks that would most directly
validate scoring are all inactive**: two skipped, one unregistered.
