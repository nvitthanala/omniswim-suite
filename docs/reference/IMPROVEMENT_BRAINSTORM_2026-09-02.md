# Improvement brainstorm — 2026-09-02

Orca-orchestrated (`run_5d17f1d5f749`), planning only — nothing here is
implemented. Dispatched to a fresh Codex worker and a fresh Cursor worker
in parallel. Cursor stalled on repeated per-command permission prompts in
this environment (consistent with a locally-reported Avast interference
issue) and never reached `worker_done`; its terminal was left running
rather than force-abandoned, since it may still finish unattended. This
document carries Codex's full output, spot-checked (not exhaustively
verified — this is a brainstorm, not a bug audit) against the actual
source at two of the higher-stakes claims, both confirmed accurate.

## Full list (Codex, ranked by value-per-effort as reported)

1. **✅ Already mitigated, checked 2026-09-13 — no code change needed.**
   **Psych-sheet parser fails silently.** `backend/psych_parser.py:parse_psych_pdf`'s
   chooser does return `[]` as a "successful" result on an empty/implausible
   parse — the claim is real at that function's own boundary. But it is
   only ever reached as a fallback (`apps/shell/server.ts`'s
   `/api/parse-psych-pdf` route tries the TypeScript `parsePsychPdfFile`
   first, which already throws its own specific errors); and that same
   route checks `results.length === 0` after EITHER path and returns a 422
   with `'No individual psych entries found'` regardless of which parser
   produced the empty array. A coach never sees a silent blank field — traced
   the real call path rather than trusting the function in isolation.
2. **✅ FIXED 2026-09-13** (commit `fe6dc211`, merged in from
   `fix-scoring-roster-integrity`). **Abbreviation-table load swallows
   failure.** `backend/pdf_parser.py:_load_abbrev_teams` caught `OSError` and
   silently fell back to a 2-entry hardcoded map; now raises at import time.
3. **✅ FIXED 2026-09-13.** **First-hit substring team matching is
   ambiguity-blind.** `findMeetTeamBySubstring` and `matchOfficialTeamScore`
   took the first match rather than checking for a second. Both now collect
   every match per fuzzy tier and return "no confident match" (`undefined`,
   or `matchMeetTeamName`'s own original-label fallback) when a tier finds
   more than one candidate — an exact or genuinely unambiguous match is
   unaffected. `test_team_matching_ambiguity.mjs` confirmed red against the
   prior code (an "Ohio" vs. "Ohio State University"/"Ohio University"
   ambiguity silently resolved to whichever was listed first) before being
   kept.
4. **✅ FIXED — already done before this brainstorm's own writing, confirmed
   2026-09-13.** **No CI parity check between the two abbreviation files.**
   `scripts/test_team_abbreviation_parity.mjs` exists, is registered, and
   passes — imports `TEAM_ABBREVIATIONS` directly rather than regex-scraping
   the source file.
5. **Two abbreviation sources instead of one.** Generate/import one canonical
   map for both the Python and TypeScript sides instead of maintaining two by
   hand — the root cause behind #4, itself resolved by a parity *test*, not a
   single source. Still genuinely two files; not attempted.
6. **✅ FIXED 2026-09-13** (commit `fe6dc211`). **Scoring-settings load
   broad-excepts into defaults.** `backend/point_calculator.py:_resolve_scoring_settings`
   could swallow a corrupt/unreadable settings object into silent NCAA-D2
   defaults; now raises.
7. **✅ FIXED 2026-09-13, verified line-by-line this time (not just
   spot-checked).** **Gender defaults to Men on ambiguity.** Confirmed real:
   `buildScorerRosterLookup`'s own meta-building loop correctly fell back to
   the call's `genderFilter` before Men, but `deriveAutoScorerKeys` (called
   earlier in the same function) skipped `genderFilter` entirely and went
   straight to Men — so an ungendered Women's-scoped row's auto-scorer key
   could never match its own roster entry. Fixed by passing `genderFilter`
   through; new `test_scorer_gender_default.mjs` confirmed red against the
   prior code before being kept.
