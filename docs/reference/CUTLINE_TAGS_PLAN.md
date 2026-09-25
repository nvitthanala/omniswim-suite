# Cutline Data + Tags — Implementation Plan

Status: **all 5 phases complete** (2026-07-26). Branch: `feat/roster-management-overhaul`.
Verified: lint clean across 7 workspaces, `npm test` 36 passed / 0 failed / 2 skipped
(the 2 skips are pre-existing, needing `tests/test_nsisc_output.json`).

Everything in "Verified findings" below was confirmed by fetching the primary
sources and running extraction locally during planning. Nothing here is
inferred, remembered, or estimated.

---

## Part A — Verified findings

### A1. `packages/core/src/cutlines.ts` is mislabeled

The table is declared `division: 'D1'` ([cutlines.ts:86](packages/core/src/cutlines.ts:86)).
It is not D1 data.

**Structural proof.** The real NCAA D1 2026 standards publish **one** `STANDARD`
column per individual event — there is no A/B split at that level:

```
2026 Division I Men's Swimming and Diving Qualifying Standards
EVENT            STANDARD
50 Freestyle     19.43
100 Freestyle    42.55
```

The repo table has an `A` and a `B` row for all 28 individual events. A/B
individual standards are a **D2/D3/NAIA** construct, not D1.

**Numeric corroboration** (repo `time_25_26` vs. published D2 2026-27):

| Gender | Exact A+B match to D2 | Additional within 0.5s | Mean gap to real D1 |
| ------ | --------------------- | ---------------------- | ------------------- |
| Women  | 8 / 14                | 6 / 14                 | 1.79 s              |
| Men    | 4 / 14                | 6 / 14                 | 0.47 s              |

Women's rows land within 0.5s of D2 on **14/14** events while sitting 1.79s from
D1 on average. The repo table is D2.

### A2. The projection columns are fabricated

`proj_26_27`, `proj_27_28`, `proj_28_29` are not published data. Two tells:

1. Stub rows repeat one value four times — e.g. men's 200 Breaststroke is
   `1:55.12` in all four columns ([cutlines.ts:35](packages/core/src/cutlines.ts:35)).
2. Where they do vary, they disagree with what NCAA actually published for
   2026-27. Repo projects women's 50 Free at `22.39`; the real D2 2026-27
   standard is `22.48`.

Per your decision these are deleted, not relabeled.

### A3. Two live lookup bugs

**Bug 1 — D2 lookups always return "no cut".**
`getCutlinesForSwim` filters over `cutlines` (D1-only) rather than
`allCutlines()` ([cutlineUtils.ts:53](packages/core/src/lib/cutlineUtils.ts:53)),
and `D2_CUTLINE_ROWS` / `D3_CUTLINE_ROWS` / `NAIA_CUTLINE_ROWS` are all empty
([cutlines.ts:92-94](packages/core/src/cutlines.ts:92)). HSU is Henderson State,
mapped to `D2` ([teamDivisions.ts:15](packages/core/src/data/teamDivisions.ts:15)).
So for the primary workspace the filter matches zero rows, `aCutSec`/`bCutSec`
come back `0`, and `compareTimeToCutline` returns `achieved: null` for every
swimmer. It fails silently — no error, just no badge, ever.

**Bug 2 — unknown teams default to D1.**
`divisionForTeam` returns `'D1'` on no match ([teamDivisions.ts:39](packages/core/src/data/teamDivisions.ts:39)).
`data/meets.json` contains exactly 4 teams; **University of West Florida** is
absent from the map and silently resolves to D1. It is a D2 program.

There is also a substring landmine: the fallback loop does
`key.includes(known) || known.includes(key)` with `'pitt'` as a registered key,
so e.g. "Pittsburg State" (D2) would match "Pitt" (D1).

### A4. Verified sources — all live, all machine-extractable

Confirmed HTTP 200 and parsed locally with `pdfplumber` during planning.

