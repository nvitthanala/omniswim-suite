# OmniSwim redesign: a Chrome extension on the SwimCloud meet simulator

Status: **plan, not started.** Written 2026-10-25 from the user's handwritten
plan (`00-USER-PLAN.md`), three rounds of user answers (`README.md`, section
"Decisions"), and a read-only survey of the codebase on branch
`nvitthanala/improvement-plan-2026-10-10` (merged to `main` by PR #7).

Progress lives in `docs/reference/REDESIGN_2026-10-25_STATE.json`. That file
is the record. This document is the design.

---

## 1. Why the pivot

The standalone suite grew into an Express server, SQLite or Postgres, Python
PDF parsers, three React applets and a crawler extension that feeds them.
It is heavy to run and it re-creates data SwimCloud already holds.

The new product does not store SwimCloud's data in a backend. It runs inside
SwimCloud. A Chrome extension upgrades the SwimCloud meet simulator
(`https://www.swimcloud.com/meetsimulator/`) with the rules, planning and
optimization the suite already models. A dashboard inside the extension holds
what SwimCloud does not: presets, tags, saved lineups, the meet planner and
charts.

What carries over is the hard part: the scoring engine, the entry-limit and
scorer rules, course conversion, altitude handling, cut tagging, relay
construction, the optimizer guard, the SwimCloud parsers, and 19 recorded
invariants. What gets left behind is the infrastructure.

---

## 2. Product shape: three surfaces, one engine

| Surface | Where it runs | What it does |
| --- | --- | --- |
| **S1. Simulator+** | Content script on `swimcloud.com/meetsimulator/*` | Reads the simulator's teams, swims and settings. Re-scores with the OmniSwim engine. Adds rule controls, cut tags, conversion badges, the AutoBuilder, and a score chart. Looks like SwimCloud. |
| **S2. Dashboard** | Two hosts, one bundle: a full-tab extension page (`chrome-extension://…/dashboard.html`) **and** a docked panel the extension builds into the simulator page | Presets (scoring rules, entry limits, meet sessions), scorer tags, saved lineups and snapshots, meet planner, athlete outlook, charts, reports and exports, settings and theme. |
| **S3. SwimCloud-wide hints** (later) | Content script on swimmer and team pages | Cut-gap badges and "add to lineup" shortcuts on pages the user already visits. Optional. Phase 8 or later. |

The user chose "either" for the dashboard host (decision R2). The plan builds
one React dashboard app that mounts in both hosts. The full-tab page is the
easy host and comes first. The docked panel is the same page loaded as an
extension-page iframe inside a shadow-root container on the simulator page
(D3 spec, decision 0.3). It must not be React mounted straight into the
page: a content script uses SwimCloud's origin, so it would read and write
SwimCloud's IndexedDB instead of the extension's.

**One engine.** All scoring runs in TypeScript in the browser. The Python
scorer and its parity rules stay with the legacy app (section 9). This
removes the "two scorers must agree" gotcha from the new product.

---

## 3. Architecture

### 3.1 Packages

```
apps/extension/            NEW  MV3 extension: content scripts, service worker,
                                dashboard page, docked panel, build
packages/engine/           NEW  pure TypeScript: scoring, rules, conversion,
                                altitude, cuts, relays, entry limits, planner,
                                AutoBuilder. No React, no DOM, no Node, no fetch.
packages/swimcloud/        KEEP parsers and URL classifier. Add a browser-safe
                                entry (`@omniswim/swimcloud/browser`) so a bundle
                                never pulls Node or Playwright (invariant #7).
packages/core/             KEEP for legacy. Re-exports engine modules so the
                                legacy app still compiles.
legacy/                    MOVED apps/shell, manager, matrix, metrics, db, ui,
                                backend, the crawler extension. Frozen, runnable.
```

`packages/engine` is extracted from `packages/core`, not rewritten. `core`
depends on React and TanStack Query today (`packages/core/package.json`), so
the pure modules move out and `core` re-exports them. Section 9 has the move
map.

### 3.2 Extension layout (Manifest V3)

| Part | World / context | Job |
| --- | --- | --- |
| `sim-bridge` | Content script, `MAIN` world, `document_start` | Observes the simulator's own data (network responses or page state) without new requests. Posts normalized snapshots to the isolated script. Exact hook depends on recon (P0). |
| `sim-overlay` | Content script, `ISOLATED` world | Light-DOM controls and badges on the simulator page, engine re-scoring, the shadow-root host for the docked iframe, and any on-click SwimCloud fetches (same-origin, paced). Never touches IndexedDB: storage goes through the service worker. |
| `service-worker` | Background | Storage broker (validates every write), change bus, message routing. Never requests SwimCloud. |
| `dashboard.html` | Extension page, two hosts: a full tab, or an iframe docked in the simulator page | The dashboard. Owns IndexedDB directly. Hosts the AutoBuilder worker. |
| `optimizer.worker` | Dedicated worker started by the dashboard page (tab or docked iframe) | Runs the AutoBuilder (HiGHS WebAssembly) off the main thread. A content script cannot start a worker from a `chrome-extension://` URL; the docked iframe can. Offscreen document is a fallback only. |

Build: esbuild, one build per entry, extending the crawler's pipeline and its
build-freshness test. `dist/` is not committed. Full detail, manifest, tests
and the recon decision rules: `D3-STORAGE-AND-BUILD.md`.

### 3.3 Data flow

```
SwimCloud simulator page
   │  (S1 reads what the page already loaded; no new requests)
   ▼
sim-bridge ──► SimSnapshot (teams, swimmers, swims, settings, SwimCloud's own scores)
   │
   ▼
adapter (packages/swimcloud/browser) ──► MeetModel (engine types)
   │                                        ▲
   │      on-click history fetch ───────────┘ (content script, paced; cached via the SW)
   ▼
engine: rules + planner + scoring + AutoBuilder ──► Results
   │
   ▼
sim-overlay UI  ◄──►  IndexedDB (presets, tags, lineups, cache)  ◄──►  dashboard
```

**Parity check, built in.** The snapshot includes SwimCloud's own team scores.
With OmniSwim rules set to match SwimCloud's settings, the engine must
reproduce those scores exactly. The overlay shows a quiet "matches SwimCloud"
check. A mismatch shows the per-event difference. This is both the acceptance
test for the adapter and an early warning when SwimCloud changes its page.

### 3.4 Storage (IndexedDB, versioned)

| Store | Key | Holds |
| --- | --- | --- |
| `swimmerHistory` | `swimcloudSwimmerId` | Swims fetched on click, `fetchedAt`, source URL. Cache, never edited. |
| `rosters` | `[teamId, seasonId, gender]` | Season roster membership. |
| `meets` | `meetKey` | A simulated meet: teams, gender, chosen rule and session presets. |
| `rulePresets` | `presetId` | Scoring rules, entry limits, scorer caps, diver weight. Each value carries `provenance`. |
| `sessionPresets` | `presetId` | Meet planner: event → day and session. |
| `tags` | `[meetKey, teamId, swimmerId]` | Scorer / non-scorer / exhibition tags. No record means "auto". |
| `lineups` | `lineupId` | Saved lineups and snapshots, with the rules and planner preset they were built under. |
| `settings` | singleton | Theme, cut threshold, fetch posture, flyover value. |

A schema version and migration test ship from day one, because the user will
share the extension later (section 8). Export and import as JSON cover backup
and sharing. The full schema, write rules, migrations and export format are
in `D3-STORAGE-AND-BUILD.md` section 5. Built-in presets (NSISC, generic) live
in code and are never copied into storage.

### 3.5 Look and feel

The user wants it to look like SwimCloud, not like OmniSwim (plan item 5.4).

- Injected controls on the simulator page render in the **light DOM using
  SwimCloud's own CSS classes** where a matching control exists (dropdowns,
  tables, buttons). They then inherit SwimCloud's styling and future
  restyles. Our own additions use a namespaced `osx-` prefix.
