# Next round: live-readiness, correctness follow-ups, coach features

Date: 2026-09-24. Branch: `nvitthanala/production-readiness`.
Follows `plans/2026-09-22/01-CONVERSION-AND-IMPROVEMENTS-PLAN.md`.
Progress log (canonical): `docs/reference/NEXT_ROUND_2026-09-24_STATE.json`.
Read the log before resuming. On any usage limit, follow its `limitProtocol`.

Every anchor below (file, function, field) was checked against the code on
2026-09-24 at `dfe3f455`. If an anchor has moved, re-find it; do not guess.

---

## 1. Execution rules (apply to every item)

### Gates — an item is done only when all pass, in this order
1. `npm run lint` exits 0 (type checks every package, the extension, eslint).
2. `npx vitest run` fully green.
3. `node scripts/run-tests.mjs` — 84 passed, 0 failed, 1 skipped (the skip
   is `test_pg_roundtrip`, which needs a live database). This runner also
   runs the Playwright e2e specs. Run it through the runner; plain `node` on
   a `scripts/test_*.mjs` file fails on JSON import attributes.
4. `npm run build` succeeds (`apps/shell/dist/server.js` is untracked; the
   running app serves from it, so a green test suite is not enough).
5. If `packages/swimcloud/**` or `extensions/**` changed: `npm run
   build:extension`, then re-run vitest (`tests/swimCloudExtensionBuildFreshness`
   fails when `crawler.js`/`background.js` are stale).
6. If `data/cutlines/**` or `scripts/*cutlines*.py` changed:
   `py scripts/extract-cutlines.py --print-only` exits 0.
7. **Docs and vault updated** for that item, per section 4's table. An item
   is not done, and is not committed, until its doc rows are done. The docs
   go in the same commit as the code they describe.

### Commits
- One commit per item, made by the orchestrator only (subagents never run
  git). Commit only the item's own paths; other agents may have files in the
  tree. Subject ≤ 50 chars, imperative; body wrapped at 72 (CLAUDE.md).
- Update the progress log after every commit. Repo docs ride in the item's
  commit (gate 7). The vault is outside the repo: update it right after the
  commit, per section 4.
- Push `nvitthanala/production-readiness` and fast-forward `main` after each
  wave (user approved pushing on 2026-09-24).

### Parallel work — disjoint scopes only
| Scope | Owner at a time |
| --- | --- |
| `packages/core/**` | one executor, serial |
| `packages/manager/**`, `packages/ui/**`, `packages/matrix/**` | one worker |
| `apps/shell/**`, `scripts/**` | one worker |
| `extensions/**`, `packages/swimcloud/**` | one worker |
| `tests/**` | shared; each agent adds its own files and edits only tests its item owns |

A UI item that needs a new core field waits for the core item to land. The
orchestrator adds tiny, purely additive core fields itself when that
unblocks a parallel UI item (done before for `seasonId`/`retrievedAt`).

### Known build hazards (seen this round)
- A concurrent agent's half-written file can fail lint or a test for a
  moment. Re-run before blaming the item under review.
- `utils.ts` has CRLF line endings; Git Bash `grep` hides the `\r`.
- Shell quoting: apostrophes inside `node -e '…'` break the command. Use a
  script file for anything with prose.
- `scripts/test_*.mjs` pin behaviour too. When an item changes behaviour,
  grep `scripts/` as well as `tests/`.
- Cut data under `data/cutlines/*.json` is generated. Never hand-edit it;
  decisions live in code (see `NAIA_2026_27_METERS_AS_SCM`).
- The Orca browser clears Cloudflare; cookieless curl does not. Never retry a
  challenged request in a loop.

---

## 2. Waves

| Wave | Items | Runs in parallel? |
| --- | --- | --- |
| 0 | P15 relay-leg fix (running) → verify → commit → push | — |
| 1 | A1-core (executor) ‖ A2 + A4 (shell worker) ‖ D0 docs catch-up (docs worker, docs/ + CHANGELOG + plans/STATE.md only) | yes, disjoint |
| 2 | A1-UI (UI worker, after A1-core) ‖ B1 → B3 → B4 → R1 (executor, serial) | yes |
| 3 | A3 live crawl + reimport (orchestrator, needs A1 done) ‖ C1 (UI worker) ‖ C4-print (UI worker after C1) ‖ C3-core (executor, after wave 2 core) | partly |
| 4 | C3-UI (UI worker) ‖ B5 (shell/core worker) ‖ C5 docs (worker) | yes |
| 5 | C6 e2e specs (finisher) → D-final docs and vault sweep (orchestrator) | — |
| Held | B2 (must reproduce first), B6 (data), C4-hy3 (no sample file) | — |