| Division | Season  | URL |
| -------- | ------- | --- |
| D1       | 2025-26 | `ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d1/2025-26D1XSW_QUALSTANDARDS.pdf` |
| D2 Men   | 2026-27 | `ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d2/2026-27D2MSW_QualStandards.pdf` |
| D2 Women | 2026-27 | `ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d2/2026-27D2WSW_QualStandards.pdf` |
| D3 M+W   | 2026-27 | `ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d3/2026-27D3XSW_QualifyingStandards.pdf` |
| NAIA M+W | 2026-27 | `naia.org/wp-content/uploads/2026/05/2026-27-SD-Qualifying-Standards-wo-Relays.pdf` |

### A5. The four sources have four different shapes

This is the crux of the schema work. The current `CutlineRecord` fits none of
them cleanly.

| | Individual | Relays | Diving | Course |
| --- | --- | --- | --- | --- |
| **D1**   | single `STANDARD` | `QUALIFYING` **and** `PROVISIONAL` | 1M/3M/Platform, 6-dive; women also 5-dive | SCY |
| **D2**   | `A` + `B` | `QUALIFYING` = `N/A`, provisional only | 1M/3M, Dual-6 **and** Champ-11, with min DD | SCY |
| **D3**   | `A` + `B` + **`Invited`** | `NA` + provisional + `Invited` | 1M/3M × 6-dive and 11-dive | SCY |
| **NAIA** | auto + provisional | **absent from this file** | 1M/3M with min DD | **SCY *and* LCM** |

D3's `Invited` column (the actual selection cutline, distinct from the B cut)
and NAIA's metric times have no representation in the codebase today.

---

## Part B — Agent system

Four definitions in `.claude/agents/`. Frontmatter fields confirmed against
current Claude Code docs (`name`, `description`, `tools`, `model`, `effort`,
`permissionMode`, `maxTurns`, `color` are all real and current).

| Agent | Model | Effort | Tools | Owns |
| --- | --- | --- | --- | --- |
| `orchestrator` | `fable` | `high` | Read, Grep, Glob, Bash, `Agent(executor, worker, finisher)` — **no Edit/Write** | Sequencing, briefing, integration, final verification |
| `executor` | `opus` | `xhigh` | all | Schema design, extraction correctness, division resolution, scoring-adjacent logic |
| `worker` | `sonnet` | `medium` | all | Component wiring, restyles, docs against a fixed API |
| `finisher` | `haiku` | `low` | Read, Grep, Glob, Bash, Edit | Lint/test/typecheck, edge cases, no design decisions |

Standing rules baked into every definition: no git operations; concurrent
agents stay in disjoint package scopes; additive APIs only; Dark/Light/custom
tokens preserved; `--ui-*` prefix on new tokens.

`orchestrator` is deliberately denied Edit/Write so plan and execution cannot
blur. This matches the delegation model already written in `CLAUDE.md`; this
plan turns that prose into enforced configuration.

---

## Part C — Phased work

Sequencing rule from `CLAUDE.md`: land core work green before UI runs against
the reported API.

### Phase 0 — Agent system + CLAUDE.md · ~20 min · me

1. Write the four `.claude/agents/*.md` definitions.
2. Add a **Delegation contract** section to `CLAUDE.md`: which agent owns which
   scope, invocation examples, the no-git rule, the disjoint-scope rule.
3. Add a **Cutline data provenance** section: never hand-type a standard;
   every row traces to a PDF in `data/cutlines/sources/` by sha256.

### Phase 1 — Extraction pipeline · ~1.5 h · `executor` (opus/xhigh)

4. `scripts/fetch-cutlines.py` — downloads the 5 PDFs to
   `data/cutlines/sources/`, records `{url, sha256, retrievedAt, pageCount}` in
   `data/cutlines/sources/manifest.json`.
5. `scripts/extract-cutlines.py` — parses each PDF into normalized JSON.
   Per-division parsers, since the four layouts differ (A5).
6. **Hard requirement:** the script fails loudly if an expected event is
   missing or a time fails to parse. No silent defaults, no filled gaps. A
   division that cannot be fully parsed is emitted as absent, not as zeros.
7. Emit `data/cutlines/2026-2027.json` (D2/D3/NAIA) and
   `data/cutlines/2025-2026.json` (D1), overwriting the current hand-authored
   file.

