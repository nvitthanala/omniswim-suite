# Roster Aliasing, Bug-Fix & Declutter — Handoff (Round 3)

> Companion to `MATRIX_RESCORE_OVERHAUL_HANDOFF.md` (round 2) and
> `ROSTER_LINEUP_BUGS_DEEPDIVE.md` (this round's root-cause report). Covers the
> 2026-07-19 round: athlete name aliasing, the roster/lineup bug-fix wave, and the
> Lineup-step declutter (drawer editor + tabbed side panels).

Last updated: 2026-07-19.

## 1. What this round solved

Three live-testing complaints on the HSU workspace:

1. **Duplicate athletes from name variants** — "Stevie Balistreri" (meet PDF) vs
   "Steven Balistreri" (SwimCloud recruit), "Alan Gonzalez Mujica" vs long-form
   "Alan Alejan Gonzalez Mujica". No hardcoding wanted; explicit linking with
   app-suggested candidates.
2. **Roster/lineup editing screen far too crowded.**
3. **Removal didn't stick and edits landed on the wrong athlete** ("editing Curtis
   showed/edited Colin's lineup"). Root-caused end-to-end in
   `ROSTER_LINEUP_BUGS_DEEPDIVE.md`; all fix-plan items applied (see §3).

## 2. Athlete name aliasing

**Core** (`packages/core/src/lib/athleteAliases.ts`; types in `types.ts`):

- `Workspace.athleteAliases?: AthleteAliasLink[]` — `{id, gender, team?,
  canonicalName, aliasName, source: 'manual'|'import', createdAt?}`.
- `buildAliasResolver(wsOrLinks)` → `{resolveAthleteName(name, team?, gender?),
  areLinked(a,b,…)}`; cycle-safe, transitive, team/gender-scoped links win over
  global. `IDENTITY_ALIAS_RESOLVER` for no-op paths.
- `addAliasLink` / `removeAliasLink` → `{patch, inverse, description}` (same
  apply/undo contract as swimEditor; inverses round-trip).
- `suggestAliasCandidates(existing, incoming, opts?)` — heuristic only, no
  nickname tables: folded-surname match + first-name relation (shared prefix ≥3 /
  small edit distance, initial-vs-full, token-subset for SwimCloud long forms),
  "Last, First" handled; excludes linked/identical/cross-gender; never auto-links.
- Resolution threaded (additive optional params, defaults preserve behavior) into
  `historyImportRoster.ts` (grouping, preview actions, import), `athleteHistory.ts`
  (`getAthleteProfile` defaults to workspace resolver), `scorerRoster.ts`
  (`buildScorerRosterLookup` resolves before keying; `scorerRosterKey` stays pure).
- `rosterNamesForTeam` is now exported from `historyImportRoster.ts` (UI reuses it).

**Persistence** (`packages/db`): new `athlete_aliases` collection table (one row
per link, JSON blob, same pattern as `meet_entry_plans`). SQLite `SCHEMA_VERSION`
**5→6**, PG `PG_SCHEMA_VERSION` **4→5**; wired through `workspacePersistence.ts` and
both services; JSON store passes the field through untouched.

**UI**:

- **Import suggestions** (`AliasSuggestionsPanel.tsx`, used by
  `AthleteHistoryImportPanel` and `RosterImportWizard`): after Parse, a "Possible
  same athlete" list (incoming ↔ existing, reason, score %, top 8 + expander) with
  **Link** (persists `source:'import'` link, preview re-derives — NEW flips to
  improvement/SAME) and **Dismiss** (session-local). `buildHistoryBestIndex` is now
  resolver-aware so the per-row diff badges honor links.
- **Drawer alias manager**: "Aliases" section in the athlete editor header — lists
  links involving the athlete, add manual alias, remove link; all via the shared
  applyPatch/undo-chip machinery.

Tests: `scripts/test_athlete_aliases.mjs` (resolver transitivity/scoping, patch
round-trips, the motivating suggestion cases + negative case, import-diff
unification), plus `athleteAliases` in the sqlite round-trip test.

## 3. Bug-fix wave (see `ROSTER_LINEUP_BUGS_DEEPDIVE.md` for causal chains)

All core+manager fixes from the deep-dive fix plan are implemented:

- **`simulateRoster` safety block** uses `processedRelayKeys` (original keys) — a
  removed/senior relay swimmer no longer reappears and relays no longer
  double-count. *(Bug 2 primary — the load-bearing fix.)*
- **`isGraduatingClassYear`** (SR/SENIOR/GR/GRAD, case-insensitive) shared by
  individual + relay "Drop seniors" filters.
- **`canonicalSwimmerName`** folds "Last, First" → "first last" (suffix-safe;
  `normalizeSwimmerName` untouched); used in `scorerRosterKey`, exclusion matching,
  departed-leg lookup, manager plan/jump matching → one human = one roster row.
- **Placeholder relay legs** (`—`/empty/Unknown) skipped in roster building.
- **Lost-update guard**: `workspaceRef` composes successive patches in
  `AthleteLineupEditorPanel` / `TeamManagementView.applySwimPatch` (store-level
  functional updater left as future work).
- **Jump effect** clears selection + toasts on miss (never silently keeps the
  previous athlete editable); checklist items carry `athleteKey`, matched before
  name fallback. *(Bug 1 primary.)*
- **Delete UX**: `SwimmerDeleteConfirmModal` now offers **Hide from What-if
  projection** vs **Remove from workspace permanently** (new core
  `removeAthleteFromWorkspace` — strips working individual rows/plans/history/
  overrides, tags `DeletedSwimmerRef.mode:'removed'`, full-undo inverse; frozen
  `sourceMen/WomenResults` never touched; Restore rebuilds from source). Removed
  list shows Hidden/Removed badges and is visible read-only outside What-if.
- Deferred (low, latent): `TeamRosterPanel` `pickedTeam` dual source of truth —
  single call site is fully controlled today.

Tests: `scripts/test_roster_removal.mjs` (8 groups: safety block, GR parity,
canonical folds, placeholder skip, one-row collapse, permanent-removal round-trip).

## 4. Lineup-step declutter

- **Athlete editor is now a right-side drawer** (`AthleteLineupEditorPanel`,
  `w-[min(40rem,92vw)]`, sticky header: large name · team · class · role badge ·
  scorer toggle · Aliases · close). Body sections collapsible: Individual entries
  (open), Relay involvement, Credited swims, Supplemental history. Escape /
  backdrop / X close; `id="athlete-lineup-editor"` kept.
  **Backdrop renders only below `lg`** — on desktop the roster table stays
  clickable beside the drawer so switching athletes is one click (an
  earlier full-viewport transparent backdrop swallowed row clicks; fixed
  post-agent and verified live).
- **Side panels → tabs** in `RosterLineupStep` (Checklist(default, count badge) /
  Arbitrage / Scenarios via `SegmentedControl`); roster grid 8→9 cols.
- **Roster rows**: warning pills collapsed to one amber chip with a tooltip
  listing all issues; `AthleteRoleTag` extracted to its own file.

## 5. Verification (2026-07-19)

- `npm run lint` clean (all 7 workspaces); `npm test` **32 passed / 0 failed /
  2 pre-existing fixture skips** (adds `test_athlete_aliases`,
  `test_roster_removal`).
- **Live Playwright drives** against the real HSU workspace (dev server :3000):
  drawer opens with correct athlete; **one-click athlete switching** after the
  backdrop fix; Escape closes; delete modal two options; permanent removal of an
  SR → gone from roster, "Removed" badge, list visible read-only with What-if off,
  Restore rebuilds all rows (workspace byte-identical after round-trip);
  SwimCloud paste + Parse → "Possible same athlete" suggested both Balistreri
  variants (87% / 82% with reasons) → Link flipped both NEW badges; alias
  remove via drawer verified. No page errors.
- Drive-created alias links were removed afterwards — the workspace was left as
  found (`athleteAliases: []`, `deletedSwimmers: []`).

## 6. Known caveats / open items

- **Git state**: all changes uncommitted by design (round-2 note about
  `TeamManagementSubTabs.tsx` needing `git rm` still applies).
- `aliasNameKey` (aliases) does not fold "Last, First"; `canonicalSwimmerName`
  (identity) does. Effective identity is resolve→canonicalize at call sites, so
  behavior is correct, but a comma-order alias link is stored un-folded —
  unifying the two folders is a small future cleanup.
- Import suggestions surface only for `new_recruit` rows; an athlete already on
  the recruit list won't be re-suggested (link manually via the drawer).
- The delete affordance (trash button) is still What-if-gated; only the removed
  list is visible outside What-if.
- `TeamRosterPanel` `pickedTeam` dual-source (deferred, §3).
- Round-2 §8 items (cutline data gaps, `ScoringSettingsModal` scoring-view
  control, relay-entry add/drop, round-1 §6 leftovers) remain open.

## 7. AI-assisted workflow notes (this round)

Per round-2 §9: Fable orchestrated (recon, briefs, sequencing, integration
de-dupe, backdrop fix, live verification, docs). Opus subagents: read-only bug
deep-dive (report in `ROSTER_LINEUP_BUGS_DEEPDIVE.md`), core+db aliasing, and the
bug-fix wave — run **sequentially** where they shared `packages/core`. Sonnet
subagents ran **in parallel** on disjoint manager scopes (drawer/tabs declutter;
import alias UI). Session-limit interruptions were resumed from agent transcripts
without losing work. Live verification found one integration regression the
agents' static checks could not (backdrop click interception) — worth keeping a
Playwright drive in every UI round.
