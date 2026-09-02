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

1. **Psych-sheet parser fails silently.** `backend/psych_parser.py:parse_psych_pdf`'s
   chooser returns `[]` as a successful result on an empty/implausible parse — a
   coach sees a blank seed field, not an error. *Small.*
2. **Abbreviation-table load swallows failure.** `backend/pdf_parser.py:_load_abbrev_teams`
   catches `OSError` and silently falls back to a 2-entry hardcoded map.
   **Spot-checked and confirmed** — `except OSError: pass` at line 51, exactly as
   described. A moved/renamed/corrupted `teamAbbreviations.json` degrades team
   attribution silently instead of raising. *Small.*
3. **First-hit substring team matching is ambiguity-blind.**
   `packages/core/src/data/teamAliases.ts:findMeetTeamBySubstring` and
   `packages/core/src/lib/teamScoreMatching.ts:matchOfficialTeamScore` take the
   first match rather than checking for a second, so a shortened label can
   attach to the wrong similarly-named team. *Medium.*
4. **No CI parity check between the two abbreviation files.** Exactly the gap
   this session's own audit flagged (see `docs/reference/AUDIT_2026-09-02.md`) —
   `teamAbbreviations.json` and `teamAliases.ts`'s `TEAM_ABBREVIATIONS` are
   hand-duplicated with nothing enforcing they match. *Small.*
5. **Two abbreviation sources instead of one.** Generate/import one canonical
   map for both the Python and TypeScript sides instead of maintaining two by
   hand — the root cause behind #4. *Medium.*
6. **Scoring-settings load broad-excepts into defaults.**
   `backend/point_calculator.py:_resolve_scoring_settings` can swallow a
   corrupt/unreadable settings object into silent NCAA-D2 defaults instead of
   raising — malformed configuration scores under the wrong rules with no signal.
   *Small.*
7. **Gender defaults to Men on ambiguity.**
   `packages/core/src/lib/scorerRoster.ts` (`deriveAutoScorerKeys`,
   `buildScorerRosterLookup`) defaults an unclassified row to Men rather than
   `unknown`, so a misclassified women's row can consume a men's scorer slot.
   **Spot-checked function names — both real, at the claimed lines** (100,
   140); did not verify the default-to-Men behavior itself line-by-line. If
   real, this is the same class of bug as CLAUDE.md's gender-sponsorship rule
   (rule 7) — worth a careful look before scheduling. *Medium.*
8. **Absent vs. zero collapsed in season trends.**
   `packages/core/src/lib/seasonAnalytics.ts:buildSeasonTrends` uses
   `menTotal || calculated` / `womenTotal || calculated`, which reads a
   genuine published zero as "absent, use the calculated value instead" — the
   exact absent-vs-empty confusion CLAUDE.md's provenance rule 4 warns about.
   *Small.*
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
