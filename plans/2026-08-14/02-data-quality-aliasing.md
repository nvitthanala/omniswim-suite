# 02 — Data quality, aliasing and provenance

Measured against both live workspaces on 2026-08-14.

---

## 1. The conversion table has no provenance

**Severity: P1.** `packages/core/src/constants.ts:8-30`

`CONVERSION_FACTORS` is 17 hand-typed rows of course-conversion factors:

```ts
'50 Freestyle': { men_lcm: 0.87, women_lcm: 0.881, both_scm: 0.906 },
```

Compare what the cutlines get (`CLAUDE.md` §"Data provenance", rule 1):

> *"Every value traces to a primary source. PDFs are archived under
> `data/cutlines/sources/` with a `manifest.json` recording `{url, sha256,
> retrievedAt}`. No competition time is ever hand-typed into a `.ts` file."*

The conversion factors are held to none of that, and they are used on exactly the
same class of value — they turn one competition time into another.

### Why this is not theoretical

The IM bug fixed today (`ad616e69`) lived here. `CONVERSION_FACTORS` was keyed
`'200 IM'` while the canonical label is `'200 Individual Medley'`, so **57 real
swims** silently converted with the 50 Freestyle factor. Nothing could have
caught it: there was no source document to diff the table against, and no test
asserting the keys were reachable.

The blast radius was small only because 0.867 and 0.870 are close. A future row
with a genuinely different factor fails loudly in the numbers and silently in the
code.

### Proposed fix

Mirror the cutlines treatment exactly:

1. `data/conversions/sources/` — the published USA Swimming / NCAA conversion
   factor document, archived.
2. `data/conversions/manifest.json` — `{url, sha256, retrievedAt}`.
3. `data/conversions/<season>.json` — the values, parsed from the PDF, not typed.
4. `constants.ts` reads the JSON rather than inlining literals.
5. A test asserting **every key is reachable from `normalizeEventLabel`** — the
   assertion that would have caught the IM bug on the day it was written.

- **Effort:** ~half a day, most of it sourcing the document.
- **Risk:** low. Values should be unchanged; if any differ, that is the finding.
- **Open question:** which body's table is authoritative here? USA Swimming
  publishes conversion factors; the NCAA does not, to my knowledge, publish an
  official set for championship seeding. **Worth confirming before archiving —
  if no governing body publishes these, that is itself important to record**, and
  the honest label for the whole table becomes "indicative, not official",
  matching the `converted_estimate` rule already in `cutlineTags.ts`.

---

## 2. Four athletes are still two people each

> **⚠ CORRECTED 2026-08-15 — the cause below is WRONG, and the truth is worse.**
> These four pairs are **already linked**: `athleteAliases` holds all four as
> `status: 'active'`, and `buildAliasResolver` merges every one of them
> correctly. The original probe counted distinct name *strings* without checking
> whether they were aliased, so "unresolved" was a false alarm.
>
> The symptom described below is nonetheless real, and its actual cause is a
> defect: **`buildScorerRosterLookup` does not apply the alias resolver.**
> Measured on `Blank Workspace 1` — 47 scorer-roster rows containing BOTH
> spellings of all four pairs. So a split athlete still occupies two of the 18
> scorer slots, still appears twice on the roster, and each half still sits
> independently under the 7-event cap — **even though the user linked them.**
>
> That is worse than an unlinked athlete: the operator did the work and got
> nothing for it, with no indication the link was ignored. See §2a below.
>
> The detection work built for this finding (`detectDuplicateAthletes`, surfaced
> in the compliance checklist) still stands and correctly reports **0 pairs**
> here — there is genuinely nothing left to link.

**Severity: P1.** Measured in `Blank Workspace 1`.

181 distinct athlete-name strings. **6 aliases recorded.** Four
same-surname/same-initial clusters:

| Spelling A | Spelling B | Likely cause |
| ---------- | ---------- | ------------ |
| `Alan Alejan Gonzalez Mujica` | `Alan Gonzalez Mujica` | long-form vs short-form (the known round-3 case) |
| `Camden Mask` | `Cam Mask` | nickname |
| `Steven Balistreri` | `Stevie Balistreri` | nickname |
| `Afonso Campanico` | `Alfonso Campanico` | **spelling difference between sources** |

The first three are the documented round-3 pattern that
`docs/archive/2026-08/ROSTER_ALIAS_DECLUTTER_HANDOFF.md` and the `suggestAliasCandidates` work
addressed. The fourth is different and more interesting: `Afonso` vs `Alfonso` is
not a nickname, it is one source being wrong. Whichever is the athlete's real
name, the other is a data error worth correcting rather than aliasing.