### Phase 2 — Schema rebuild · ~2 h · `executor` (opus/xhigh)

8. Replace `CutlineRecord` with a discriminated union covering the four shapes
   in A5 — individual (single | A/B | A/B/Invited), relay (qual+prov | prov
   only), diving (points × dive-count × min-DD), plus a `course: 'SCY' | 'LCM'`
   axis for NAIA.
9. Delete `D1_CUTLINE_ROWS` and the `proj_*` columns. `cutlines.ts` becomes a
   thin typed loader over the generated JSON — zero literals in source.
10. Fix Bug 1: `getCutlinesForSwim` reads `allCutlines()`.
11. Replace the `CutlineSeason` union (`'25_26' | '26_27' | ...`) with real
    published-season keys; delete the projection lookup path.
12. Snapshot test asserting a spot-check row per division against the PDF text,
    so a source change fails CI instead of drifting silently.

### Phase 3 — Division resolution · ~1 h · `executor` (opus/xhigh)

13. Fix Bug 2: add University of West Florida (D2) and the rest of the NSISC
    membership to `teamDivisions.ts`.
14. Replace the substring fallback with normalized exact match + explicit alias
    list, routed through the existing `teamAliases.ts`. Kills the `'pitt'`
    landmine.
15. Change the no-match default from `'D1'` to `null`/`'unknown'` so an
    unmapped team surfaces as "division unknown" instead of quietly scoring
    against the wrong table.
16. **Auto-select division from meet teams** (your requirement): derive the
    meet's division from the resolved divisions of its teams; when teams
    disagree, tag per-athlete by their own team's division rather than forcing
    one meet-wide value.

### Phase 4 — Tag model + UI · ~2 h · `worker` (sonnet/medium)

17. `CutlineTag` type in core: `{ division, season, standard, course, sourceUrl }`,
    derived — never hand-set.
18. `<CutlineTag>` in `packages/ui`, built on the existing `Badge` tones
    (`accent` for A, `warning` for B, `info` for D3 Invited).
19. Refactor `TeamCard.tsx` — the hardcoded A CUT / B CUT spans at
    [lines 364-365](packages/matrix/src/components/TeamCard.tsx:364) and
    [941-942](packages/matrix/src/components/TeamCard.tsx:941) — onto the shared
    component.
20. Surface tags in Manager roster and lineup editor. Tooltip shows division,
    season and standard so a tag is self-explaining.

### Phase 5 — Verification · ~45 min · `finisher` (haiku/low)

21. Lint + typecheck + full test run green.
22. Confirm the live symptom is gone: an HSU swimmer under the D2 table now
    renders a cut tag where today it renders nothing.

**Total: ~7.5 h of agent time across 5 phases.**

---

## Part D — Explicit non-goals

- No git operations. Diffs only, per `CLAUDE.md`.
- NAIA relays are **not** in the published file. They will be absent, not
  invented. If you want them, they need a separate source located first.
- No projected/future-season standards of any kind. Published seasons only.
- Conference-level (NSISC) standards are out of scope — this is
  national-championship qualifying data.

## Part F — Correction round (2026-07-26, post-review)

The user flagged that Lindenwood's swimming program no longer exists. Verified —
and the entry was wrong in **two** independent ways:

1. **Program discontinued** after 2023-24 (both men's and women's; their
   athletics site labels each "(Discontinued)").
2. **`D2` was wrong even while it existed.** Lindenwood completed its move to
   **D1** in July 2022 (OVC; swimming affiliated to the Summit League). D2 was
   only correct pre-2022.

A full audit of the remaining unverified entries then found a **second dead
program**: Oklahoma Baptist cut men's and women's swimming & diving after
2020-21, confirmed from OKBU's own newsroom.

Fixes landed: `TeamDivisionEntry` gained `status`, `lastActiveSeason`,
`divisionHistory`, `sources` and `verifiedOn`; a new `program_discontinued` tag
state maps to `unknown` (never `no_cut`); `divisionForTeamInSeason()` answers
division-at-a-point-in-time. `provenance: 'legacy'` is now banned by test.

