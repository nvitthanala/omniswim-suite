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

**Severity: P1.** Measured in `Blank Workspace 1`.

181 distinct athlete-name strings. **6 aliases recorded.** Four unresolved
same-surname/same-initial clusters:

| Spelling A | Spelling B | Likely cause |
| ---------- | ---------- | ------------ |
| `Alan Alejan Gonzalez Mujica` | `Alan Gonzalez Mujica` | long-form vs short-form (the known round-3 case) |
| `Camden Mask` | `Cam Mask` | nickname |
| `Steven Balistreri` | `Stevie Balistreri` | nickname |
| `Afonso Campanico` | `Alfonso Campanico` | **spelling difference between sources** |

The first three are the documented round-3 pattern that
`ROSTER_ALIAS_DECLUTTER_HANDOFF.md` and the `suggestAliasCandidates` work
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