- Complex widgets (AutoBuilder, dashboard, charts) render in the docked
  extension-page iframe, which sits in a **Shadow DOM** container with a token
  set sampled from SwimCloud's palette and type scale. If SwimCloud's CSP
  blocks the iframe, the fallback host is Chrome's side panel (beside the page,
  not in it; ask the user first). No OmniSwim CSS reaches the host page. `packages/ui/src/index.css`
  sets `:root` tokens and must never be injected (scout finding).
- Dark mode and a custom accent are tokens on the shadow root and the
  dashboard page. Light is the default, to match SwimCloud.

Recon P0 records SwimCloud's class names, fonts and colors.

---

## 4. Feature specs

Each feature lists what exists, what is new, its acceptance test, its risk
class from `docs/reference/PROVIDER_ROUTING.json`, and who builds it.
"Exists" cites the module on the merged branch.

### F1. Data sourcing

The default path sends no request the simulator page would not send itself.
Anything beyond that needs recon first and an explicit user yes (R7). This
split decides the Terms of Use exposure, so each feature states it:

| Feature | Needs requests beyond what the simulator loads? |
| --- | --- |
| F1.1 wider window, by widening the simulator's own request | No (one changed parameter) |
| F1.1 wider window, per-swimmer history fallback | **Yes**. Not approved. |
| F1.1a season roster filter | Recon: yes if the simulator does not carry roster seasons |
| F1.2 converted swims | Recon: no if the page carries SwimCloud's conversions |
| F1.3 relay splits | Recon: yes if the page carries relay times but not splits |
| F1.4 cut tags | No (archived tables in `data/cutlines`) |