Independent re-verification: 80 individual cutline rows were re-parsed from the
archived PDFs using a **second, separate implementation** (not
`extract-cutlines.py`) — **zero discrepancies**.

### Known limitation

**University of West Florida sponsors women's swimming & diving only.** The
registry is school-level, so a men's UWF swim still resolves to D2. Per-gender
program sponsorship is not modelled. Follow-up, not a regression.

---

## Part G — Live UI verification (the step that caught the real bug)

Ran the app against the real HSU NSISC workspace. **Every tag rendered "unknown"**,
tooltip: *"NCAA D2 2026-2027 does not publish a standard for **Event 8 Me**…"*.

Cause: `normalizeEventForCutline` never handled HyTek's meet-result label format.
57 of the 83 distinct event strings in `data/meets.json` use
`Event <N> <Gender> <dist> Yard <stroke>`, and relays are labelled by leg
(`4x200 Yard Freestyle Relay`) while the published tables use total distance
(`800 Freestyle Relay`). **Pre-existing, not a regression** — invisible until now
because D2 had no rows at all, so nothing rendered either way.

Fixed in `cutlineUtils.ts`: entry-number/gender/course/Time-Trial stripping, and
relay legs×distance derived rather than hardcoded. Diving now returns a
`not_a_timed_event` status, and the tag layer maps it to `not_applicable` so a
points total can never be read as a slow time.

**meets.json coverage: 83 labels → 67 published · 12 legitimately no standard ·
4 diving · 0 unaccounted.** A data-driven test fails loudly if any label regresses
back to unknown.

### Confirmed working in the live app

34 `D2 B CUT` badges, tooltip *"NCAA D2 2026-2027 B standard — 20.36"*. Spot-checked
against the table (A 19.39 / B 20.36):

| Swimmer | Time | Tag | Correct? |
| --- | --- | --- | --- |
| River Paulk | 19.42 | `D2 B CUT` | yes — 0.03 off the A cut, correctly *not* A |
| Olivér Pózvai | 20.22 | `D2 B CUT` | yes |
| Noel Kis | 20.02 | `D2 B CUT` | yes |
| Oliver Pozvai | 20.28 | `D2 B CUT` | yes |

Also fixed: `apps/shell/server.ts` hardcoded `2025-2026` as the API default while
`index.json` said `2026-2027`, so `GET /api/cutlines` served the D1 table to a D2
workspace. It now reads the generated index. (Endpoint has no UI consumer yet.)

## Part I — User decisions, resolved (2026-07-26)

1. **Time trials — keep tagging.** User: *"time trials are okay, they don't count
   for meet scoring, just recording sanctioned races."* No code change; current
   behavior already correct. Confirmed they remain excluded from scoring at
   `utils.ts:445` and `utils.ts:1147`.
2. **`relaySplitQualificationCutEvent` — fixed with a fallback.** Now tests the
   normalized name, falling back to the original raw-label check so the rule
   cannot silently stop firing if the normalizer changes. `Event 20 Men 4x100
   Yard Medley Relay` → `100 Backstroke` (returned `null` before). 200 MR
   leadoff deliberately left alone: the rule could not be verified, and it would
   be inert anyway since no table here publishes a 50 Backstroke standard — a
   test pins that so the justification breaks loudly if one ever does.
3. **Manager rollout — fixed.** Tags added to `AthleteCreditedSwimsPanel`, the
   panel that actually holds this workspace's times. Verified live: Nojus
   Skirutis 200 IM 1:48.93 → `D2 B CUT` (B 1:49.53), 400 IM 3:55.11 → `D2 B CUT`
   (B 3:58.26), 200 Fly 1:47.40 → `D2 B CUT` (B 1:49.72). Relay legs left
   untagged — a leg split is not an individually-eligible standard.
