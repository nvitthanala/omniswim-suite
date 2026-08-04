# Roster / Lineup Bugs — Deep-Dive Root-Cause Report

**Implementation status (2026-07-19):** every fix-plan item below is implemented
except (b)5 (`pickedTeam` dual source — deferred, low/latent; single call site is
fully controlled). Regression coverage lives in `scripts/test_roster_removal.mjs`;
the flows were also driven live via Playwright. See
`ROSTER_ALIAS_DECLUTTER_HANDOFF.md` §3 for the change log.

> Read-only investigation of the Manager roster/lineup workflow on branch
> `feat/roster-management-overhaul` (working tree as-is). Focus: three live-testing
> bugs on the HSU roster workspace (swimmers incl. Curtis Malone, Colin Candebat).
> Every finding below is traced end-to-end; the two headline bugs are reproduced with
> throwaway scripts driving the real core functions.

Reachable-surface note (confirmed via `MATRIX_RESCORE_OVERHAUL_HANDOFF.md` §6): the
**unified** `AthleteLineupEditorPanel` is the only reachable athlete editor
(`editorMode="unified"` is the sole call site, set in `RosterLineupStep.tsx:147`). The
"legacy" branch of `TeamRosterPanel` and `AthleteMeetEntriesPanel` are dead in the
current wiring; `IndRelayManagementView` is the Relays step, not an athlete editor.

---

## BUG 1 — Wrong-athlete attribution: editing "Curtis" edits the previously-open athlete (Colin)

**Severity:** High (silent data corruption — edits land on the wrong athlete).
**Confidence:** Confirmed by code trace.

### Root cause (primary): the "Jump" selection path silently no-ops and leaves the prior athlete open

Athlete selection inside the roster lives **only** in `TeamRosterPanel`'s local state
`selectedAthleteKey` (`TeamRosterPanel.tsx:177`). Two different mechanisms move it:

1. **Direct row click** — `toggleAthleteSelection` (`TeamRosterPanel.tsx:284-292`) sets
   `selectedAthleteKey = row.key` locally **and then** calls
   `onAthleteSelect({name,team,classYear})`.
2. **"Jump" from the compliance checklist and the cross-course arbitrage panel** —
   these do **not** touch local state. They only call
   `onAthleteSelect?.({ name, team: selectedTeam, classYear: '' })`
   (`RosterLineupStep.tsx:166-168` for the checklist, `:177` for arbitrage).

`onAthleteSelect` is `TeamManagementView.handleAthleteSelect`
(`TeamManagementView.tsx:80-85`), which sets `recruitPrefill` **and**
`jumpAthleteName` (`setJumpAthleteName(athlete.name)`). `jumpAthleteName` flows back down
`RosterLineupStep.tsx:159` → `TeamRosterPanel` `jumpAthleteName` prop.

The only code that converts a jump into an actual selection is the jump effect
(`TeamRosterPanel.tsx:257-272`):

```ts
useEffect(() => {
  if (!jumpAthleteName) return;
  const key = normalizeSwimmerName(jumpAthleteName);
  const row = teamRows.find(r => normalizeSwimmerName(r.name) === key);
  if (row) {                              // <-- only path that moves selection
    setSelectedAthleteKey(row.key);
    onAthleteSelect?.({ ... });
    requestAnimationFrame(...scrollIntoView...);
  }
  onJumpAthleteHandled?.();               // clears jumpAthleteName regardless
}, [jumpAthleteName, teamRows, onAthleteSelect, onJumpAthleteHandled]);
```

**When `row` is not found, `setSelectedAthleteKey` is never called** — the previously
selected athlete stays selected, the editor keeps rendering that athlete, and
`jumpAthleteName` is cleared so there is no retry. Because the *checklist/arbitrage*
jump has no local-selection fallback, selection depends entirely on this lookup
succeeding.

Causal chain the user hit:

