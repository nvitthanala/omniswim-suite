# Course conversion, altitude, and follow-up improvements

Date: 2026-09-22. Branch: `nvitthanala/production-readiness`.
Progress log: `docs/reference/IMPROVEMENTS_2026-09-22_STATE.json`. The log
is the source of truth for what is done. Read it before resuming.

## Why conversion comes first

Most NCAA swimming is in short course yards (SCY). International recruits
have short course meters (SCM) or long course meters (LCM) times. A
converted time is an estimate of SCY performance, not a real SCY swim. The
app must label it that way everywhere.

## Findings that shape the plan

1. **Metric SwimCloud swims never convert today.** SwimCloud imports label
   events `50 Free LCM`. `lookupConversionFactors` only knows `50 Freestyle`,
   so `hasConversionFactor` returns false. `convertedHistorySwims`
   (`packages/core/src/lib/arbitrage/shared.ts:181`) then skips the swim
   without a warning. Verified by probe on 2026-09-22.
2. **The NCAA publishes official SCM→SCY factors, and they differ by
   division.** Both PDFs are already archived in `data/cutlines/sources/`.
3. **The repo's SCM column holds the D1 values.** HSU is D2. Every D2 SCM
   projection is about 1.1% slow.
4. **The NCAA publishes no LCM factor.** "No times achieved in 50-meter
   courses will be eligible for selection." LCM conversion is third-party
   only. The repo's Colorado Time Systems (CTS) table is the de facto
   standard (SwimSwam and TeamUnify use it). A 3.9M-swim study
   (Vercruysse, Menlo School) rejects it statistically but offers no
   general replacement.
5. **The NCAA publishes an official altitude table** (same PDFs). SwimCloud
   marks altitude-adjusted times with an `A` tag and uses the NCAA table
   (SwimCloud support article "Altitude Adjustments").
6. **NSISCDemoProject's table** (`secureframe_client/src/App.tsx:21`) has no
   source, is men only, and falls back to `|| 1`. Not used.
7. **No projected cut times exist anywhere.** The `proj_*` columns were
   removed on 2026-07-26 as invented. The user chose "converted recruit time
   vs the real published SCY cut", labelled as an estimate.

## Chosen factors

### SCM → SCY (official NCAA, primary source)

| Event | Rules Book A-2 (D2 2026-27, default) | D1 2025-26 override |
| --- | --- | --- |
| 400 m → 500 y | 1.143 | 1.153 |
| 800 m → 1000 y | 1.143 | 1.153 |
| 1500 m → 1650 y | 1.003 | 1.013 |
| All other events | 0.896 | 0.906 |

The D2 sheet says its table "reflects ... the NCAA Swimming and Diving
Rules Book, Appendix A-2". The D1 sheet says its table "does not". So the
Rules Book value is the default, and D1 overrides it. D3 publishes no
table; it uses the Rules Book default. NAIA publishes separate meter
standards, so a metric NAIA swim is compared against the meter standard
directly, with no conversion.

### LCM → SCY (Colorado Time Systems, estimate only)

Kept as it is in `packages/core/src/constants.ts` (gender-specific). Every
LCM-derived value renders as an estimate.

### Altitude (official NCAA, applied before conversion)

Seconds subtracted from the actual time, individual events:

| Event | 3,000–4,250 ft | 4,251–6,500 ft | Above 6,500 ft |
| --- | --- | --- | --- |
| 100 yards / meters | 0.00 | 0.10 | 0.15 |
| 200 yards / meters | 0.50 | 1.20 | 1.60 |
| 500 yards / 400 meters | 2.50 | 5.00 | 7.00 |
| 1000 yards / 800 meters | 6.30 | 11.40 | 18.50 |
| 1650 yards / 1500 meters | 11.00 | 20.00 | 32.50 |

Relays use four times the figures. The 50s are not in the table, so a 50
gets no adjustment.

## Phases, in priority order

Each phase ends lint-clean and test-green, and is committed on its own.
A phase may be resumed from the state file alone.

| # | Phase | Owner | Touches |
| --- | --- | --- | --- |
| P0 | Metric SwimCloud labels reach the conversion table | executor | `core/lib/utils.ts` lookup |
| P1 | NCAA SCM factors by division, sourced | executor | `core/constants.ts`, `convertToSCY` callers |
| P2 | Altitude: NCAA table + SwimCloud `A` tag | executor | core, swimcloud parser |
| P3 | Data-loss guard: warn, offer backup | worker | shell save path, UI |
| P4 | User-inputted (`U`) times: badge, never a best | executor | core history, bridge |
| P5 | Season vs lifetime bests toggle | worker | manager athlete view |
| P6 | Provenance badges R / U / X / A | worker | ui |
| P7 | "Bests pulled on" date per swimmer | worker | ui |
| P8 | Re-crawl changes (who improved) | executor then worker | manager |
| P9 | Refresh one team's bests only | worker | extension, crawlPlan |
| P10 | Diving dive count (`B` vs `6`) | research | parser |
| P11 | Per-event swim history on demand | executor | parser, extension |

### P0 — acceptance

- `hasConversionFactor('50 Free LCM')` is true, as are `'1500 Free LCM'`,
  `'200 IM SCM'` and `'100 Back LCM'`.
- `convertSwimToSCY('400 Free LCM', …)` remaps to the 500 Free.
- A diving label still has no factor.
- The real fixture swimmer's LCM swims appear in cross-course arbitrage.

### P1 — acceptance

- A D2 team's 100 Free SCM 54.49 converts with 0.896. A D1 team's
  converts with 0.906.
- Truncate, never round, to hundredths, as the NCAA text requires.
- Each factor records its PDF and page in code; the manifest already
  holds the sha256.
- An unknown division uses the Rules Book default and says so. It never
  silently uses D1.

### P2 — acceptance

- A live SwimCloud swim with an `A` tag is captured as a fixture first.
  Whether `eventtime` is the actual or the adjusted time is read from real
  data, never assumed.
- The altitude table is data in core, sourced to the archived PDFs.
- An altitude-adjusted time renders as adjusted, next to the actual time.

### P3 to P11

Scoped in `docs/reference/IMPROVEMENTS_2026-09-22_STATE.json`. Each
entry states its acceptance test before work starts.

## Rules every phase keeps

- No new competition values without a primary source (CLAUDE.md, data
  provenance).
- An estimate always looks like an estimate.
- No change to scoring results for SCY swims.
- Dark, Light and custom tokens preserved.
- No git operations by subagents.
