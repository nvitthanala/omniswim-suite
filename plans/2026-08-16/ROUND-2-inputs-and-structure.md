# Round 2 — inputs and structure

**Plan:** [2026-08-14/11-sequencing.md](../2026-08-14/11-sequencing.md) Round 0 + Round 2
**Status:** in progress

Six agents on disjoint scopes. This round produced more *corrections to the
review* than the review itself contained, which is the useful part.

## What the review got wrong, corrected by doing it

### 1. "Four athletes are still two people each" — they were already linked

The probe behind that finding counted distinct name *strings* and never checked
`athleteAliases`. All four pairs (six, in fact — the DB holds two more than the
review listed) are `status: 'active'` and `buildAliasResolver` merges them
correctly. `detectDuplicateAthletes` correctly reports **0 pairs** to link.

Chasing it produced a real P0 instead: the links are **stored and ignored**.
Full correction in [2026-08-14/02 §2 and §2a](../2026-08-14/02-data-quality-aliasing.md).

### 2. "Duplicated athletes push genuine scorers out" — not observable

Claimed as a consequence of the alias bug. Measured by sweeping
`maxIndividualScorersPerTeam` from 1 to 999 against the live meet workspace:

| Cap | HSU men total | rows / scorers |
| --- | ------------- | -------------- |
| 1 | 1383.83 | 47 / 42 |
| 999 | 1383.83 | 47 / 42 |

A cap of **1** admits **42** scorers. The setting has no observable effect, in
any of four mode combinations tested. That is now its own finding —
[2026-08-14/02 §2b](../2026-08-14/02-data-quality-aliasing.md) — with the
mechanism explicitly **not** diagnosed, because two candidate explanations remain
and guessing between them would be exactly the kind of plausible-but-unverified
claim this project keeps getting bitten by.

### 3. The alias merge does not change any score

Verified two ways: 1,258 `isScorer` probes across both workspaces and both
genders returned identical answers with and without a resolver; HSU men scores
1383.83 either way. Roster rows collapse 47 → 41. It is a roster-shape fix.

The agent that measured this **first reported +80.50 points and then discarded
its own number** after two checks contradicted it. That is the behaviour worth
having.

### 4. The real damage is the entry cap — and my numbers were wrong twice

`countSwimmerEntries` also ignores the resolver. I wrote the merged counts as
10/10/10. They are **9/8/7**. The halves *share* individual events — a recruit
row remapped onto the meet's own event label is the **same entry**, not a new one
— so adding the halves double-counts. I propagated that naive sum into an agent
brief, and the agent measuring it caught the contradiction against its own data
and refused to assert my number.

| Athlete | Half A | Half B | Merged | Over cap 7? |
| ------- | ------ | ------ | ------ | ----------- |
| Balistreri | 7 | 3 | **9** | **yes** |
| Pózvai | 7 | 3 | **8** | **yes** |
| Fergunson/Ferguson | 7 | 3 | 7 | at cap |

**Two** genuine NSISC violations, not three. An over-entered swimmer's swims can
be voided, so this is a competition-rules consequence.

### 5. Underneath it, a silent empty — the failure mode this repo fears most

There are **two competing alias mechanisms**. `buildScoringBundle` already
*eagerly rewrites* every name to canonical when aliases exist, so on that path the
violations were already visible and the resolver is idempotent. What is live and
broken there instead:

```
countSwimmerEntries(…, 'Oliver Pozvai')  ->  8   over cap
countSwimmerEntries(…, 'Olivér Pózvai')  ->  0   COMPLIANT   <-- silent empty
```

Querying by the alias spelling matches zero rows and reports a real 8-entry
athlete as having none. `CLAUDE.md` rule 4 calls silent empties "the top failure
mode here", and this is one, live.

The eager rewrite is invisible at the call site, does not apply in `pdf_only`
view, and does not protect callers that bypass the bundle —
`AthleteMeetEntriesPanel.tsx:83` reads raw workspace arrays. **Which mechanism is
canonical needs deciding**; having both is how this arose.

**And fixing only the roster would have made it worse** — `row.name` becomes
canonical, so the counter would find 7 and report compliant. The two fixes shipped
together for that reason.

## Two open questions closed with data

- **Does HSU field divers?** No — zero. OBU 5, Delta State 4, UWF 4. Diving is
  360 of the meet's 6,147 points, all to rivals. Excluding it costs HSU nothing
  today and would cost any of those three up to ~120 points.
- **Should time trials count toward cut tagging?** They already do. 4 of 18
  time-trial swims carry a real cut tag, and stripping the suffix does not change
  the verdict. Cut tagging never consults `meetProgramEvents`. Anyone later
  "tidying up" by routing it through there would silently drop four earned cuts.

## Parse plausibility — the trap was in the fix

`375 Freestyle` traced to a real source line: a novelty event at the *61st Annual
Hendrix Relays*, stamped `R`. The gate rejects it and nothing else, across 1,742
history rows and a full re-parse of the raw roster file.

The interesting part is what nearly broke: `75 M Diving`. A naive leading-integer
distance filter reads **75**, finds it unsanctioned, and discards a diving row —
and `1 mtr` / `3 mtr` would have read as distances 1 and 3, killing every dive.
Diving is therefore checked *before* any distance is read. Verified by mutation:
removing that early return fails the test.

The gate rejects only what it can prove impossible, never what it merely fails to
recognise.

## Documentation

Root markdown: **18 files → 4**. Everything else under `docs/`, nothing deleted,
each archived file headed with why it is kept. New `docs/INVARIANTS.md` records
seven things that are true of this codebase, written down nowhere, and each of
which has cost debugging time. New `CHANGELOG.md` records user-visible behaviour
changes — for a tool a coach acts on, "the numbers changed and I don't know why"
is a trust problem.

Also corrected: the README claimed `OMNI_DB` defaults to `json`; it defaults to
`sqlite`.