1. Colin's editor is open (`selectedAthleteKey` = Colin's key).
2. User clicks **Jump** on a checklist item that reads "Curtis…" (e.g. "Curtis Malone:
   scorer with no individual entries" or a relay gap). → `onAthleteSelect({name:"Curtis
   Malone", team, classYear:''})` → `setJumpAthleteName("Curtis Malone")`.
3. Jump effect runs: `teamRows.find(normalizeSwimmerName(r.name) === "curtis malone")`
   returns **undefined** (see the two ways this happens below).
4. `setSelectedAthleteKey` is skipped; `jumpAthleteName` is cleared. **Editor still shows
   Colin.** "The screen did not change to the newly selected athlete."
5. The user edits entries/scorer/history; every handler in
   `AthleteLineupEditorPanel` uses the `athlete` prop (= Colin). Edits are applied to
   Colin.

Two concrete ways `teamRows.find(...)` misses, both real here:

- **Name-format divergence.** `normalizeSwimmerName` (`utils.ts:254-256`) only lowercases
  and collapses whitespace — it does **not** canonicalize "Last, First" vs "First Last".
  The checklist's `athleteName` is `displayName` picked from
  `buildScorerRosterLookup(allScored,…)` (`rosterLineupAudit.ts:196-199, 213/226/243/332`),
  while the roster rows are picked from `buildScorerRosterLookup(allResults,…)`
  (`TeamRosterPanel.tsx:211-215`). These are two different lookups over two different
  arrays; the "first-seen raw name" for a given normalized key can differ between them, and
  any "Last, First" ↔ "First Last" mismatch yields a different normalized key entirely, so
  `find` misses. (Reproduced under Bug 2 below — the same person surfaces as both
  `"Curtis Malone"` and `"Malone, Curtis"`.)
- **Departed / off-roster target.** Relay-gap checklist items can carry the name of a
  swimmer who is no longer a roster row on the selected team (vacated / soft-removed / a
  leg name that never became an individual row). Jump then finds nothing.

### Root cause (contributing): exact-string plan filter in the editor

`AthleteLineupEditorPanel.tsx:155-158`:

```ts
const athletePlans = plans.filter(
  p => p.name === athlete.name && p.team === athlete.team && p.gender === gender
);
```

This is **exact** equality on `name`/`team`, whereas the same component matches history
with `normalizeSwimmerName` (`:181-190`) and the rest of the system keys on
`scorerRosterKey`/`normalizeSwimmerName`. Plans are written with `athlete.name`
(`addPlannedEntry`, `AthleteLineupEditorPanel.tsx:377-386`), so if `athlete.name` differs
in case/spacing/format from the name stored on the plan (optimizer output, paste import, a
re-cased row), **the athlete's own entries silently disappear from their editor** and a new
add creates a second, differently-named plan row for the same person. This compounds Bug 1:
the panel can look like it "belongs to someone else" (empty where it should be full). Same
defect in the (currently dead) `AthleteMeetEntriesPanel.tsx:51` and in
`importFromPaste` (`AthleteLineupEditorPanel.tsx:484-486`).

### What is NOT the cause (ruled out)

- No `scorerRosterKey` collision between Curtis and Colin — they normalize to distinct
  keys, and within one team+gender view the key is fully determined by the normalized name,
  so `teamRows` never contains two rows with the same normalized name (find-by-name ≡
  find-by-key).
- Virtualization (`ROSTER_WINDOW_THRESHOLD = 80`, `TeamRosterPanel.tsx:34`) is inactive on
  the ~30-athlete HSU roster; not the trigger.
- The editor fully re-derives all content from the `athlete` prop
  (`creditedSwims`/`relayInvolvement`/`athleteHistoryRows` memos include `athlete.name`),
  and resets transient editing state on `athlete.key` change
  (`AthleteLineupEditorPanel.tsx:136-140`). So *if* selection actually moves, the panel
  updates correctly — the bug is purely that selection fails to move.

### Proposed fix (manager)

1. **Make jump authoritative and non-silent.** In `TeamRosterPanel.tsx:257-272`, when no
   row matches, do not leave the stale athlete selected — clear it and surface a toast:
   ```ts
   if (row) {
     setSelectedAthleteKey(row.key);
     onAthleteSelect?.({ name: row.name, team: row.team, classYear: row.classYear });
     requestAnimationFrame(() => document.getElementById('athlete-lineup-editor')
       ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
   } else {
     setSelectedAthleteKey(null);
     onAthleteSelect?.(null);
     toast.push('info', `Could not open ${jumpAthleteName} on ${selectedTeam}.`);
   }
   onJumpAthleteHandled?.();
   ```
   Clearing (rather than keeping the previous athlete) removes the "edits go to the wrong
   person" trap even when the target genuinely isn't on the team.
2. **Give the checklist/arbitrage jump a key, not just a name.** Prefer resolving to a
   `ScorerRosterRow.key` rather than re-matching by raw name. Minimal version: in
   `rosterLineupAudit.ts` also emit `athleteKey = scorerRosterKey(team, gender, displayName)`
   on each `LineupChecklistItem`, thread it through `LineupComplianceChecklist`/
   `RosterLineupStep`, and have the jump effect match `teamRows.find(r => r.key === key)`
   first, falling back to normalized-name.
3. **Normalize the plan filter.** Change `AthleteLineupEditorPanel.tsx:155-158` (and the
   `importFromPaste` reconstruction at `:484-486`) to match
   `normalizeSwimmerName(p.name) === normalizeSwimmerName(athlete.name)` and trimmed team,
   matching how history is matched two lines below. (Do the same in
   `AthleteMeetEntriesPanel.tsx:51,79-81,171` if that surface is ever re-enabled.)

### Regression risks / tests

- Fix #1 changes behavior from "keep previous" to "clear + toast"; add a manager test (or
  Playwright) asserting that a Jump to a name absent from `teamRows` closes the editor and
  never leaves the previous athlete editable.
