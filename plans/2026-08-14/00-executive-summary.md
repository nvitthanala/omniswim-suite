# Executive summary — 2026-08-14

## The one-paragraph version

Today's work removed four ways the suite could put a wrong number in front of a
coach. The review that followed found a fifth that is worse than any of them, and
it is in the panel the app markets as its differentiator: **the point-arbitrage
cards multiply a time gap in seconds by two and print the result with a "pts"
label.** Everything else in this folder is smaller than that.

Beyond correctness, the recurring theme is that **this codebase is unusually good
at stating rules and less good at enforcing them mechanically**. `CLAUDE.md`
forbids silent defaults on competition values; the code contained four. It
forbids assuming D1 for an unmapped team; one function still does. The rules are
right. The gap is that they live in prose and review, not in types and tests.

## Ranked findings

| # | Finding | Sev | Where |
| - | ------- | --- | ----- |
| 1 | Arbitrage "points" are seconds × 2. Claimed **58.7 pts** on a scale whose max is **20** | **P0** | [01](01-fabricated-values.md#1-arbitrage-points-are-not-points) |
| 2 | `enrichWithComputedCut` still resolves unmapped teams to **D1**, against the repo's own rule | **P0** | [01](01-fabricated-values.md#2-an-unmapped-team-is-still-scored-against-the-d1-table) |
| 3 | `CONVERSION_FACTORS` is 17 hand-typed rows with **no source, no manifest** — unlike cutlines | **P1** | [02](02-data-quality-aliasing.md#1-the-conversion-table-has-no-provenance) |
| 4 | 4 athletes are split across 2 name spellings each; only 6 aliases recorded | **P1** | [02](02-data-quality-aliasing.md#2-four-athletes-are-still-two-people-each) |
| 5 | Relay legs and diving are excluded from the quality ranking entirely | **P1** | [03](03-scoring-model-depth.md#1-relays-are-ranked-by-nothing) |
| 6 | Time trials are excluded from the meet program — correct for scoring, wrong for cuts | **Open** | [03](03-scoring-model-depth.md#3-time-trials-score-nothing-but-can-still-earn-a-cut) |
| 7 | `crossCourseArbitrage.ts` is 2,255 lines and owns four unrelated jobs | **P1** | [04](04-architecture-complexity.md#1-the-2255-line-module) |
| 8 | Two workspaces, no way to tell which is the real one; `Blank Workspace 1` holds the meet | **P1** | [05](05-ux-workflow.md#1-the-demo-workspace-is-called-blank-workspace-1) |
| 9 | 3 tests permanently skipped for a missing fixture; chart test shells out to `npm ls` | **P1** | [06](06-testing-verification.md) |
| 10 | Fonts load from Google; first run pip-installs from PyPI | **P2** | [07](07-packaging-offline-ops.md) |
| 11 | 18 root markdown files, 4 stale since June | **P2** | [08](08-docs-knowledge-debt.md) |

### Added 2026-08-15, after a second pass

| # | Finding | Sev | Where |
| - | ------- | --- | ----- |
| 12 | Server binds **`0.0.0.0`** with **no auth** in the default config, while the banner says `localhost` | **P0** in the meet scenario | [10 §1](10-security-exposure.md#1-the-server-listens-on-every-network-interface-with-no-authentication) |
| 13 | Unauthenticated upload writes **outside the project directory**; no size cap; the 501 does not prevent the write | **P0** in the meet scenario | [10 §2](10-security-exposure.md#2-unauthenticated-file-upload-writes-outside-the-project-directory) |
| 14 | The arbitrage fix introduced an **8.3 s main-thread freeze** — found, measured, fixed | fixed `15a0d293` | [09 §1](09-performance.md#1-the-arbitrage-scan-blocked-the-main-thread-for-83-seconds) |
| 15 | `crossCourseArbitrage`'s incremental **fast path is not faster** than a full re-score | **P1** | [09 §1](09-performance.md#where-the-time-goes) |
| 16 | `authMiddleware.ts` — the file deciding whether a request is authenticated — is **one 1,600-character line** | **P2** | [10 §4](10-security-exposure.md#4-authmiddlewarets-is-one-1600-character-line) |

**The order to do all of this in is [11-sequencing.md](11-sequencing.md).**

## If you only do three things

1. **Make the arbitrage cards re-score instead of estimate.** The machinery
   already exists — `teamTotalForTeam` in `rosterOptimizer.ts` does a real
   swap-and-rescore. The cards should call it. This converts the suite's
   headline feature from "plausible-looking" to "correct". → [01](01-fabricated-values.md#1-arbitrage-points-are-not-points)

2. **Give `CONVERSION_FACTORS` the same treatment `cutlines` got.** A manifest,
   a source URL, a retrieval date, a checksum. The IM bug found today existed
   because nothing could have caught it — there was no source to diff against.
   → [02](02-data-quality-aliasing.md#1-the-conversion-table-has-no-provenance)

3. **Turn the four prose rules into four tests.** No `?? 0` on a competition
   value; no `divisionForTeam` outside its own module; every `CONVERSION_FACTORS`
   key resolvable from `normalizeEventLabel`; every active `teamDivisions` entry
   carrying `sponsoredGenders`. Three of the four bugs fixed today would have
   been caught at commit time. → [06](06-testing-verification.md#4-encode-the-prose-rules-as-tests)

## A second pattern, visible only after fixing things

The correctness fix on 2026-08-14 (`f3355927`) shipped with an 8.3-second UI
freeze attached. The number became right and the screen became unusable, in one
commit, and only the number was verified before pushing.

That is worth naming next to the first pattern: **this codebase's failures are
consistently invisible at the point of change.** A wrong conversion factor, an
empty field lookup, a frozen main thread — none of them threw, none of them
failed a test, and each was found only by someone deliberately going to look.

The remedy is the same in every case and it is not more care: it is a cheap
mechanical check that fails loudly. Three of them are proposed in
[06](06-testing-verification.md) and [09](09-performance.md), each costing about
two hours, and each would have caught a defect that actually shipped:

- a production-server smoke test → the 404-on-every-page bug
- a `longtask` budget in CI → the 8.3 s freeze
- a `CONVERSION_FACTORS` key round-trip test → 57 fabricated conversions

## The pattern worth naming

Four separate defects fixed today shared one root cause: **a value keyed on the
wrong identity.**

- `CONVERSION_FACTORS['200 IM']` vs the canonical `'200 Individual Medley'`
- profiles keyed on raw history labels vs the meet's HyTek labels
- `buildArbitrageCards` filtering meet rows by canonical name
- `PROJECT_ROOT` derived from an entry path that moves between dev and prod

Each was invisible because the miss produced a *plausible* result rather than an
error — a slightly-wrong time, an empty list, a silent zero. That is the failure
mode this domain punishes hardest, and it argues for the same remedy each time:
**make the identity explicit and make the miss loud.** See
[04](04-architecture-complexity.md#3-event-identity-is-the-recurring-fault-line).