#### F1.1 Wider date window (plan 1.1)

The simulator looks back at most 3 years. The user wants to try further
"for an absolute best case scenario" and rates it low priority (R7).

- **First choice: widen the simulator's own request.** Recon finds the
  parameter that carries the window (the user's example URL is
  `?event=1|50|Y|1&teams=`). If the server accepts a wider value, `sim-bridge`
  rewrites that one parameter. This costs no extra requests.
- **Fallback, pending recon and a user yes: per-swimmer history on click.**
  Use it only if widening fails and the user approves it. Fetch each roster swimmer's full
  history through the one exempt path,
  `/api/swimmers/{id}/profile_fastest_times/` (invariant #12). Pace at 3 s,
  back off on 429, stop the whole run on a Cloudflare 403. Cache in
  `swimmerHistory`. Show the request count and time before starting. The
  crawler's `crawlPacing`, `rateLimitBackoff` and `crawlLock` modules carry
  over unchanged.
- Results built from swims older than the simulator's window carry an
  "extended window" badge.

Risk: `core` (a wrong window silently changes lineups). Build: executor.
Acceptance: a fixture with a 4-year-old best time shows it only when the
window covers it, and the badge appears.

#### F1.1a Season roster vs record range (plan 1.1.1)

Two separate selectors:

- **Roster season**: who is on the team. Source: the team roster page for that
  season (`teamSeasons.ts`, `roster/?season_id=`).
- **Record range**: which swims count. A date range, or "last N seasons".

A swimmer not on the selected season's roster never enters the meet, even if
the record range holds their swims. A swimmer whose roster membership is
unknown shows as **unknown**, not as excluded and not as included (provenance
rule 4, "absent is not empty").

Exists: `teamSeasons.ts`, `rosterPage.ts`. New: the filter and the two
controls. Risk: `core`. Build: executor (filter), worker (controls).

#### F1.2 Converted swims, visible and selectable (plan 1.1.2)

Decision R10: **use SwimCloud's own converted times first.** Table D (LCM to
SCY with turn adjustments) is the fallback only. The user supplied it without
a source, and the code's LCM factors are also unsourced
(`constants.ts:11-29`). So Table D values carry `user-stated` provenance and
an "est." badge.

- Each swim shows its original course and time, the converted SCY time
  SwimCloud displays, and a "converted" badge.
- A toggle per meet: "include converted swims". Off means SCY swims only.
- Where SwimCloud shows no converted time, the engine's own SCM conversion
  applies. That conversion uses NCAA Table A, which matches the official NCAA
  D2 2026-27 standards PDF and `NCAA_SCM_CONVERSION_TABLES` (`constants.ts:145`)
  exactly. An LCM swim with no SwimCloud conversion uses Table D:
  `(LCM time − turn adjustment) × 0.892`, shown with an "est." badge. Table D
  ships as an editable preset, not a constant.
- Converted times never count toward a cut (invariant #10 and #11: the cut
  table must match the course, and NCAA D2 does not accept LCM times).