- Fix #3 could surface *more* plans if data has mixed-format duplicate plan rows — desired,
  but verify entry-limit counts (`countSwimmerEntries`) don't double-count; they already
  scan results, not plans, so low risk.

---

## BUG 2 — Cannot actually remove seniors / graduating athletes

**Severity:** Critical (removal is ineffective for any relay swimmer; also double-counts
relay points).
**Confidence:** Confirmed by reproduction against the real core (`simulateRoster` →
`buildWhatIfResults` → `buildScorerRosterLookup`).

### Root cause (primary): `simulateRoster` re-emits the ORIGINAL relay legs after modifying them

`simulateRoster` (`utils.ts:1441-1714`) rebuilds relays when any roster change is active
(`removeSeniors || excluded.size>0 || overrides || vacate`, `:1452-1453`). For a modified
relay it emits new leg rows with a **new team time** (`newTeamStr`, vacate adds +3.0s per
missing leg, `:1560,1684-1687`). Then a "safety" block at the end tries to re-add any relay
group that was skipped:

```ts
// utils.ts:1700-1711
const emittedRelayKeys = new Set(finalResults.filter(r => r.isRelay).map(r => relayGroupKey(r)));
for (const r of results) {
  if (!r.isRelay) continue;
  const k = relayGroupKey(r);              // key of the ORIGINAL row (original time)
  if (emittedRelayKeys.has(k)) continue;
  ... finalResults.push(originalGroup) ...
}
```

`relayGroupKey` (`utils.ts:258-264`) includes the team clock
(`relayTeamClock = relayTeamTime ?? finalsTime ?? …`, `utils.ts:1001-1003`). The modified
legs carry the **changed** `relayTeamTime`, so their `relayGroupKey` differs from the
original legs' key. Therefore `emittedRelayKeys` never contains the *original* group's key,
and the safety block **re-adds every original leg row — including the removed swimmer's leg
under their original name.**

`processedRelayKeys` (`utils.ts:1468,1476-1478`) already holds the correct *original* keys
of every group the main loop handled; the safety block simply uses the wrong set.

**Reproduction (realistic: designated scorers, `relayTeamTime` set, remove one senior on a
medley relay):**

```
after softRemoveSwimmerFromWorkspace({name:'Curtis Malone'}):
relay legs count: 8
  leg0 "—"            t=3:13.00 vacant   ← modified relay
  leg1 "Colin Candebat" t=3:13.00
  leg2 "Beni X"       t=3:13.00
  leg3 "River Y"      t=3:13.00
  leg0 "Curtis Malone" t=3:10.00        ← ORIGINAL relay re-added by safety block
  leg1 "Colin Candebat" t=3:10.00
  leg2 "Beni X"       t=3:10.00
  leg3 "River Y"      t=3:10.00
roster rows AFTER remove Curtis: ["—","Beni X","Colin Candebat","Curtis Malone","River Y"]
```

`buildScorerRosterLookup` iterates every result row and makes a roster entry from each
relay-leg row whose `name !== team` (`scorerRoster.ts:115-136`). So the surviving original
leg keeps **"Curtis Malone" in the roster after removal** — exactly "cannot actually remove
him". The same duplication scores the relay twice (a 3:13 vacated entry *and* a clean 3:10
entry).

This fires for **every** removal path that modifies a relay: soft-remove (`deletedSwimmers`),
the "Drop seniors" toggle (`removeSeniors`), and non-scorer leg vacate. Any athlete who
swims a relay cannot be removed from the roster.

### Root cause (secondary): removal is what-if-only and never permanent