4. **Course eligibility — implemented.** User: *"no LCM data for NCAA
   qualifications. Converted times are good for a 'loose' fit but you need to
   record a yards swim under qualifying time to qualify or gain a cutline."*

   Only an SCY swim can earn a cut. A metric swim whose converted time clears a
   standard now returns `converted_estimate` → a **fourth** render mode
   `'indicative'`, labelled `D2 A CUT (CONVERTED)`, styled as a dashed italic
   ghost of the real badge — never solid, never confusable with an earned cut,
   and never folded into `unknown`. A metric swim with no published conversion
   factor (relays) returns `conversion_unavailable` rather than a guess.

   Two course concepts are now distinct at every call site: `tableCourse` (which
   published table to read) vs `swimCourse` (what the swim was recorded in).
   This also fixed a live bug where `AthleteLineupEditorPanel` fed a swim's
   course into the table parameter, making every LCM history row render
   "unknown".

## Part J — Relay verdicts + near-miss margins (2026-07-26)

Triggered by the user asking whether relay cuts were tracked properly. They were —
all five relay standards load and a 400 MR team time of 3:10.00 tags
`D2 PROVISIONAL` — but the display had two defects and the check surfaced a third
insight.

### 1. A relay leg row carries two verdicts; one was destroying the other

`relaySplitQualificationCutEvent` made the leadoff leg's individual verdict
*replace* the relay's, so the leadoff swimmer's row never showed that the relay
made the cut. Core gained `buildRelaySwimTags` / `buildRelaySwimTagsForTeam`
returning `{ relay, legQualification }` — both independently present, both
independently null-able. Eligibility stays in `utils.ts` and is passed **in** as a
parameter, so there is still exactly one implementation of the rule and no import
cycle.

### 2. Anchoring fixed the "repeats 3×" complaint

The relay verdict describes the relay, not the swimmer, so it now renders beside
the relay team time rather than the swimmer's name. Deliberately **not** deduped —
legs are sorted by points and may not be adjacent, so tagging one arbitrary row
would be worse. Live result:

```
E31 4X50FR-R
1  Gavin Kock         Split: 20.46   Relay 1:20.21   −0.33 → D2 PROVISIONAL
1  Tristen Fergunson  Split: 20.03   Relay 1:20.21   −0.33 → D2 PROVISIONAL
```

### 3. Near-miss margins — nothing in this meet qualified

`CutlineTagResult.nextTier` reports the distance to the strictest tier *not*
reached: the next tier up on a `tagged` result, the easiest tier on a `no_cut`.
`null` when the strictest was cleared or there is no table — **never `0`**, which
would read as "exactly on the standard". Pure arithmetic over published values;
no threshold in core.

Verified live, all matching hand-computed values:

| Swim | Margin |
| --- | --- |
| River Paulk 19.42 50 Free | `D2 B CUT` **+** −0.03 → D2 A CUT |
| HSU 4x50 Free 1:20.21 | −0.33 → D2 PROVISIONAL |
| HSU 4x50 Medley 1:28.08 | −0.74 → D2 PROVISIONAL |
| HSU 4x100 Medley 3:15.24 | −2.79 → D2 PROVISIONAL |
| HSU 4x200 Free 6:35.82 | −3.14 → D2 PROVISIONAL |

38 near-miss chips render where previously the whole meet showed only 34 badges
and no margins.

### Calibration — settled at 2.5%, pure percentage

`NEAR_MISS_RELATIVE_THRESHOLD = 0.025` in `packages/ui/src/components/CutlineTag.tsx`.

A flat "or 1 second" floor was evaluated against every published D2 men's
standard and **rejected on the data**:

- It **only ever binds on the 50 Freestyle.** Every other event's 2.5% window is
  already wider than a second (100 Free 1.13s, 200 Free 2.47s, 1650 23.86s). It
  is not a scaling rule, it is a special case for one event.
- On that one event it does harm. The 50 Free A/B standards are 19.39 / 20.36 —
  a **0.97s** gap. A 1s window is *wider than the whole tier gap*, so every
  swimmer who earned a B would also be flagged "near" the A. The chip would
  restate the badge instead of adding to it.

