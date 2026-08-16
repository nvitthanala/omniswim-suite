# 11 — Sequencing

Ten documents of findings is not a plan. This is the order to do them in, why
that order, and what blocks what.

Effort figures are rough and assume the person doing it has the context in these
documents. "Session" means a focused half-day.

---

## The dependency that governs everything

Three findings are coupled and must go in this order:

```
  aliasing fix (02 §2)
        │  a split athlete's history is divided, so every quality
        │  ratio and every point delta computed for them is suspect
        ▼
  conversion-factor provenance (02 §1)
        │  ratios are computed against converted times; if a factor
        │  is wrong the ranking is wrong in a way no test can see
        ▼
  trust the numbers the app shows
```

Everything in [01](01-fabricated-values.md) and
[03](03-scoring-model-depth.md) sits downstream of those two. The top arbitrage
card today is `Alan Alejan Gonzalez Mujica +40.5` — and he is one half of a split
athlete. That number is arithmetically correct and may still be wrong about the
world.

**Consequence: do not build more on the numbers until the inputs are clean.**

---

## Round 0 — added 2026-08-15, ahead of everything

| # | Task | Effort | Doc |
| - | ---- | ------ | --- |
| 0 | **`buildScorerRosterLookup` ignores recorded aliases.** Four linked athletes still occupy two scorer slots each and can be entered in 14 events. The user made the link; it was stored and discarded. | 1 session + verification | [02 §2a](02-data-quality-aliasing.md#2a-recorded-aliases-are-ignored-by-the-scorer-roster) |

This displaces the dependency chain below: the aliasing *data* turned out to be
clean already, so what gates trusting the numbers is not linking athletes — it is
making the existing links count. Do this before anything that reads a team total.

It changes team totals, so it needs before/after capture and its own review. Audit
the other name-keyed consumers in the same pass; the resolver is opt-in, so
forgetting it is the default.

## Round 1 — stop the bleeding (about one day)

Small, independent, each removes a live risk. No dependencies between them.

| # | Task | Effort | Doc |
| - | ---- | ------ | --- |
| 1 | Bind `127.0.0.1` by default; make the banner state the real bind address and auth status | 1 h | [10 §1](10-security-exposure.md#1-the-server-listens-on-every-network-interface-with-no-authentication) |
| 2 | Unmount the upload middleware while `/api/analyze-video` returns 501 | 5 min | [10 §2](10-security-exposure.md#2-unauthenticated-file-upload-writes-outside-the-project-directory) |
| 3 | `enrichWithComputedCut` → `divisionForTeamOrNull`, emit `unknown` not `no_cut` | 1 h | [01 §2](01-fabricated-values.md#2-an-unmapped-team-is-still-scored-against-the-d1-table) |
| 4 | Prettier `authMiddleware.ts` | 2 min | [10 §4](10-security-exposure.md#4-authmiddlewarets-is-one-1600-character-line) |
| 5 | Rename `Blank Workspace 1`; auto-name workspaces from the loaded meet | 2 h | [05 §1](05-ux-workflow.md#1-the-demo-workspace-is-called-blank-workspace-1) |

**Why first:** items 1–2 are the only findings where the failure mode is someone
else's action rather than a wrong number. Item 3 is a rule the repo already
states and does not follow. Item 5 is the cheapest legibility win in the folder.

---

## Round 2 — make the inputs trustworthy (two to three sessions)

| # | Task | Effort | Doc |
| - | ---- | ------ | --- |
| 6 | Conversion-factor test: every `CONVERSION_FACTORS` key must round-trip through `normalizeEventLabel` | 15 min | [06 §4](06-testing-verification.md#4-encode-the-prose-rules-as-tests) |
| 7 | Duplicate-athlete detection as a standing checklist item, with dismissal recorded | 1 session | [02 §2](02-data-quality-aliasing.md#2-four-athletes-are-still-two-people-each) |
| 8 | Resolve the four known clusters; decide `Afonso` vs `Alfonso` from a source | 1 h | [02 §2](02-data-quality-aliasing.md#2-four-athletes-are-still-two-people-each) |
| 9 | Conversion-factor provenance: source doc, manifest, checksum, parsed JSON | 1 session | [02 §1](02-data-quality-aliasing.md#1-the-conversion-table-has-no-provenance) |
| 10 | Reject implausible parsed distances (`375 Freestyle`) loudly at the parse boundary | 2 h | [02 §3](02-data-quality-aliasing.md#3-junk-events-reach-the-history-store) |

**Item 6 first, and today.** Fifteen minutes for the assertion that would have
caught 57 fabricated conversions.

**Open question blocking item 9:** does any governing body actually publish these
conversion factors? If not, the whole table is indicative rather than official and
should be labelled that way — which changes what the ratio in the roster tooltip
is allowed to claim.

---

## Round 3 — pay down what makes the rest expensive (three to four sessions)

| # | Task | Effort | Doc |
| - | ---- | ------ | --- |
| 11 | Production-server smoke test in CI | 2 h | [06 §3](06-testing-verification.md#3-no-test-drives-the-production-server) |
| 12 | `longtask` budget in CI — no step blocks >500 ms | 2 h | [09 §4](09-performance.md#4-what-is-worth-measuring-next) |
| 13 | Generate and hand-check `tests/test_nsisc_output.json`; un-skip the two scoring tests | 2 h | [06 §1](06-testing-verification.md#1-three-tests-are-permanently-skipped) |
| 14 | Split `crossCourseArbitrage.ts` (2,255 lines) into four modules plus shared projection | 1 session | [04 §1](04-architecture-complexity.md#1-the-2255-line-module) |
| 15 | Investigate why the incremental fast path does not engage; remove the scan button | 1 session | [09 §1](09-performance.md#1-the-arbitrage-scan-blocked-the-main-thread-for-83-seconds) |

Items 11–13 are guards: each one would have caught a defect that actually
shipped. They are the highest value-per-hour work in this folder and they get
cheaper to write, not more expensive, the earlier they land.

**Item 14 blocks item 15** — investigating the fast path inside a 2,255-line file
that owns four jobs is materially harder than inside a 400-line one.

---

## Round 4 — the structural bet (one to two weeks)

| # | Task | Effort | Doc |
| - | ---- | ------ | --- |
| 16 | Branded `CanonicalEvent` type so event lookups cannot miss silently | 1–2 days | [04 §3](04-architecture-complexity.md#3-event-identity-is-the-recurring-fault-line) |
| 17 | Split `utils.ts`; move `calculatePoints` into `scoringEngine.ts` | 1 day | [04 §2](04-architecture-complexity.md#2-utilsts-is-a-junk-drawer) |
| 18 | Relay ranking — surface the arbitrary choice, then rank by leg quality | 1 session + | [03 §1](03-scoring-model-depth.md#1-relays-are-ranked-by-nothing) |
| 19 | Docs reorganisation; `docs/INVARIANTS.md`; `CHANGELOG.md` | 1 session | [08](08-docs-knowledge-debt.md) |

**Item 16 is the one worth arguing for.** Four separate defects fixed on
2026-08-14 were the same bug: a value keyed on one identity, looked up by another,
failing silently into a plausible answer. A branded type turns that entire class
into a compile error. Everything else in this folder describes a bug; item 16
prevents a category of them.

---

## Deliberately not scheduled

- **Projection uncertainty bands** ([03 §4](03-scoring-model-depth.md#4-the-projection-has-no-uncertainty)).
  The best *product* idea in the folder, and it must wait for round 2 — a band
  computed from a split athlete's divided history would be confidently wrong in a
  new and more persuasive way.
- **Video analysis (E1–E3).** Excluded by instruction. Still gated on the same
  thing: no real race has been tagged by hand.
- **Diving in the roster model** ([03 §2](03-scoring-model-depth.md#2-diving-is-excluded-everywhere-silently)).
  Needs a one-line answer from you — does HSU field divers? — before it is worth
  any work at all.

---

## Open questions, collected

Each of these changes what gets built, and none can be resolved by reading code:

1. **Who is the second user?** ([05 §6](05-ux-workflow.md#6-open-question-who-is-the-second-user)) — governs how much explanation the UI owes.
2. **Does a governing body publish course-conversion factors?** ([02 §1](02-data-quality-aliasing.md#1-the-conversion-table-has-no-provenance)) — governs whether ratios are official or indicative.
3. ~~**Does HSU field divers?**~~ — **answered from data 2026-08-16: no, zero.**
   OBU (5), Delta State (4) and UWF (4) do. Excluding diving costs HSU nothing
   today; it would cost any of those three up to ~120 points.
   ([03 §2](03-scoring-model-depth.md#2-diving-is-excluded-everywhere-silently))
4. **Should time trials count toward cut tagging?** ([03 §3](03-scoring-model-depth.md#3-time-trials-score-nothing-but-can-still-earn-a-cut)) — they score nothing but are officiated swims.
5. **`Afonso` or `Alfonso` Campanico?** ([02 §2](02-data-quality-aliasing.md#2-four-athletes-are-still-two-people-each)) — one source is wrong; only you can say which.
6. **Is the desktop-copy launcher flow still real?** ([07 §2](07-packaging-offline-ops.md#2-the-two-launchers-behave-very-differently))
7. **Should the seed be a demo dataset rather than a snapshot of live working state?** ([07 §3](07-packaging-offline-ops.md#3-demodata-depends-on-a-gitignored-file--resolved-worth-keeping-resolved))
8. **Is anything backing up `data/omniswim.db` today?** ([07 §6](07-packaging-offline-ops.md#6-backups-exist-and-are-unattended))

Answering 2, 3 and 4 unblocks the most work per sentence.