- Altitude (Table B): `NCAA_ALTITUDE_ADJUSTMENT_TABLE` (`constants.ts:287`)
  matches the user's Table B and the NCAA PDF. A SwimCloud time already marked
  `A` is never adjusted again (invariant #9).

Risk: `core`. Build: executor. Acceptance: three fixtures (SCY, SCM with a
SwimCloud conversion, LCM without one) render as specified, and the toggle
changes the lineup only through the SCM swim.

#### F1.3 Relay splits from a recent window, with flyover (plan 1.1.3)

- **Split window**: separate from the record range. Default: current and
  previous season. The user says older splits are less accurate.
- Pick each swimmer's fastest **relay split** per stroke and distance inside
  the split window. Leg 1 is a flat start. Legs 2 to 4 are flying starts
  (`relayLegCredits.ts:160-197`).
- When a swimmer has no usable split, estimate a flying leg from the flat-start
  individual time minus a **flyover allowance**. The allowance is a number the
  user sets, in seconds to two decimals (R14). It has **no default**: until the
  user sets it, no flying-leg estimate is made and the leg shows "no split".
  An estimated leg shows an "est." badge.
- When a converted swim (F1.2) is faster than the swimmer's SCY swim, the
  estimate uses the converted swim and shows both.

Exists: `relayBuilder.ts`, `relaySplits.ts`, `relayLegMatching.ts`,
`relayLegCredits.ts`, invariants #13, #18, #19. New: split window, flyover
estimate. Recency today exists only in arbitrage
(`arbitrage/shared.ts:75`, `DEFAULT_RECENCY_MONTHS = 24`); reuse that helper.
Risk: `core`. Build: executor.

#### F1.4 Cut tracking and tags (plan 1.1.4)

Decision R11: "close" means **within 1.0%** of the cut, and the time gap always
shows too. Both values are editable settings, not constants.

| Tag | Rule | Shows |
| --- | --- | --- |
| **A** | Swim at or under the A cut of the swimmer's own division | "A" |
| **B** | At or under the B cut, slower than A | "B", plus the gap to A |
| **Close** | Within the threshold of the B cut | Gap to B in seconds and percent |
| none | Further off | Gap on hover |
| **unknown** | Division unknown, program discontinued, gender not sponsored | "?" with the reason |

- Standards come from the archived NCAA D1, D2, D3 and NAIA tables in
  `data/cutlines/sources/` (manifest with URL and SHA-256). SwimCloud's own D2
  display is a cross-check, not the source.
- The swimmer's division comes from `teamDivisions.ts`. Unknown is never D2
  (provenance rule 5). The division is per season (rule 6).
- The table must match the swim's course (invariant #11).

Exists: `cutlines.ts`, `cutlineTags.ts`, `cutlineUtils.ts`, `teamDivisions.ts`.
Core has no "close" threshold (`cutlineTags.ts:278`); presentation decides, as
designed. New: threshold setting, gap display, A-gap for B swimmers.
Risk: `core` (tag logic), `ui` (badges). Build: executor, then worker.

### F2. Scoring rules (plan 2)

Every rule is a setting in a **rule preset**, never a constant. Presets ship
for NSISC and a neutral generic. Any conference can copy and edit one (R4).

| Plan item | Setting | Exists today | New work |
| --- | --- | --- | --- |
| 2.1 Roster scoring headcount | `maxIndividualScorersPerTeam`, `scorerCapScope: 'meet'` | Yes (`scoringDefaults.ts`) | UI control |
| 2.2 Diver weighting | `diverScorerWeight` (NSISC 1/3, confirmed R9) | Yes | UI control |
| 2.3 Scorer / non-scorer tags | `ScorerRosterOverride`, `scorerRoster.ts` | Yes | Tag UI on the simulator; instant re-score |
| 2.4 Per-swimmer limits | `maxIndividualEntriesPerSwimmer`, `maxRelayEntriesPerSwimmer`, `maxTotalEntriesPerSwimmer` | Yes (`swimmerEntryLimits.ts`) | Total-cap dropdown; NSISC preset 7 → **8** (R4) |
| 2.5 Max scorers per event | per-event scorer cap | Yes | Dropdown with "–" (unlimited) instead of the number buttons |

Two engine changes:

1. **"Unlimited" becomes explicit.** Today "unlimited" is the sentinel `999`.
   The engine API uses `number | 'unlimited'`. A missing value is an error,
   not unlimited. The adapter maps SwimCloud's "–" to `'unlimited'`.
2. **Provenance on preset values.** Each preset value records where it came
   from: `published` (with a source in `data/`), `user-stated` (with the date
   and wording), or `user-edited`. The NSISC cap of 8 is `user-stated
   2026-10-25` until a handbook is archived.

**NSISC scoring (R15).** SwimCloud's simulator already holds the NSISC
scoring table: 16 places. NSISC sets **no per-event cap on scorers**. A
swimmer scores only if they are on the scoring team, and a team may enter as
many scoring-team swimmers in one event as the entry limits allow. So the
NSISC preset is:

- per-event scorer cap: `'unlimited'`
- scoring-team size: 18, with each diver counting 1/3 (R9)
- per-swimmer total entries: 8 (R4)
- point table: read from SwimCloud's NSISC table in recon (P0, question 17)
  and compared with the current preset (individual top 16; relays as that
  table doubled). Any difference is a bug in the preset. Fix it in P3 with a
  test that pins SwimCloud's table.

This matches the current code's model: `scorerCapScope: 'meet'` with
`maxIndividualScorersPerTeam: 18` limits the scoring team, not each event.
P3 adds a test that proves 10 scoring-team swimmers in one event all score.

Risk: `core`. Build: executor. Review: a different provider (Codex).
Acceptance: the existing golden snapshots and mutation checks for these
modules still pass after the move; a new test proves `'unlimited'` and a
missing value behave differently.

### F3. Meet planner (plan 3)

New. Nothing in core models days or sessions today (scout finding).

- **Session model**: `{ day: number, slot: 'morning' | 'afternoon' | 'evening' }`.
- **Event format**, per event, per meet: `prelims-finals` or `timed-final`
  (R17). A prelims-finals event has two rounds in two sessions: prelims in
  the morning and finals later the same day by default. A timed-final event
  has one round in one session. Distance events (1000, 1650, often the 500
  and relays) default to timed final where the preset says so; every format
  is editable.
- **Session presets**: saved and reusable. The default is the NSISC order from
  the user's Table C, marked `user-stated`. Every meet's order is editable
  (R16): add, remove or move an event, change its day, slot or format.
- **Edit where you are** (R16): the order editor exists in two places, the
  dashboard and a "Meet schedule" panel on the simulator page. Both write the
  same session preset.
- **Athlete outlook**: per swimmer, a day-by-day view of their swims, for
  sharing with athletes.
- **Load preference** (R6, R17): the meet itself imposes no session limit. The
  load limit protects performance; it is the coach's preference. Default: at
  most **2 races per session, relays included**. Each round counts in its own
  session, so a prelim and its final are one race each in two sessions. Three
  modes, set per meet:
  - **Respect** (default): the AutoBuilder never exceeds it; manual entries
    over it show a warning.
  - **Prefer**: the AutoBuilder may exceed it when the points gain beats a
    user-set penalty per extra race.
  - **Off**: no limit.

Risk: `design` for the model (architect), `core` for the rule (executor),
`ui` for the two editors (Codex or worker).
Acceptance:
- With the NSISC preset, a swimmer entered in the 200 IM, the 50 free and the
  200 medley relay finals on day 2 breaks the default preference; dropping one
  clears it.
- Changing the 1000 free to prelims-finals moves its finals into the day 2
  later session and the outlook updates.
- An order edited on the simulator page shows in the dashboard after reload.

### F4. AutoBuilder (plan 4)

The flagship. It replaces the staged optimizer's search with an exact or
near-exact solver, and keeps the optimizer's guard: it never returns a lineup
that scores worse than the current one, and it says so when it finds nothing
better (`rosterOptimizer.ts:1-21`).

**Objective modes (R5: all four).**

| Mode | Maximizes |
| --- | --- |
| Max own total | Own projected points |
| Margin over a rival | Own points minus a chosen rival's (or the closest team's) |
| Robust | Own points under slower-than-best times (from each swimmer's recent spread) |
| Goal seek | Fewest changes from the current lineup that reach a target total or margin |

**Constraints.** Per-swimmer individual, relay and total caps (F2.4); max
scorers per event (F2.5); roster scoring headcount with diver weights (F2.1,
F2.2); scorer tags (F2.3); session load in "respect" mode, or a per-race
penalty in "prefer" mode (F3); relay legality (invariant #19);
course and conversion choices (F1.2); unknown divisions excluded from cut
logic.

**Why it is tractable.** Opponent entries are fixed for one solve. Within one
event, the points a team earns depend only on which of its own swimmers enter
that event. So each event has a value for each subset of candidates. Events
couple only through per-swimmer limits, session load and the scorer
headcount. That is a set-packing problem:

- Generate columns: for each event, the subsets of its top candidates (about
  6 to 8), with their point value under the chosen objective. Relays get
  candidate squads the same way.
- Solve a mixed-integer program over the columns. Candidate solver: HiGHS
  compiled to WebAssembly, run in the optimizer worker.
- Fallback: the existing local search, seeded from the MIP's best solution.

The architect owns this formulation (design item D4). It must prove the
column bound does not drop a better lineup, or report the gap. "Too deep"
teams (plan 4.5) fall out of the headcount constraint: the solver picks which
fast swimmers score.

**Unusual events (plan 4.2).** The solver considers every event a swimmer has
a time in, not only their usual events. The result explains each non-obvious
entry: "thin field: 3rd with 24.10, no other team has a swimmer under 24.5".

**Prelims and finals.** Championship meets score finals places. Projection
follows the existing A/B final bracket logic (`aFinalBracketSize`).

**Opponents.** By default opponents enter their best lineup under the same
rules. F5.3 (prediction) later replaces that with a predicted lineup.

Risk: `design` (formulation), `core` (build), `adversarial` (review).
Sequence: after the planner model (F3), because session load is a constraint.
Acceptance:
- On a small fixture, the solver matches brute-force enumeration exactly.
- On the HSU 2026-27 roster workspace it never scores below the current lineup
  (the guard regression from `scripts/test_optimizer_never_loses.mjs`).
- Each mode has a test where it picks a different lineup from "max own total".
- A 10-team, 20-event meet solves in under 10 s on the user's machine.

### F5. Additional items (plan 5)

- **F5.1 Dark mode and theming.** Tokens on the shadow root and the dashboard
  page. Light default (SwimCloud). Dark and a custom accent. Risk `ui`.
- **F5.2 Score chart through the events.** Team totals after each event, in
  session order from the planner, for every team, with the rival highlighted.
  Recharts is the precedent (`MomentumChartCard.tsx`). Risk `ui`.
- **F5.3 Opponent lineup prediction.** For each opposing swimmer and event, a
  likelihood of entry. Inputs: their entries at last season's conference meet,
  how often they swam the event this season, and their rank on the team in it.
  First version: a transparent scoring rule, not a trained model. Each
  prediction shows why. Risk `design` then `core`. Last phase.
- **F5.4 SwimCloud look.** Section 3.5. Applies to every phase.

### F6. Carried over from the standalone suite (R12)

- **Saved lineups and snapshots**: scenario snapshots, what-if diffs, undo.
  Ported to IndexedDB. Exists: `scenarioDiff.ts`, the snapshot API.
- **Reports and entry export**: printable lineup report per swimmer and per
  team, entry CSV. Exists: `reportBuilder.ts`, `entryExport.ts`.

Not carried over: PDF and HyTek import, video race analysis, multi-user auth,
Postgres. They stay runnable in `legacy/`.

---

## 5. Phases

Order follows the delegation model: design first, core green before UI, UI
against a reported API. Each phase ends with the full gates and a state-file
patch.

| Phase | Goal | Main items | Owners | Exit |
| --- | --- | --- | --- | --- |
| **P0. Recon** | Know the simulator | `02-SIMULATOR-RECON.md` checklist via Claude in Chrome | Lead | Every recon question answered or marked blocked; sanitized fixtures saved |
| **P1. Foundation** | New layout, empty extension that loads | Merge PR #7 (done), reorg (`03-REPO-REORG.md`), extract `packages/engine`, extension skeleton, IndexedDB schema v1 | Architect (D1, D2, D3), executor (engine), worker or Codex (skeleton), finisher | All gates green; legacy tests green at the reorg commit; extension loads unpacked and logs a SimSnapshot |
| **P2. Read-only overlay** | Re-score the simulator | Adapter, parity check, results table | Executor (adapter), Codex (UI) | Parity on 3 recorded simulator configurations |
| **P3. Rules** | F2 | Rule presets, dropdowns, tags, NSISC preset with provenance | Executor, Codex (UI); review by a different provider | Golden snapshots unchanged; new rule tests |
| **P4. Data sourcing** | F1 | Roster season, record range, converted swims, relay window and flyover, cut tags, wider window | Executor, worker | F1 acceptance tests |
| **P5. Planner** | F3 | Session model and presets, outlook, load rule | Architect (model), executor, Codex (UI) | F3 acceptance test |
| **P6. AutoBuilder** | F4 | Formulation, solver worker, modes, explanations | Architect (D4), executor, bug-hunter | F4 acceptance tests |
| **P7. Dashboard** | S2, F5.1, F5.2, F6 | Full-tab page, docked panel, theming, charts, snapshots, reports | Codex or worker, finisher | Visual check in both themes; exports open in Excel |
| **P8. Prediction** | F5.3, S3 | Opponent prediction, SwimCloud-wide hints | Architect, executor, worker | Prediction explains every entry |
| **P9. Share-ready** | Audience 2 (section 8) | Onboarding, presets for other conferences, import/export, privacy note | Worker, finisher | Checklist in section 8 done |

P3, P4 and P5 can overlap once P2 is green, in disjoint scopes: rules in
`packages/engine/rules`, sourcing in `packages/engine/sourcing` and
`packages/swimcloud`, planner in `packages/engine/planner`.

### Design items for the architect (before their phase)

- **D1** Build tooling and extension layout (Vite or esbuild; worlds; offscreen).
- **D2** `packages/engine` public API: `MeetModel`, `RulePreset`,
  `SessionPreset`, `Lineup`, `Results`, `'unlimited'`, provenance type.
- **D3** IndexedDB schema v1 and the migration pattern.
- **D4** AutoBuilder formulation, column bound, solver choice, modes.
- **D5** Prediction model inputs and output (P8).

### Spikes (small, throwaway, answer one question)

- **S1** Can a MAIN-world script read the simulator's data without new
  requests? (P0)
- **S2** Does the simulator's request accept a window wider than 3 years? (P0)
- **S3** Worker strategy for a content script: offscreen document versus blob
  worker. (P1)
- **S4** HiGHS WebAssembly bundle size and solve time inside an MV3 extension. (P1)

---

## 6. Providers and delegation

Routing follows `docs/reference/PROVIDER_ROUTING.json`. Update its `codex`
entry before the first dispatch: the user said on 2026-10-25 that Codex has a
full fresh quota.

- **Claude architect (Opus)**: D1 to D5, review of core diffs.
- **Claude executor (Sonnet)**: engine extraction, rules, sourcing, planner,
  AutoBuilder build.
- **Codex**: UI phases (overlay, planner screen, dashboard) and the
  different-provider review of executor diffs.
- **Claude worker**: UI when Codex is busy; docs.
- **Claude finisher (Haiku)**: gates, mechanical fixes.
- **Claude bug-hunter (Opus)**: adversarial pass on the adapter (P2) and the
  AutoBuilder (P6).
- **OpenCode (free Zen models, R18)**: mechanical work, docs, read-only
  scouting and a second-family review (`.opencode/agents/`: scout, finisher,
  docs-worker, reviewer). Always `--worktree new-child`, never `current`: its
  read denies do not stop grep or shell, so separation is the data barrier.
  Never core scoring logic, never a design decision. Its diffs are reviewed by
  Claude.

Dispatch Codex and OpenCode through Orca only
(`orca orchestration worker-start --agent codex|opencode2`), never by
spawning `codex` or `opencode` directly.

Rules that hold for every provider: no git operations by a subagent; a diff is
reviewed by a different provider than its author; briefs stand alone and point
at the state file; targeted tests while iterating, full gates at the end.

---

## 7. Invariants that carry into the extension

From `docs/INVARIANTS.md` (numbers as there). Each becomes a test in
`packages/engine` or `packages/swimcloud` if it does not have one already.

- #3 HyTek labels are not canonical names.
- #6 The alias resolver is opt-in; a missing resolver double-counts.
- #7 A bare `@omniswim/swimcloud` import pulls Node and Playwright code. The
  extension imports only the browser entry. A bundle test enforces it.
- #8 `isRankableSwim` is the only best-time gate.
- #9 A SwimCloud `A` time is never adjusted again.
- #10 SCM to SCY truncates and uses the team's division table.
- #11 A cut table must match the swim's course.
- #12 The robots.txt exemption is one exact path shape.
- #13 Relay legs match by exact canonical event.
- #16 An event the course does not swim is never converted or ranked.
- #17 `rankEventsByStrength` is the single ranking.
- #18 A relay distance is read from its token.
- #19 Who may fill a relay leg.
- Missing time prints `NT`, never `0.00`.
- The optimizer guard: never worse than current; say "nothing better".

---

## 8. Sharing with other coaches later (audience 2)

The user starts with a personal unpacked install and will share it later
(R8). Build for it now where it is cheap; finish it in P9.

- **Settings, not constants.** Every rule, threshold and session order is a
  preset (already required by F2).
- **Conference presets.** NSISC ships. Others start from the generic preset.
  Only sourced values ship as `published`.
- **Storage migrations.** Schema version and a migration test from P1.
- **Import and export.** Presets, tags and lineups as JSON. No SwimCloud data in
  exports by default.
- **Onboarding.** First-run page: what the extension does, what it fetches,
  the fetch posture setting.
- **Terms of Use.** SwimCloud's Terms prohibit automated access and modifying
  the site's material (research quotes, unverified against the live page).
  Personal use carries the risk the user already accepted for the crawler.
  Sharing widens it. Before any public listing, decide whether to ask
  SwimCloud for permission. Never publish to the Chrome Web Store without that
  decision.
- **Privacy.** No telemetry. No data leaves the browser except the SwimCloud
  requests the user starts. A one-page privacy note.
- **Packaging.** Signed `.zip` or an unlisted listing; a version number and a
  changelog in the dashboard.
- **Rate limits per install.** Pacing is per browser; a shared build must not
  let one user lower it.

---

## 9. What becomes legacy

See `03-REPO-REORG.md` for the full move map. Summary:

- **Stays active:** `packages/core` (as the engine's legacy re-export shell),
  `packages/engine` (new), `packages/swimcloud`, `apps/extension` (new),
  `data/cutlines`, `data/relay-programs`, `docs/INVARIANTS.md`, the test suite
  for those packages.
- **Moves to `legacy/`, frozen but runnable:** `apps/shell`,
  `packages/{manager,matrix,metrics,db,ui}`, `backend/`,
  `extensions/swimcloud-companion/`, the start scripts, `SUITE_ROADMAP.md`.
- **Gates:** default `npm test` and `npm run lint` cover the active packages.
  `npm run test:legacy` runs the old suite on demand. CI runs both until P2 is
  green, then legacy weekly.

---

## 10. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| SwimCloud changes the simulator page | Overlay breaks silently | Parity check on every load; adapter fixtures from recon; a visible "adapter out of date" banner |
| Terms of Use enforcement | Account action against the user | No new requests in the default path; on-click fetches only; pacing; stop on 403; no public listing without a decision |
| Cloudflare challenge on fetches | Fetch fails | Stop the run; never retry a 403 |
| Simulator needs a paid plan | Feature unreachable for some users | Recon records the plan level; the dashboard works on cached data |
| Solver too slow in the browser | AutoBuilder unusable | Column bound, worker, local-search fallback, a time limit that returns the best found so far |
| Wrong preset value | Plausible wrong lineup | Provenance on every value; published sources archived; the NSISC relay-points check (Q2) |
| Reorg breaks legacy | Lost work | One mechanical commit, legacy gates green at that commit, after PR #7 merged |

---

## 11. Open questions

Answered on 2026-10-25: Q1 (flyover is a user-set number, R14), Q2 (use
SwimCloud's NSISC table; no per-event scorer cap, R15), Q5 (each round counts
in its own session, R17).

Still open:
- **Q3** New South ISC source documents for the 8-event cap, the 1/3 diver
  weight and the Table C session order, so presets can move from
  `user-stated` to `published`. Not blocking: presets ship as `user-stated`.
- **Q4** Does the simulator need a paid SwimCloud plan? Recon answers it.
- **Q6** Per-swimmer history fetches, per-season roster fetches, or split
  fetches (F1 table): approve or not, once recon shows what the simulator
  already carries. Recon writes the request counts into
  `02-SIMULATOR-RECON.md` so the user can decide.

---

## 12. Starting the next session (Claude in Chrome)

P0 needs the Claude in Chrome tools (`mcp__claude-in-chrome__*`). They load
when a session starts, not mid-session. The 2026-10-25 session ran `/chrome`
mid-session and the tools never appeared.

**Normal start.**

1. Open Chrome. Check that the Claude in Chrome extension shows "connected",
   and that the user's tab group ("claude") exists.
2. Start Claude Code with `claude --chrome` from the repo folder.
3. First prompt: "Resume the redesign. Read
   `docs/reference/REDESIGN_2026-10-25_STATE.json` and run P0 from
   `plans/2026-10-25/02-SIMULATOR-RECON.md`."
4. The session loads the `chrome-browser` skill. It then calls `ToolSearch`
   once with
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_close_mcp`,
   and calls `tabs_context_mcp` first.

**Fallback, in order. Stop at the first step that works.**

1. **Tools missing after a `--chrome` start.** Run `/chrome`, pick "Enabled
   by default", and restart Claude Code. Search the deferred tools once with
   `ToolSearch` query `chrome`. If a single `enable__mcp__claude-in-chrome`
   tool is listed, call it.
2. **Extension not connected.** In Chrome, open the Claude in Chrome
   extension, sign in with the same Claude account as Claude Code, and reload
   it from `chrome://extensions`. Repeat the normal start.
3. **Site permission prompt.** The extension asks per site. The user allows
   `swimcloud.com`. Claude waits; it never works around a refused permission.
4. **Still no tools.** Use the Orca embedded browser through the `orca-cli`
   skill (its browser commands drive a page inside Orca). The user signs in
   to SwimCloud there once. Same posture rules as Claude in Chrome.
5. **No browser automation at all.** The user captures by hand, guided by a
   checklist the session writes into `02-SIMULATOR-RECON.md`: for each of the
   three configurations, DevTools > Network > "Save all as HAR with
   content", plus "Save page as > Webpage, HTML only". Save the files under
   `data/swimcloud-captures/simulator/` (untracked). The session parses them.

Whichever route works, record it in the state file's P0 entry.