### Consequence

A split athlete has their history divided across two identities. Both halves are
individually under the 7-entry cap, both get ranked and entered, and the roster
shows two people. It also inflates the "distinct athletes" count feeding scorer
caps (`maxIndividualScorersPerTeam ?? 18`).

Visible today: the arbitrage panel on that workspace listed **both** `Alan Alejan
Gonzalez Mujica` and `Alan Gonzalez Mujica` as separate cards with near-identical
deltas.

### Proposed fix

The detector already exists — `suggestAliasCandidates` scores `Alan Gonzalez ↔
Alan Alejan Gonzalez Mujica` at 90%. What is missing is that it only runs *at
import time*. Nothing re-scans a workspace that already contains splits.

Add a standing check: a "possible duplicates" item in the existing
`LineupComplianceChecklist` (which already surfaces entry-limit warnings on the
Lineup step and is the natural home). One click to link, one to dismiss as
genuinely different people — with the dismissal recorded, so it does not nag.

- **Effort:** ~half a day; reuses the scorer and the checklist UI wholesale.
- **Risk:** low. Suggestion only; linking stays an explicit user action.
- **Acceptance:** the four clusters above appear as checklist items on
  `Blank Workspace 1`; dismissing one persists.

---

## 2a. Recorded aliases are ignored by the scorer roster

**Severity: P0.** Found 2026-08-15 while verifying the fix for §2.

`packages/core/src/lib/scorerRoster.ts` — `buildScorerRosterLookup` builds its
roster rows from result/recruit/plan names **without** passing them through
`buildAliasResolver`. Measured on `Blank Workspace 1`:

```
Alan Alejan Gonzalez Mujica  ->  Alan Gonzalez Mujica     resolver: MERGED
Camden Mask                  ->  Cam Mask                 resolver: MERGED
Steven Balistreri            ->  Stevie Balistreri        resolver: MERGED
Afonso Campanico             ->  Alfonso Campanico        resolver: MERGED

scorer roster rows for Henderson State University: 47
  Alan Alejan Gonzalez Mujica (1) | Alan Gonzalez Mujica (1)   BOTH PRESENT
  Camden Mask (1)                 | Cam Mask (1)               BOTH PRESENT
  Steven Balistreri (1)           | Stevie Balistreri (1)      BOTH PRESENT
  Afonso Campanico (1)            | Alfonso Campanico (1)      BOTH PRESENT
```

The alias data is correct. The resolver is correct. The consumer ignores both.

### Consequences — measured 2026-08-16, and one of these was wrong

- ~~**Scorer cap.** Four duplicated athletes consume four extra slots, so up to
  four genuine scorers are pushed out of the scoring roster.~~
  **Not observable.** See §2b — `maxIndividualScorersPerTeam` does not change the
  scored total for this workspace at any value from 1 to 999.
- **Entry cap — real, and the numbers above were wrong twice.**

  > **⚠ CORRECTED 2026-08-16.** An earlier revision of this table said the merged
  > counts were 10/10/10. They are **8/9/7**. The two halves *share* individual
  > events — a recruit row remapped onto the meet's own event label is the **same
  > entry**, not an additional one — so the halves cannot simply be added. I
  > propagated the naive sum into an agent brief, and the agent measuring it
  > caught the contradiction against its own data.

  Measured on Henderson State men, projected view, cap 7:

  | Athlete | Half A | Half B | Merged | Over cap? | Newly visible? |
  | ------- | ------ | ------ | ------ | --------- | -------------- |
  | Balistreri | 7 | 3 | **9** | **yes** | yes |
  | Pózvai | 7 | 3 | **8** | **yes** | yes |
  | Fergunson/Ferguson | 7 | 3 | 7 | at cap | no |
  | Gonzalez Mujica | 5 | 3 | 6 | no | no |
  | Mask | 3 | 3 | 5 | no | no |
  | Campanico | 2 | 3 | 5 | no | no |

  **Two genuine NSISC entry-limit violations.** An over-entered swimmer's swims
  can be voided, so this is a competition-rules consequence, not a cosmetic one.
- **Roster display.** 47 rows for what is at most 41 athletes (verified: applying
  a resolver collapses 47 → 41 on HSU men).
- **Team totals do NOT move.** Verified two ways: 1,258 `isScorer` probes across
  both workspaces and both genders returned identical answers with and without a
  resolver, and HSU men scores 1383.83 either way. The merge is a roster-shape
  fix, not a scoring fix — which makes the entry-cap violation the whole story.

### 2c. The live bug is a silent empty, and it is the one this repo fears most