- The delete affordance exists only in what-if mode: `onRequestDeleteSwimmer` is passed as
  `undefined` unless `whatIfMode` (`ManagerApp.tsx:169-171`), and the row button requires
  `editable && onRequestDeleteSwimmer` (`TeamRosterPanel.tsx:605-617`). Turn What-if off to
  "see the real roster" and every removed athlete is back.
- `softRemoveSwimmerFromWorkspace` (`swimmerSoftRemove.ts:23-72`) deliberately keeps
  `menResults/womenResults` intact and only records `deletedSwimmers`. Removal is applied
  **only in the projected/what-if bundle** — `buildScoringBundle` runs `buildWhatIfResults`
  (which honors `deletedSwimmers`, `whatIfProjection.ts:208-212`) only when
  `applyWhatIf` is true (`scoringEngine.ts:72-77`). The **baseline** bundle
  (`applyWhatIf:false`) uses the frozen source with `overrides=[]` and no `simulateRoster`,
  so baseline always still contains the athlete. There is **no** code path that permanently
  drops an athlete from a team (`removeCreditedSwim` deletes a single credited row by id, not
  an athlete).
- The confirmation copy over-promises: `SwimmerDeleteConfirmModal.tsx:42-45` says "All
  individual swims for this athlete will be removed from the workspace." In reality the
  source rows are untouched and only the what-if projection hides the individual rows.

### Root cause (tertiary): `removeSeniors` senior test is narrower for individuals than for relays

Individual filter (`utils.ts:1461`):
```ts
if (removeSeniors && (r.classYear === 'SR' || r.classYear === 'Sr' || r.classYear === 'Senior')) return false;
```
Relay-leg filter (`utils.ts:1526-1527`):
```ts
const isSeniorLeg = leg.year === 'SR' || leg.year === 'Sr' || leg.year === 'Senior' || leg.year === 'GR';
```
The individual path omits `'GR'` (grad) and any lowercase/other form (`'sr'`, `'5th'`,
etc.). `ClassYear` enum (`types.ts:11-17`) has no `GR`, so seeded seniors are `'SR'` and do
drop — but PDF-parsed rosters can carry `'GR'`/`'Gr'` grad students that "Drop seniors" then
leaves in individual events while stripping them from relays. Directly matches "cannot remove
… graduating athletes."

### Root cause (contributing): exclusion matches by normalized name only, no Last/First canonicalization

`deletedSwimmers` matching uses `normalizeSwimmerName` (`whatIfProjection.ts:208-212`,
`swimmerSoftRemove.ts:31,40,53`). When a relay leg's stored name format differs from the
individual/deleted name (e.g. relay `relayNames` = "Malone, Curtis" vs individual
"Curtis Malone"), the exclusion never matches the leg — the leg is not vacated, and the
person survives in the roster under the alternate format. Reproduced: removing
"Curtis Malone" left a separate `"Malone, Curtis"` roster row. This is independent of the
primary safety-block bug and would remain even after fixing it.

### Proposed fix

**(a) core — the load-bearing fix.** In `simulateRoster` (`utils.ts:1700-1711`) replace the
recomputed `emittedRelayKeys` with the already-correct original-key set:

```ts
// Safety: re-add only groups the main loop never processed (compare ORIGINAL keys).
for (const r of results) {
  if (!r.isRelay) continue;
  const k = relayGroupKey(r);
  if (processedRelayKeys.has(k)) continue;   // was: emittedRelayKeys.has(k)
  const group = results.filter(x => x.isRelay && relayGroupKey(x) === k);
  group.forEach(row => finalResults.push(row));
  processedRelayKeys.add(k);
}
```
Since `processedRelayKeys` is keyed on the original (pre-modification) rows, a modified relay
is correctly recognized as already-handled and is not duplicated. This removes the phantom
original legs, fixes the roster reappearance, and stops the relay double-count.

**(b) core — senior test parity.** Factor a single `isGraduatingClassYear(y)` helper
(case-insensitive; `SR`/`SENIOR`/`GR`/`GRAD`) and use it in both `utils.ts:1461` and
`:1526-1527`.

**(c) core — robust name matching for exclusion (optional, defense-in-depth).** Add a
name-canonicalizer that folds "Last, First" → "First Last" (or compares as an unordered
token set) and use it wherever `deletedSwimmers`/relay-leg names are compared. Simplest: a
`canonicalSwimmerName` in `utils.ts` used by `normalizeSwimmerName` callers that must match
across data sources.

