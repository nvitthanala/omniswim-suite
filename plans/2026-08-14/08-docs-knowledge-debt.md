# 08 — Documentation and knowledge debt

**Severity: P2 throughout.** No correctness consequence, real onboarding and
navigation cost.

---

## 1. Eighteen markdown files in the repository root

| File | Size | Last touched | State |
| ---- | ---- | ------------ | ----- |
| `PHASE4_PLAN.md` | 2.8 KB | 2026-06-28 | **stale** |
| `PHASE2_PROGRESS.md` | 17.8 KB | 2026-06-28 | **stale** |
| `PHASE3_PROGRESS.md` | 2.9 KB | 2026-06-28 | **stale** |
| `CHART_BLANK_HANDOFF.md` | 15.1 KB | 2026-06-28 | **stale** — issue resolved |
| `ROSTER_CATALOG_NOTES.md` | 4.8 KB | 2026-08-03 | current |
| `CUTLINE_TAGS_PLAN.md` | 21.4 KB | 2026-08-03 | current, valuable |
| `MATRIX_RESCORE_OVERHAUL_HANDOFF.md` | 11.7 KB | 2026-08-03 | likely superseded |
| `PERFORMANCE_NOTES.md` | 6.3 KB | 2026-08-03 | current |
| `PHASE3_UI_PROGRESS.md` | 22.6 KB | 2026-08-03 | historical |
| `ROSTER_ALIAS_DECLUTTER_HANDOFF.md` | 9 KB | 2026-08-03 | historical |
| `ROSTER_LINEUP_BUGS_DEEPDIVE.md` | 24.9 KB | 2026-08-03 | historical, valuable |
| `ROSTER_DATA_OVERHAUL_HANDOFF.md` | 17.6 KB | 2026-08-03 | historical |
| `ROSTER_LINEUP_PROGRESS.md` | 2.7 KB | 2026-08-03 | historical |
| `VIDEO_ANALYSIS_MASTERPLAN.md` | 75 KB | 2026-08-03 | current (out of scope here) |
| `VIDEO_TAGGING_FRAMEWORK.md` | 18.4 KB | 2026-08-05 | current (out of scope here) |
| `SUITE_ROADMAP.md` | 26.5 KB | 2026-08-05 | **the live one** |
| `README.md` | 11.2 KB | 2026-08-03 | current |
| `CLAUDE.md` | 9.7 KB | 2026-08-03 | **the operating contract** |

That is ~300 KB of prose, four files untouched since June describing work that
has since shipped, and no index. `SUITE_ROADMAP.md` is the live plan but is
indistinguishable by position from `PHASE2_PROGRESS.md`.

### Proposed

```
docs/
  archive/2026-06/     PHASE2, PHASE3, PHASE4, CHART_BLANK_HANDOFF
  archive/2026-08/     ROSTER_* handoffs, PHASE3_UI_PROGRESS, MATRIX_RESCORE_*
  reference/           CUTLINE_TAGS_PLAN, PERFORMANCE_NOTES, ROSTER_CATALOG_NOTES
  video/               VIDEO_ANALYSIS_MASTERPLAN, VIDEO_TAGGING_FRAMEWORK
plans/2026-08-14/      this folder
README.md              stays
CLAUDE.md              stays
SUITE_ROADMAP.md       stays
```

Root drops from 18 files to 3. Nothing is deleted — the historical handoffs
contain the *reasoning* behind current behaviour (`ROSTER_LINEUP_BUGS_DEEPDIVE.md`
in particular) and are worth keeping findable.

**Effort:** ~1 hour including fixing cross-links.

---

## 2. `CLAUDE.md` is now partly out of date

**The most important doc to correct**, because it is the operating contract that
agents and contributors read first.

Specifically:

- §"Known Bugs & Follow-up Items (2026-07-19 round — all three FIXED, live UI
  verification pending)". Live UI verification **has** now happened: all three
  were exercised in the running app today. The heading should say so.
- The data-provenance section should gain the conversion-factor rule from
  [02](02-data-quality-aliasing.md#1-the-conversion-table-has-no-provenance)
  once that work lands — it currently covers cutlines only, which is exactly the
  gap the IM bug fell through.
- It should record the new rule established today: **the loaded meet defines the
  enterable program; a hardcoded event list is a fallback, never the authority.**
  That is a non-obvious invariant a future contributor would otherwise undo.

**Effort:** ~1 hour.

---

## 3. `SUITE_ROADMAP.md` needs a status pass

It records workstreams A–D as delivered and E as remaining, which is accurate.
Two corrections:

- §0.1 *"Known follow-up: `BaselineDiffPanel` does not receive `rosterCatalog`"*
  — still open, still correctly described. Should move into a tracked list rather
  than living in a paragraph.
- §6 "Measured UI findings" reports 27 buttons on Manager / 22 on Matrix with 2
  unnamed each. The unnamed ones were fixed today (`ad616e69`); the counts should
  be re-measured or marked as of-date.

---

## 4. Undocumented invariants that cost time to rediscover

Things true of this codebase that are not written down anywhere, each of which
cost real time today:

1. **`data/meets.json` is gitignored but tracked**, and is the seed for a fresh
   clone. Deleting it from git silently removes all demo data from new checkouts.
2. **The dev and prod servers resolve `PROJECT_ROOT` from different depths.**
   Fixed, but the reason is worth a comment in the launcher scripts too.
3. **Meet result rows carry HyTek labels** (`Event 22 Men 500 Yard Freestyle`),
   not canonical event names. Nearly every cross-referencing bug this session
   traced to someone forgetting this.
4. **Playwright asserts against `dist/`,** so `npm run build` must precede
   `npm test` or the e2e result is stale. (This one *is* in memory but not in the
   repo.)
5. **`calculatePoints` lives in `utils.ts`,** not `scoringEngine.ts`.

**Proposed:** a single `docs/INVARIANTS.md`, one short paragraph each. This is
the highest-value doc in this section — it is what a new contributor (or agent)
needs and cannot infer.

**Effort:** ~1 hour.

---

## 5. No changelog

Four commits today changed user-visible numbers (event rankings, arbitrage
suggestions, entered events). There is no record a user of the app would ever
see.

For a tool whose output a coach acts on, "the numbers changed and I do not know
why" is a trust problem. A `CHANGELOG.md` with a line per user-visible behaviour
change — especially *"athletes may now be entered in different events; here is
why"* — is worth more here than in most projects.

**Effort:** ~1 hour to start, minutes per change after.