---

## 3. Items

### A1 — Replace mode for a full reimport (Opus core, then Sonnet UI)
**Why:** the user will fix pre-fix rows with a full lineup reimport. Today
the import merges: `RosterImportWizard.handleMerge` →
`importHistoryToRoster` (`packages/core/src/lib/historyImportRoster.ts:988`)
→ `mergeHistoryIndex` (`athleteHistory.ts:125`). Nothing deletes recruit
rows (`Workspace.recruits`) or plan entries (`Workspace.meetEntryPlans`). So
a reimport keeps Fabio Capocci's recruit row and plan built from a
self-reported 48.15, the stored bare-`A` rows badged `d1_a`, and `D2 B`
meet labels.

**User decision:** a replace reimport may delete that team's SwimCloud-sourced
history, recruit rows and plan entries, after a preview and a backup.
Manual and PDF data stay.

**Core (executor, `packages/core` only):**
- New pure function, e.g. `planSwimCloudReplace(workspace, { team, gender })`
  → `{ historyToRemove, recruitsToRemove, plansToRemove, kept }`.
- History: remove rows with `source: 'swimcloud'` for that team and gender.
- Plans: `PlannedSwimEntry.source` exists (`'manual' | 'swimcloud' | 'pdf' |
  'optimizer'`). Remove `source: 'swimcloud'`. Decide and document how to
  treat `'optimizer'` plans built from those swims (they are derived; if
  their time traces to a removed history row, remove them; never remove
  `'manual'` or `'pdf'`).
- Recruits: `Recruit` has **no source field**. Derive: a recruit row is
  SwimCloud-built when its name+team+event+time matches a history row being
  removed (use `swimEventIdentity` and the alias resolver). Add an optional
  `Recruit.source` going forward so the next replace needs no derivation.
- `importHistoryToRoster` gains an additive `mode: 'merge' | 'replace'`
  (default `'merge'`, behaviour unchanged).
- Tests: real fixtures; Capocci-style case (recruit + plan from a U swim are
  removed, a manual plan in the same event survives); PDF history survives;
  other teams untouched; merge mode byte-identical to today.

**UI (worker, manager/ui):** a "Replace this team's SwimCloud data" choice in
the import preview, a count and list of what will be removed, a confirm
step, and a pre-shrink backup before the save (reuse the P3 data-loss guard:
the PUT will already trigger it when counts drop sharply; also call
`POST /api/workspaces/backup` explicitly before a replace so small teams are
covered).

### A2 — Backup coverage test (Sonnet, `apps/shell`)
Checked: `JsonRepo`, `SqliteRepo` and `PgRepo` all implement `backup()` with
the same JSON writer, a startup backup runs in `server.ts:594`, and the
data-loss guard sits in the shared PUT handler. So no new feature. Add one
test that runs `applyWorkspaceUpdateWithGuard` against `SqliteRepo` (temp
file) to prove the pre-shrink backup is written there too.

### A3 — Live end-to-end check (orchestrator)
After A1: in the Orca browser, run the extension on one meet with scope
"Rosters and personal bests", one team checked, "Refresh personal bests
already captured" on. Then import with replace mode. Check: panel copy and
pacing; captured `profile_fastest_times` pages; the improvements preview
(P8); badges; season toggle; no Cloudflare loop. Record findings in the log.

### A4 — Stale cut-table report (Sonnet, `apps/shell` + `scripts`)
Every table in `data/cutlines/sources/manifest.json` has a `season`. At
server start, log which divisions' tables are older than the current season
(the D1 table is 2025-26). Report only — never auto-fetch.

### B1 — NAIA SCM follow-ups (Opus core)
`enrichWithComputedCut` (`athleteHistory.ts:804`) and `buildStoredSwim`
(`rosterCatalog.ts:100`) give no cut for any metric swim, NAIA SCM included.
Use `cutlineTableCourseForSwim`. The import panel's cut tooltip uses the SCY
lookup (manager: note for the UI worker). Fix the two stale comments in
`AthleteEntriesSection.tsx` and `teamCardView.ts` (UI worker).

### B2 — Prelims vs finals best (held: reproduce first)
Reported by an agent, but each `SwimmerResult` row (prelims and finals
separately) becomes its own history swim via `historicalSwimFromResult`
(`athleteHistory.ts:71`), and the merge keeps the faster. Write a failing
test with real meet data first. If it does not fail, close the item.

### B3 — Strongest-event ranking (Opus core)
**User decision:** rank by place against the loaded meet when one is
loaded; otherwise by percentage distance to the team's division cut; raw
seconds only as a final tiebreak. Target: `buildCategorizedScoringInputs`
(`utils.ts:2915`) and whatever feeds entry suggestions from it. This
changes optimizer suggestions — report before/after on HSU data.