Found 2026-08-16 while fixing the above. There are **two competing alias
mechanisms**, and only one of them is opt-in.

`buildScoringBundle` (`packages/core/src/lib/scoringEngine.ts:95-115`) **already
eagerly rewrites every `r.name` to canonical** when `workspace.athleteAliases` is
non-empty. So on the bundle path the two violations above were already visible,
and the resolver work is idempotent there.

What is actually broken on that path is worse:

```
buildScoringBundle(applyWhatIf: true).allResults
  countSwimmerEntries(…, 'Oliver Pozvai')  ->  8   over cap
  countSwimmerEntries(…, 'Olivér Pózvai')  ->  0   COMPLIANT   <-- silent empty
```

Querying by the **alias** spelling matches zero rows and reports a real 8-entry
athlete as having none. `CLAUDE.md` rule 4 names this exactly:

> *"Absent ≠ empty. A lookup that matches nothing must be distinguishable from a
> real 'no cut achieved'. Silent empties are the top failure mode here."*

It is live today, and any UI that offers both spellings can hit it.

### Two mechanisms, no owner

The eager rewrite and the opt-in resolver do the same job by different means. The
rewrite is invisible at the call site, does **not** apply in `pdf_only` scoring
view, and does not apply to any caller that bypasses `buildScoringBundle` —
`AthleteMeetEntriesPanel.tsx:83` reads raw `workspace.menResults` and is
unprotected. **Someone should decide which is canonical**; having both is how the
silent empty arose.

### The trap in fixing this

`countSwimmerEntries` lives in `swimmerEntryLimits.ts`, **not** in
`scorerRoster.ts`, and keys on the raw name. `TeamRosterPanel` and
`rosterLineupAudit` call it with `row.name`. The moment the roster starts
resolving, `row.name` becomes the *canonical* spelling — so the count would find
7 instead of 10 and report **compliant**.

Fixing the roster without fixing the entry counter does not fix the bug. It
relabels which half is counted and hides the violation more thoroughly. **The two
must ship together.**

### Why this is P0 and not P1

Everything else in this folder is a wrong number the app produced on its own.
This one is a wrong number the app produced **after the user corrected it** —
the link was made, stored, and silently discarded downstream. That is the worst
class of defect in a tool whose premise is that a coach can trust what it shows.

### Proposed fix

`buildScorerRosterLookup` should take an `AthleteAliasResolver` (defaulting to
`IDENTITY_ALIAS_RESOLVER`, as `categorizeBestEvents` and `relayEventsForAthlete`
already do in `athleteHistory.ts` — the convention exists, this function just
does not follow it) and resolve every name before keying a row.

**This changes team totals**, because the scorer cap will select a different 18.
It needs its own round with before/after totals captured and reviewed, not a
bolt-on. **Effort:** ~1 session plus verification.

**Audit the other consumers at the same time.** Grep for callers that key on a
raw athlete name — `countSwimmerEntries`, `aggregateSwimmerMeetPoints`, and the
roster/optimizer paths are the likely candidates. The bug is not that one
function forgot; it is that the resolver is opt-in, so forgetting is the default.

## 2b. A scoring setting the UI exposes has no observable effect

> **✅ DIAGNOSED 2026-08-16 — working as designed, and BOTH hypotheses below were
> wrong.** Pinned by `scripts/test_scoring_settings_effect.mjs` so nobody repeats
> the investigation.
>
> **The real mechanism** is in `mergeScoringSettings` (`scoringDefaults.ts`):
> when `conference` matches NSISC, **seven fields are unconditionally overwritten
> with the preset constants *after* the caller's settings are spread in.** The
> user's edit is discarded before the engine ever sees it. That is deliberate —
> the 18-scorer pool is a competition rule, not a preference, so a coach must not
> be able to dial it to 999 and produce a fantasy total.
>
> **Not** the PDF path: `calculatePoints` does have a branch that copies HyTek
> place points and bypasses every cap, but it reads `SwimmerResult.pdfPoints` —
> the *parsed input* column — not `.points`, which is the engine's own *output*
> and is present on every scored row. **Zero live rows carry `pdfPoints`**, so
> that branch is never taken. My "676 of 920 rows carry points" observation
> conflated the two columns.
>
> **Not** `scorerEligibilityMode: 'roster'` either — the cap is equally inert
> under `points_pool`, and the engine honours it identically in both modes once
> the value actually reaches it.
>
> **The remaining defect is a UI one:** both settings panels still render the
> seven locked controls as editable for an NSISC workspace. A coach can change a
> number, save, and see nothing happen. That is worth fixing — either disable them
> with an explanation, or show the locked value and why.
>
> An NSISC total *does* respond to `scoringPoints`, `relayMultiplier` and
> `aFinalBracketSize`. The settings surface is not globally inert.

