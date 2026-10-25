# Round 3 known bugs (2026-07-19)

Moved from `CLAUDE.md` on 2026-10-11. All three are fixed. Live UI
verification is still pending. The text below is unchanged.

## Known Bugs & Follow-up Items (2026-07-19 round — all three FIXED, live UI verification pending)

### 1. Total Event Limitation (NSISC Rules) — FIXED

- NSISC is **total-only**: max 7 events per swimmer, any individual/relay mix (user decision 2026-07-19); per-type caps set to 999 in the preset.
- `maxTotalEntriesPerSwimmer` added to `ScoringSettings`, NSISC preset (7), `mergeScoringSettings` conference override, `swimmerEntryLimits.ts` (counts.total, totalOver, canAcceptAnotherEntry), `historyImportRoster.ts` (totalSlots), `scoringTheory.ts`, `rosterLineupAudit.ts` (checklist item), and settings UIs (RosterScoringSetup, matrix ScoringSettingsPanel/Modal).
- Label shows "N/7 total (x ind · y relay)" when a total cap is set.

### 2. Swimmer Attribution for Long-Form Names — FIXED

- Heuristic was fine (Alan Gonzalez ↔ Alan Alejan Gonzalez Mujica scores 90%). Root cause: import suggestions only surfaced for `new_recruit` rows, so an athlete already on the recruit list under a long-form name never got a link offer.
- Fix: both import panels (`AthleteHistoryImportPanel`, `RosterImportWizard`) now feed ALL incoming rows to `suggestAliasCandidates` (identical/already-linked pairs are auto-excluded, so no spam).

### 3. Lineup Paste Feature Locks Editing — FIXED

- Paste in the athlete drawer is now a two-step preset: Parse → checkbox preview list ("Add selected" / "Cancel") instead of auto-applying and clobbering the athlete's entries. Existing entries stay editable throughout (event select, time edit, remove, active toggle).