### B4 — Events that do not exist in a course (Opus core)
**User decision:** there is no 1000 in SCM; a 1000 Freestyle recorded SCM
is invalid — flag it, never convert. Build a sourced list of events per
course (NCAA/NAIA/USA Swimming event lists; archive the source) and refuse
conversion for any event outside it, with a visible warning. No list, no
refusal: do not hand-type an event list without a source.

### R1 — Relay follow-ups from P15 (Opus core, wave 2 after B4)
Found while fixing P15 (commit "Match relay legs by exact event"), not yet
fixed: (a) relay candidates are not gender-checked — "Mixed" time-trial rows
sit in men's results; (b) `parseRelayDistanceYards` reads "Event 102 … 200
Yard Medley Relay" as 102 yards and silently falls back to 200 with no
number (a silent default — fail loudly instead); (c)
`relayLegSwaps.individualStrokeDistance` reads a HyTek event number as a
distance (display only); (d) `isGraduatingClassYear` ignores "GS"; (e)
relay candidates come only from meet and recruit rows, not history; (f) the
departed-swimmer lookup has no team filter. Ask the user: (g) should time
trials still fill a relay leg? Docs: CHANGELOG (Fixed), INVARIANTS for (b).

### B5 — NAIA teams in the registry (Sonnet, `packages/core/src/data`)
**User, 2026-09-24:** HSU does not compete against NAIA teams, but other
users of the app may. Add NAIA programs to `teamDivisions.ts` from a sourced
membership list (archive the list with url + sha256 + retrievedAt, same as
cut sources). Every entry needs `status`, `sources` and `sponsoredGenders`
per CLAUDE.md rules 6-7; a program the source does not confirm stays out.
Runs in the core scope, so it waits its turn behind the executor.

### B6 — Diving 6-dive vs 11-dive (held: data)
SwimCloud course codes `6` and `B` look like dive-list lengths but are
unconfirmed. Needs one more real example with both.

### C1 — Recruit board for metric recruits (Sonnet UI)
One view listing each recruit with metric bests: the SCY projection with its
basis badge (`ProvenanceBadges`), the cut verdict (`converted_estimate` or,
for NAIA SCM, exact), and where the projection ranks against the current
roster in that event. Display only.

### C2 — Dropped (user, 2026-09-24)
"Any PB is a PB, regardless of how long ago it was." No staleness warning.
The "Bests pulled" date (P7) stays as information only.

### C3 — Per-event progression on demand (Opus core, then Sonnet UI)
**User, 2026-09-24: approved a second robots.txt exemption** for
`/api/swimmers/{id}/times_by_event/?event={stroke}|{distance}|{course}|{n}`.
- Core/swimcloud (executor): add the exact path shape to
  `SWIMCLOUD_ROBOTS_USER_EXEMPTIONS` (`packages/swimcloud/src/urlClassifier.ts`),
  a new resource kind, and a parser against the saved real fixture
  `tests/fixtures/times_by_event-1330318.json` (30 rows, 50 Free SCY). The
  `event` parameter's four fields are NOT confirmed (seen once: `1|50|Y|1`);
  confirm each against a second real request before relying on it. Keep every
  other `/api/` path forbidden (extend the existing forbidden-path tests).
- Fetching: on demand only, one swimmer and one event per click, never part
  of a crawl. Route it through the extension's same-origin fetch (cookieless
  requests get Cloudflare 403s), with the 3 s pacing.
- UI (worker): a progression chart per event using the `dataviz` skill;
  extracted/self-reported/altitude points badged, not plotted as bests.

### C4 — Entry export: print view and real `.hy3` (user chose print/PDF + `.hy3`)
Exists today: `packages/core/src/lib/entryExport.ts` — CSV and a plain-text
"HY-ENTRIES" approximation that states it is **not** a real `.hy3`;
`ExportReviewModal.tsx` validates before download.
- **C4-print (Sonnet UI):** a print stylesheet/view of the planned entries
  with estimate and provenance badges, via the browser's print-to-PDF.
- **C4-hy3 (HELD, user 2026-09-24: no sample file available):** a real Hy-Tek `.hy3` entry file. The format is
  proprietary: fixed-width records with a per-line checksum. **Blocked on
  inputs:** (1) a real `.hy3` entry file exported by the user's Hy-Tek Team
  Manager / Meet Manager for a past meet, used as a golden file; (2) the
  Meet Manager version it must import into. Build a writer that reproduces
  the golden file byte-for-byte from equivalent workspace data, then the
  user imports a generated file into Meet Manager to confirm. No format
  detail may be guessed; a field we cannot source is left out and reported.

