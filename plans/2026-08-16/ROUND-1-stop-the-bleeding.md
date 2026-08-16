# Round 1 — stop the bleeding

**Shipped:** `2559e429`, 2026-08-15
**Plan:** [2026-08-14/11-sequencing.md](../2026-08-14/11-sequencing.md) Round 1
**Result:** lint clean, 52 passed / 0 failed / 3 skipped, build exit 0

Five agents on disjoint scopes, integrated in one commit.

## What shipped

| Scope | Change |
| ----- | ------ |
| Server | Binds `127.0.0.1` unless `OMNI_HOST` is set; banner states the real bind host and auth state; a non-loopback bind prints a blocked warning |
| Server | `/api/analyze-video` no longer mounts upload middleware while it returns 501; hardened config kept in an unmounted factory |
| Server | `authMiddleware.ts` reformatted from one 1,600-character line to 51 lines |
| Core | `enrichWithComputedCut` uses `divisionForTeamOrNull`; unmapped teams emit `computedCut: null` instead of being judged against D1 |
| Core | `detectDuplicateAthletes` surfaced in the lineup compliance checklist with link/dismiss actions |
| UI | Workspace takes its name from the loaded meet PDF when still an app-generated placeholder |
| UI | Sidebar shows each workspace's loaded meet instead of only a creation date |
| Tests | 35 `console.assert` calls converted to `node:assert/strict` across three files |
| Tests | `run-tests.mjs` captures both streams and fails a tripped `console.assert` even at exit 0 |
| Tests | Production-server smoke test; main-thread `longtask` budget |

## Three findings that only appeared by doing the work

### 1. Three test files could not fail

`console.assert` in Node logs `Assertion failed` and **returns** — exit code stays
0. `run-tests.mjs` judges pass/fail from the exit code, so `test_athlete_history`
(19 assertions), `test_entry_limits` (14) and `test_roster_optimizer` (2) reported
PASS regardless of what they found. One of them covers the roster optimizer.

Proven, not assumed:

```
$ node -e "console.assert(1===2,'FALSE'); console.log('continued');"
Assertion failed: FALSE
continued
exit code was: 0
```

Fixed both ways: the 35 assertions are now real, and the runner fails any file
where an assertion trips at exit 0. Verified with a decoy file that exits 0 —
now reported `FAIL … console.assert tripped but exited 0`.

### 2. My own security finding was overstated, and the agent corrected it

The review claimed four crafted upload filenames escaped the upload directory.
Only **two** actually did. The `Date.now()-` prefix turns a *leading* `../` into a
literal directory name, so `../../evil.txt` lands harmlessly at `uploads/evil.txt`;
`x/../../../evil.txt` genuinely escapes to `C:\evil.txt`.

The agent asserted the true per-case outcome rather than the blanket claim it was
given, noting that asserting "all four escaped" would have been a false claim that
failed immediately. It then mutation-tested its own guard: **8 reintroduced
defects, 8 caught.**

### 3. The alias finding was wrong, and the truth was worse

See [2026-08-14/02 §2 and §2a](../2026-08-14/02-data-quality-aliasing.md).
The four "split athletes" were **already linked** — the original probe counted
name strings without checking `athleteAliases`. Chasing it surfaced a P0:
`buildScorerRosterLookup` never applies the alias resolver, so the links were
stored and silently discarded downstream.

Measured:

```
resolver:  Alan Alejan Gonzalez Mujica -> Alan Gonzalez Mujica   MERGED
roster:    Alan Alejan Gonzalez Mujica (1) | Alan Gonzalez Mujica (1)   BOTH PRESENT
           47 rows for at most 43 athletes
```

Carried into Round 2 as the highest-priority item.

## What was deliberately not done

- **Conversion-factor provenance** — blocked on an open question: does any
  governing body actually publish these factors? If not, the whole table is
  indicative rather than official, which changes what the roster tooltip may claim.
- **`tests/test_nsisc_output.json`** — the fixture must be hand-checked against the
  published PDF, not generated from the app's current output, or it freezes
  whatever the app does today including any bug.