**(d) manager — honest UX for "hide vs delete."** Either (i) relabel the action as
"Hide from projection (What-if)" and correct
`SwimmerDeleteConfirmModal.tsx:42-45`, or (ii) implement a true permanent removal
(filter `menResults/womenResults` for the athlete via `removeCreditedSwim`-style patches,
with undo) so the athlete leaves baseline too. At minimum, expose removed-swimmer management
outside What-if so the state is discoverable.

### Regression risks / tests

- Fix (a): add a core test (extend `scripts/test_relay_swaps.mjs`, which already seeds a
  `deletedSwimmers` case at `:296`) asserting the relay-leg **count is unchanged** after a
  removal (no duplicate group) and that the removed name does not appear in
  `buildScorerRosterLookup(...).rows`. Verify relay points are not doubled.
- Fix (b): test that a `'GR'` individual is dropped by `removeSeniors` and that `'SR'` still
  drops.
- Fix (a) touches the core relay assembler used by scoring everywhere — run the full
  `scripts/run-tests.mjs` suite; watch `test_relay_swaps`, `test_lineup_audit`,
  `test_event_identity_scoring`.

---

## BUG 3 — Sweep: same defect classes elsewhere

### 3.1 Exact-vs-normalized name matching (same class as Bug 1's plan filter)

**Confidence:** Confirmed. Severity: Medium.

Inconsistent name matching across the codebase — some paths normalize, some compare raw:

| Location | Match | Should be |
|---|---|---|
| `AthleteLineupEditorPanel.tsx:155-158` (athletePlans) | `p.name === athlete.name` (exact) | `normalizeSwimmerName` |
| `AthleteLineupEditorPanel.tsx:484-486` (paste rebuild) | exact | normalized |
| `AthleteMeetEntriesPanel.tsx:51,79-81,171` (dead surface) | exact | normalized |
| `simulateRoster` departed-individual lookup `utils.ts:1547-1552` | `s.name === leg.name` (exact) | normalized |
| `deletedSwimmers` / relay-leg exclusion | normalized only, no Last/First fold | canonical name |

`simulateRoster.ts:1547-1552` uses raw `s.name === leg.name` to find the departed swimmer's
individual split for time deltas — if the relay leg name and the individual row name differ
in format, the delta silently falls back to the split-based path (subtly wrong replacement
times). Same root as Bug 2's tertiary cause.

Fix: route all athlete-identity comparisons through `normalizeSwimmerName` (or a new
`canonicalSwimmerName` that also folds "Last, First"). Core + manager.

### 3.2 Stale-workspace snapshot across rapid successive patches

**Confidence:** Confirmed by design. Severity: Medium.

Every editor handler computes its patch from the `workspace` **prop closure** and calls
`onUpdate` with a full-array replacement. E.g. `addPlannedEntry`
(`swimEditor.ts:79-106`) returns `meetEntryPlans: [...workspace.meetEntryPlans, entry]`; the
editor's `applyPatch` (`AthleteLineupEditorPanel.tsx:142-146`) fires `onUpdate(result.patch)`
immediately. If the user triggers two edits before React re-renders with the updated
workspace (double-click Add, Add then quickly toggle), the second patch is computed from the
**same stale** `workspace` and its `meetEntryPlans: [...stale, x2]` **overwrites** the first
edit (lost update). The shared "Undo" chip (`lastApplied`) is likewise overwritten so the
first edit can't be undone either. The same stale-base pattern exists in
`AthleteMeetEntriesPanel.patchPlans` (`:78-90`) and `TeamManagementView.applySwimPatch`
(`:87-91`).

Fix (core-friendly): have `updateWorkspace`/`onUpdate` accept a functional updater
`(prev) => patch` (or apply patches against the latest store state inside the provider), and
have the swimEditor helpers compose against the freshest workspace. Alternatively debounce/
disable the action button while a patch is in flight. Manager + core (store).

### 3.3 Controlled vs uncontrolled team selection

**Confidence:** Confirmed (latent). Severity: Low.