**Severity: P1 — needs investigation, not yet a diagnosis.** Found 2026-08-16
while checking a consequence claimed in §2a.

`maxIndividualScorersPerTeam` is editable in both scoring settings UIs
(`ScoringSettingsPanel`, `ScoringSettingsModal`), is 18 in the NSISC preset, and
is described as a meet-wide 18-scorer pool. Measured against the live meet
workspace, sweeping the cap from 1 to 999:

| Cap | HSU men total | roster rows / scorers |
| --- | ------------- | --------------------- |
| 1 | 1383.83 | 47 / 42 |
| 5 | 1383.83 | 47 / 42 |
| 18 | 1383.83 | 47 / 42 |
| 999 | 1383.83 | 47 / 42 |

**A cap of 1 admits 42 scorers and scores identically to a cap of 999.** Also
tested with `scorerEligibilityMode: 'points_pool'` and with
`scorerCapScope: 'event'` — all four combinations return 1383.83.

### What is not yet known

The mechanism is **not isolated**, and it should not be guessed at. Two candidate
explanations, neither confirmed:

1. **By design.** `scorerEligibilityMode: 'roster'` may mean the explicit scorer
   roster decides eligibility and the numeric cap is for other modes — but that
   would not explain the `points_pool` result.
2. **PDF place points.** 676 of 920 result rows carry points parsed from the PDF.
   `calculatePoints` receives `resultsForPdfHint` and may re-merge settings
   internally to use those points directly, bypassing every cap. `usePdfPlacePoints`
   reads `undefined` in stored settings, so if this is it, it is being switched on
   somewhere downstream and is invisible in the workspace record.

If (2) is the answer, a much larger statement follows: **for a meet whose PDF
already carries place points, the entire scoring-settings surface may be inert**,
and the app is displaying the meet's own arithmetic rather than its own. That
would be worth knowing before anyone tunes a preset expecting it to matter.

### Proposed

A focused investigation, not a fix. Instrument `calculatePoints` to report which
scoring path it took for a given call, then answer: does any scoring setting
change the total for this workspace? Start there — the answer reframes several
other findings in this folder.

## 3. Junk events reach the history store

**Severity: P2.** Both workspaces, identical counts.

| Event | Count | Character |
| ----- | ----- | --------- |
| `50 Butterfly` / `50 Backstroke` / `50 Breaststroke` | 63 / 52 / 51 | Real swims, real events — just not contested by NSISC. Correctly excluded from lineups as of `ea8ad61e`. |
| `400 / 800 / 1500 Freestyle` | 26 / 18 / 18 | Real metric events; now correctly fold into 500/1000/1650. |
| `100 Individual Medley` | 22 | Real event, not in this conference's program. |
| `25 Freestyle` / `25 Back` / `25 Fly` / `25 Breast` | 5 / 3 / 3 / 1 | Age-group events in a college swimmer's SwimCloud history. Legitimate to store. |
| **`375 Freestyle`** | **1** | **Not a swimming event.** |

The first four rows are fine — history should keep everything, and the program
gate now decides what is *enterable*. `375 Freestyle` is different: it is a parse
artefact that no source could legitimately produce.

### Proposed fix

`CLAUDE.md` rule 3 says *"Parsers fail loudly. A missing or unparseable row
raises."* A distance of 375 yards is not a sanctioned event at any level. Add a
plausibility gate at the parse boundary (`parseSwimCloudPersonalBests` and the
PDF parsers): distance must be one of the sanctioned set (25/50/100/200/400/500/
800/1000/1500/1650), otherwise the row is rejected **with the raw text surfaced**
so the operator can see what failed rather than discovering a phantom event later.

- **Effort:** ~2 hours.
- **Risk:** low, but check the reject list against a real paste before enforcing
  — a legitimate-but-unusual event that starts raising would be worse than one
  junk row.
- **Acceptance:** importing a paste containing `375 Freestyle` reports one
  rejected row and stores none.

---

## 4. What is already clean

Worth recording so effort is not spent re-checking:

- **0 unparseable times** across 871 history swims in each workspace.
- **0 teams with an unmapped division** in the loaded meet — so finding
  [01#2](01-fabricated-values.md#2-an-unmapped-team-is-still-scored-against-the-d1-table)
  is latent, not active.
- **0 exact token-permutation duplicates** (`Smith, John` vs `John Smith`) — the
  name normaliser is doing its job.
- **`data/cutlines/`** carries 5 archived source PDFs and a manifest. This is the
  model the conversion table should copy.