**Why a percentage is already the right scaling:** the NCAA's own tier spacing is
proportional. The A→B gap is ~4.7% of the standard on every event, so 2.5% lands
at a near-constant **~53% of one tier gap** program-wide — 0.51s of 0.97s in the
50 Free, 1.22s of 2.31s in the 100 Back, 23.86s of 45.44s in the 1650. The scale
problem an absolute floor was meant to fix does not exist, because the standards
are already scaled.

Tuning guidance recorded in code: stay below ~4.7%, where the window equals a
full tier gap and the chip becomes redundant with the badge.

**Result:** 38 → **69** near-miss chips. The case that motivated the change now
shows, and demonstrates the dual verdict in one row:

```
Avery Henke   A Final
  Split: 49.58                  −0.98 → D2 B CUT          (his leg)
  Relay 3:15.24                 −2.79 → D2 PROVISIONAL    (the relay)
```

## Part H — Open decisions for the user

1. **✅ RESOLVED 2026-09-13 — keep tagging time trials.** `Event 300 Men 50
   Yard Freestyle Time Trial` gets tagged like any other swim, and this plan
   originally recommended excluding it on the assumption that NCAA cuts must
   be achieved in sanctioned competition. **User correction: time trials
   don't score meet points, but the times themselves are legal for cutline
   purposes** — so a cut badge on a time-trial swim is correct, not a false
   positive. No code change needed; the plan's own recommendation above was
   wrong, kept struck through rather than deleted per this repo's "record
   corrections in place" convention.
2. **✅ ALREADY FIXED (found already resolved 2026-09-13, no code change
   needed).** `relaySplitQualificationCutEvent` (`packages/core/src/lib/utils.ts:2073`)
   now reads the distance off `normalizeEventForCutline`'s normalized event
   name (which folds `4x100 … Medley Relay` into `400 Medley Relay`) before
   falling back to the raw-label `/\b400\b/` test this item originally
   flagged as broken. The old raw-only test is kept as a documented,
   never-narrowing fallback. Covered by `scripts/test_cutlines.mjs` and
   `scripts/test_cutline_tags.mjs`, both passing.
3. **Manager rollout is thin.** In overlay mode the panels that got tags
   ("Individual entries", "Supplemental history") are empty for this workspace;
   the panel holding the times (**Credited swims**) was skipped as too dense.
   Matrix is where tags are actually visible today.
4. **Metric labels.** `50 Meter Freestyle` normalizes to `50 Freestyle` and would
   be judged against the yards table at the default `course: 'SCY'`. No metric
   labels exist in `meets.json` today; a live trap if LCM results are imported.

---

## Part K — Conversion, provenance and NAIA course round (2026-09-22 to 2026-09-24)

Plan: `plans/2026-09-22/01-CONVERSION-AND-IMPROVEMENTS-PLAN.md`. Progress log:
`docs/reference/IMPROVEMENTS_2026-09-22_STATE.json`.

### New cut-tag states

Three states were added to the tag model, all for a swim that must never be
confused with an earned cut:

- **`converted_estimate`** — a swim converted from LCM or SCM to SCY clears a
  yards standard. Already existed as a concept (Part I item 4, "loose fit");
  it now also names the exact conversion basis (`ScyConversionProvenance`:
  the table id, the source time, and the truncation) so the badge's tooltip
  can cite it, e.g. "SCM 54.49 -> 48.82, NCAA Rules Book A-2 (D2)."
- **`user_inputted`** — a SwimCloud self-reported (`U`-tagged) time. Shown,
  never a cut, never a best, never an entry.
- **`extracted_split`** — a time taken out of a longer swim's splits
  (`X`-tagged). Same treatment as `user_inputted`.