8. **✅ FIXED 2026-09-13** (commit `fe6dc211`). **Absent vs. zero collapsed
   in season trends.** `packages/core/src/lib/seasonAnalytics.ts:buildSeasonTrends`
   used `menTotal || calculated` / `womenTotal || calculated`, reading a
   genuine published zero as absent; now checks `!= null` explicitly.
9. **No pre-export validation.** `packages/core/src/lib/entryExport.ts` can
   export a non-`WOMEN` gender as `M` and blank/invalid fields as usable-looking
   HyTek output with no review step. *Medium.*
10. **No consolidated pre-submit review.** A coach exporting a lineup gets
    scattered warnings across several separate checks (entry limits, lineup
    audit, conversion provenance, unknown program, duplicate identity) instead
    of one actionable checklist before submitting. *Large — the highest-value
    coach-facing feature on this list, per Codex's own ranking.*
11. **Optimizer runs are opaque.** `BatchOptimizerPanel` and the individual
    optimizer panels show a completed aggregate with no accepted/rejected
    breakdown, exact deltas, or undo. *Medium.*
12. **No meet-import reconciliation against official totals.** Nothing compares
    computed team totals to `officialTeamScores` before a coach trusts an
    import — exactly the kind of gap that let the ROCK/LU mapping bug and the
    Delta State discrepancy (this session, and an earlier round) go unnoticed
    until manually caught. *Large.*
13. **Seven specific weak/pushover test scripts**, named directly from
    `docs/reference/TEST_COVERAGE_AUDIT.md`: `test_relay_scoring` (zero
    assertions), `test_individual_scoring` (loose ratio), `test_roster_optimizer`
    (passes on NaN/loss), `test_conference_pdfs` (continues past errors),
    `test_chart_data` (vacuous), `test_relay_overrides` (an invisible mid-file
    skip), `test_athlete_history` (loose half against live data). *Medium.*
14. **Two tests are permanently skipped** (`test_individual_scoring.mjs`,
    `test_relay_scoring.mjs`) for want of a committed `tests/test_nsisc_output.json`
    fixture — a clean checkout never exercises them. *Medium.*
15. **Playwright browser binaries were never installed** in this environment —
    the two e2e failures this whole session has treated as "pre-existing,
    unrelated" are really "never run at all." *Medium.*
16. **Resume the Phase-2 complexity sweep** — `rankExactSwaps`/`rankAddOnly`/
    `rankDropOnly`, then `validateRaceTags`/`buildPrelimsDeltaTimeline`/
    `buildCutlineTag`; reconsider the explicitly-deferred `arbitrage/shared.ts`
    and `scorerRoster.ts` candidates only under the same golden/mutation
    discipline already established. Already tracked in `PHASE_STATE.json`.
    *Medium-large.*
17. **GLVC `format_type='divided'` stays blocked** until the source PDF is
    archived — confirmed correctly deferred, not a new finding. *Small once
    sourced.*

**Codex's own top 5** (its reasoning, not re-derived here): #2
(abbreviation-loader failure signaling), #1 (psych-parse failure signaling),
#3 (ambiguity-aware team matching), #4 (abbreviation-map CI parity), #10
(consolidated pre-submit review) — because together they close the exact
failure shape this whole session kept finding: a silent default standing in
for a real value, with nothing on screen to say so.

## What I'd actually schedule first, and why

Items #2, #4, #6, #8 are small, mechanical, directly continue this
session's own fix pattern (raise instead of silently defaulting), and
touch files already fresh in context. #7 needs a careful read before
scheduling — verify the default-to-Men claim in full before treating it as
confirmed, since gender-sponsorship correctness is one of CLAUDE.md's
explicit hard rules. #10 and #12 are real product value but large; they
deserve their own planning pass, not a quick fix alongside the small items.

## Note on how to execute this

Claude quota is tight (15% of the 5-hour window remained when this was
written). Codex (81%) and Cursor (62%, tooling issues today aside) have
the room. The small/mechanical items above (#2, #4, #6, #8, #17-adjacent
cleanup) are exactly the kind of bounded, well-specified work this
session's CLAUDE.md already routes to the fleet rather than Claude-internal
agents — dispatch them there rather than spending Claude quota on
implementation right now.