### C5 — User guide (Sonnet docs)
Folded into D0 (features already shipped) and each later item's docs row
(section 4). D-final checks it against the shipped UI.

### C6 — E2E specs (Haiku finisher, last)
Playwright specs in `tests/e2e/` for the season toggle, badges, improvements
preview and replace reimport, following `production-server.spec.ts`.

---

## 4. Docs and vault — required for every item

### Where things are recorded
| Doc | What goes there | Rule |
| --- | --- | --- |
| `CHANGELOG.md` (`[Unreleased]`) | Every user-visible behaviour change | "User-visible behaviour changes only", Keep a Changelog headings (Added / Changed / Fixed) |
| `docs/USER_GUIDE.md` | How a coach uses each new feature | Written against the shipped UI, STE / Google style (CLAUDE.md) |
| `docs/INVARIANTS.md` | Any new rule the code must keep | One rule, why, where it is enforced, which test guards it |
| `docs/reference/CUTLINE_TAGS_PLAN.md` | Cut-tag states, table-course rules, conversion and altitude sources | Cite the archived PDF and manifest id |
| `plans/STATE.md` | Repo-level status the next session reads first | Short; points at the progress log |
| `docs/reference/NEXT_ROUND_2026-09-24_STATE.json` | Item status, commit, results, blockers | After every commit |
| Vault `Sessions/` note | What changed and why, per commit | One note per session; cite commits |
| Vault `02-Invariants-and-Gotchas.md` | New gotchas (hazards list in section 1, new invariants) | Mirror, do not fork, `docs/INVARIANTS.md` |
| Vault `04-Known-Issues-and-Current-State.md` | Open issues, held items, branch/push state | Update the dated banner |
| Vault `05-GitHub-Commit-Timeline.md` | Each pushed commit | After each wave's push |
| Vault `06-Data-Provenance-Rules.md` | New sources and user decisions on data (NAIA SCM evidence, altitude, robots exemptions) | Name the manifest id or constant |
| Vault `08-Open-Decisions-For-You.md` | Questions asked and answered | Strike through when answered, with the date |

### Per item
| Item | Repo docs | Vault |
| --- | --- | --- |
| **D0 catch-up (wave 1)** | CHANGELOG: every user-visible change from `98bb59d8` to now (JSON personal bests, diving scores, data-loss guard, division conversion, estimates/altitude/self-reported, bests correctness, badges/season/pulled date, compact labels, analytics course, single-team refresh, NAIA SCM, improvements preview, P15). INVARIANTS: `isRankableSwim` is the only best-time gate; an `A`-tagged time is never altitude-adjusted again; NCAA SCM conversion truncates; a cut table's course must match the swim's; robots exemptions are exact path shapes. CUTLINE_TAGS_PLAN: new states (`converted_estimate`, `user_inputted`, `extracted_split`), division SCM tables, altitude table, NAIA SCM decision. USER_GUIDE: features already shipped. plans/STATE.md: pointer to this plan. | 02, 05 (backfill commits since `cc97db7a`), 06, 08 |
| A1 | CHANGELOG (Added: replace reimport); USER_GUIDE (how and when to replace); INVARIANTS (replace never touches manual/PDF data; always backs up first) | Session, 04 |
| A2, A4 | USER_GUIDE ops note on backups and the stale-table report | 04 |
| A3 | Findings in the progress log; any bug found becomes a new item | Session, 04 |
| B1, B3, B4 | CHANGELOG (Changed/Fixed); CUTLINE_TAGS_PLAN for B1/B4; INVARIANTS for B4 (no conversion for an event that does not exist in its course) | 02, 04 |
| B5 | CHANGELOG; source archived with manifest entry | 06 |
| C1, C4-print | CHANGELOG (Added); USER_GUIDE | Session |
| C3 | CHANGELOG; USER_GUIDE; INVARIANTS (second robots exemption, on-demand only) | 06 (exemption), 02 |
| C6 | none | none |
| **D-final (wave 5)** | Re-read every doc above against the shipped app; fix drift | Full vault pass: 00-INDEX links, 04 banner, 05 timeline, 08 answered questions |

Delegation: repo docs for an item go in that item's brief, so the agent that
builds a feature writes its CHANGELOG/INVARIANTS lines. USER_GUIDE and the
vault are written by the orchestrator or a docs worker after the code lands,
because they describe the shipped UI.

## 5. Blockers (answers recorded 2026-09-24)
1. **C4-hy3:** held until a real `.hy3` sample exists.
2. **C3:** approved.
3. **B5:** planned for other users' benefit.
4. **C2:** dropped.