Both `user_inputted` and `extracted_split` route through
`isRankableSwim` (`packages/core/src/lib/bestTimeEligibility.ts`; see
`docs/INVARIANTS.md` #8), the one gate every best-time reader now shares.

### Division SCM conversion tables and their PDF sources

`NCAA_SCM_CONVERSION_TABLES` (`packages/core/src/constants.ts`) holds two
tables, both transcribed 2026-09-22 from the archived qualifying-standards
PDFs and cross-checked against `pdftotext -layout` output
(`tests/courseConversionDivision.test.ts` re-reads the PDFs when `pdftotext`
is installed):

| Table id | Source PDF(s) (manifest id) | Page | Applies to |
| --- | --- | --- | --- |
| `ncaa-rules-book-a2-2026-27` | `2026-27D2MSW_QualStandards.pdf` / `2026-27D2WSW_QualStandards.pdf` (`ncaa-d2-men-2026-27`, `ncaa-d2-women-2026-27`) | 2, "Conversions" | D2, D3, NAIA, and any team of unresolved division (default) |
| `ncaa-d1-2025-26` | `2025-26D1XSW_QUALSTANDARDS.pdf` (`ncaa-d1-2025-26`) | 3, "Conversions" | Division I only |

Both sheets publish the same four rows (`free400To500`, `free800To1000`,
`free1500To1650`, `allOtherEvents`) and the same procedure: convert to
seconds, multiply by the factor to five decimal places, **truncate** (never
round) below the hundredth, convert back. `convertSwimToSCYDetailed`
implements exactly this and reports which table it used
(`NcaaScmConversionTableId`). D3 and NAIA publish no factor table of their
own, so both fall back to the Rules Book table, and the conversion result
says so (`reason: 'division_publishes_none'`) rather than hiding the choice.
100 IM and 25-yard/meter events, which sit outside the three named distance
rows, take `allOtherEvents` (user decision 2026-09-24, `scmAllOtherEvents` in
the state log) — guarded by `tests/scmAllOtherEventsConversion.test.ts`.

### NCAA altitude table

`NCAA_ALTITUDE_ADJUSTMENT_TABLE` (`packages/core/src/lib/altitude.ts`), five
rows pairing a yards distance with a metres distance (100, 200, 500y/400m,
1000y/800m, 1650y/1500m), sourced from the same archived PDFs' "Altitude"
section. `adjustSwimForAltitude` applies it only to a swim that states its
own elevation and gives an unadjusted time — never to a SwimCloud swim
already flagged `isAltitudeAdjusted` (see `docs/INVARIANTS.md` #9). A 50 is
not in the chart (`event_not_in_table`, never a zero adjustment). A 400-yard
IM taking the "500 Yards/400 Meters" row is `ALTITUDE_400_YARD_IM_USER_DECISION`
— a user decision dated 2026-09-24, not an NCAA reading, and every adjustment
made this way reports `rowBasis: 'user_decision'` so it never passes as a
sourced table value. Guarded by `tests/altitudeAdjustment.test.ts`.

### NAIA meters-as-SCM decision

The NAIA 2026-27 qualifying-standards sheet
(`2026-27-SD-Qualifying-Standards-wo-Relays.pdf`, manifest id `naia-2026-27`)
heads its metric column "METERS" and never states a pool length. NAIA's own
2020-21 sheet heads the identical column "SCM" — archived as evidence only,
manifest id **`naia-2020-21-course-evidence`**, under
`data/cutlines/sources/manifest.json`. Per the user's 2026-09-24 decision,
NAIA metric standards are read as short-course meters.

The generated cutline data is untouched; only the loader's interpretation
changed. The named decision constant **`NAIA_2026_27_METERS_AS_SCM`**
(`packages/core/src/cutlines.ts`) records this, and the loader refuses to
load a metric record that has no matching named decision — so a future
re-fetch of the NAIA sheet needs a new, explicit decision rather than
silently inheriting this one. `cutlineTableCourseForSwim` reads the decision
so an NAIA team's SCM swim gets a direct verdict against the NAIA table,
while its LCM swims still convert to yards as a `converted_estimate` (see
`docs/INVARIANTS.md` #11). `scripts/fetch-cutlines.py` carries the
evidence-only entry forward on a re-fetch, and `scripts/extract-cutlines.py`
skips it, so re-extraction still works. Guarded by
`tests/naiaMeterCourseAsScm.test.ts`.

---

## Part L — Next-round follow-ups (2026-09-25)

Plan: `plans/2026-09-24/01-NEXT-ROUND-PLAN.md`. Progress log:
`docs/reference/NEXT_ROUND_2026-09-24_STATE.json`.

### Events a course does not swim (item B4)

User decision (2026-09-24): "there is no such event, the 1000 is never swum
in SCM." A new cut-tag state, **`event_not_swum_in_course`**, covers a swim
whose event its recorded course does not swim. It renders as `unknown`, with
the reason as its tooltip, and the result carries `courseMismatch` (the
event, the course, the event that course swims instead, and the sourced
pair). It is checked before the division, because the answer does not
depend on the division. No standard applies: it is neither a cut nor a miss.

The rule rests on one sourced pairing, `COURSE_DISTANCE_PAIRS` in
`packages/core/src/lib/courseEvents.ts`. No event list is hand-typed. Each
pair cites the archived PDFs that print it, verbatim:

| Pair | Yards (SCY) | SCM | Printed as (manifest id, page) |
| --- | --- | --- | --- |
| `free-500y-400m` | 500 Freestyle | 400 Freestyle | "400 meters to 500 yards" (`ncaa-d2-men-2026-27` p2, `ncaa-d2-women-2026-27` p2, `ncaa-d1-2025-26` p3); "500/400 FREESTYLE" (`naia-2026-27` p1, `naia-2020-21-course-evidence` p1) |
| `free-1000y-800m` | 1000 Freestyle | 800 Freestyle | "800 meters to 1000 yards" (D2 men's and women's p2); "800 meters to 1,000 yards" (D1 p3). NAIA contests no 1000/800. |
| `free-1650y-1500m` | 1650 Freestyle | 1500 Freestyle | "1500 meters to 1650 yards" (D2 p2); "1,500 meters to 1,650 yards" (D1 p3); "1650/1500 FREESTYLE" (both NAIA sheets) |

The NCAA table converts "a metric time achieved in a 25-meter racing course"
to "a 25-yard racing course", so its metric side is SCM. The NAIA 2020-21
sheet heads its metric column "SCM". The NCAA D1, D2 and D3 25-yard event
lists corroborate the yards side: none names an individual 400, 800 or 1500
Freestyle. `tests/courseEventMismatch.test.ts` snapshots every label and
re-reads each PDF page when `pdftotext` is installed.

What the rule does not cover, because no archived source states it:

- **LCM.** No archived sheet lists the long-course events, so a 1000
  Freestyle recorded LCM still converts with the indicative
  `CONVERSION_FACTORS` row. A source such as a USA Swimming long-course
  time-standards sheet would be needed to flag it.
- **Other events**, for example a 100 IM or a 50 of stroke in LCM. The
  championship lists name the events a body contests, not every event that
  exists in a course, so they cannot prove a negative.
- **A course nobody recorded.** The SCY default for a silent label is an
  assumption, and an assumption cannot prove an event absent.

### Computed cut and tooltip for an NAIA SCM swim (item B1)

The cut tag has judged an NAIA team's SCM swim against the NAIA SCM column
since 2026-09-24 (Part K). The stored `computedCut` badge did not: both of
its writers, `enrichWithComputedCut` (`athleteHistory.ts`, the paste
parsers) and `buildStoredSwim` (`rosterCatalog.ts`, the roster catalog),
skipped every metric swim. Both now call `computedCutInOwnCourse`
(`cutlineUtils.ts`), which judges the recorded time only in a table of the
swim's own course (`cutlineTableCourseForSwim`). An NAIA SCM swim gets its
NAIA verdict; every other metric swim still gets `null`, because its
converted time is an estimate. The import panel's badge tooltip now comes
from `computedCutTooltip` (`cutlineTags.ts`), which quotes the standard in
the swim's own course and names the governing body correctly ("NAIA", not
"NCAA NAIA"). Guarded by `tests/naiaScmComputedCut.test.ts`, which also
checks that the badge and the cut tag agree on every row of a real
swimmer's block.

---

## Part E — Open risk

The NCAA may republish a PDF at the same URL with revised times (the D1 file
already carries an `UPDATED 7/24/2025` stamp). The sha256 manifest in step 4
detects this; it does not auto-resolve it. Re-running the fetch script after a
revision is a manual call.