`TeamRosterPanel` keeps its own `pickedTeam` **and** honors a `controlledTeam`
(`TeamRosterPanel.tsx:176,182-188`). In the live wiring the parent passes
`selectedTeam={selectedTeam || undefined}` (`RosterLineupStep.tsx:150`) and
`onSelectTeam` (`selectTeam` writes both, `:206-209`), so it is effectively controlled. But
`selectTeam` sets `pickedTeam` locally *and* calls `onSelectTeam`; if the parent's
`selectedTeam` and the local `pickedTeam` ever diverge (e.g. parent resets team via
`TeamManagementView.tsx:74-78` while `pickedTeam` retains a stale value that is still in
`teams`), the memo prefers `controlledTeam` first, so this is currently masked — but it is a
dual-source-of-truth waiting to bite. Recommend making the panel fully controlled (drop
`pickedTeam`, always use `controlledTeam`/`onSelectTeam`). Manager.

### 3.4 Roster shows one athlete as two rows (name-format duplication)

**Confidence:** Confirmed by reproduction. Severity: Medium.

`buildScorerRosterLookup` keys rows on `scorerRosterKey(team,gender,normalizeSwimmerName(name))`
(`scorerRoster.ts:120`). Because `normalizeSwimmerName` does not fold "Last, First",
a swimmer whose individual rows say "Curtis Malone" but whose relay `relayNames` say
"Malone, Curtis" produces **two roster rows** for one person (reproduced:
`["…","Curtis Malone","Malone, Curtis",…]`). Each row has independent plans/history/scorer
state, and only one matches any given Jump or delete. This is a first-class contributor to
both Bug 1 (jump/edit lands on the "other" identity) and Bug 2 (delete one identity, the
other remains). Fix = the canonical-name folding from 3.1 applied inside
`scorerRosterKey`/`normalizeSwimmerName`. Core.

### 3.5 Vacated relay legs create a phantom "—" roster row

**Confidence:** Confirmed by reproduction. Severity: Low.

A vacated leg is emitted with `name: '—'` (`utils.ts:1561,1619`). `buildScorerRosterLookup`
only skips relay rows where `name === team` (`scorerRoster.ts:117`), so a `'—'` leg becomes
a roster row named "—" (seen in every repro above). Cosmetic but confusing during exactly the
removal flow the user was testing. Fix: skip `name === '—'` (and empty) relay rows in
`scorerRoster.ts:115-121` (and in `memberCounts`, `TeamRosterPanel.tsx:154-168`). Core +
manager.

---

## Fix plan

### (a) Core fixes
1. **`utils.ts` `simulateRoster` safety block (`:1700-1711`)** — use `processedRelayKeys`
   (original keys) instead of the recomputed `emittedRelayKeys`. *Fixes Bug 2 primary:
   removed/senior relay swimmers no longer reappear; stops relay double-count.* **Highest
   priority.**
2. **`utils.ts` senior test parity (`:1461` vs `:1526-1527`)** — shared case-insensitive
   `isGraduatingClassYear` incl. `GR`. *Fixes Bug 2 tertiary (grads).*
3. **Canonical name matching** — add `canonicalSwimmerName` (fold "Last, First") and use it
   in `normalizeSwimmerName`/`scorerRosterKey` and the exclusion/departed-lookup comparisons
   (`whatIfProjection.ts:208-212`, `utils.ts:1547-1552`, `swimmerSoftRemove.ts`). *Fixes Bug
   2 contributing + Bug 3.1/3.4; also removes one of Bug 1's miss causes.*
4. **Skip `'—'`/empty relay rows** in `scorerRoster.ts:115-121`. *Bug 3.5.*
5. **(Store) functional `updateWorkspace` updater** so rapid patches compose. *Bug 3.2.*

### (b) Manager UI fixes
1. **`TeamRosterPanel.tsx:257-272`** — jump effect: clear selection + toast when the target
   is not found (never leave the previous athlete editable); prefer matching a threaded
   `athleteKey` over raw-name. *Fixes Bug 1 primary.*
2. **`AthleteLineupEditorPanel.tsx:155-158` (+ `:484-486`)** — normalize the plan filter to
   `normalizeSwimmerName`, matching the history filter. *Fixes Bug 1 contributing.*
3. **`rosterLineupAudit.ts` / `LineupComplianceChecklist` / `RosterLineupStep`** — carry an
   `athleteKey` on checklist items and thread it into the jump. *Hardens Bug 1.*
4. **Delete UX** — correct `SwimmerDeleteConfirmModal.tsx:42-45` wording and either relabel
   as "Hide from What-if" or implement true permanent removal from `menResults/womenResults`;
   make removed-swimmer state discoverable outside What-if. *Fixes Bug 2 secondary
   perception.*
5. **Make `TeamRosterPanel` fully controlled** (drop `pickedTeam`). *Bug 3.3.*
```
