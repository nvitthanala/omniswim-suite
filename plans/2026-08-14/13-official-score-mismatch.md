# 13 — Computed totals disagree with the published official scores

**Severity: P1. Pre-existing.** Found 2026-08-16, by an agent noticing a test
nobody runs. **Diagnosed 2026-08-16.**

`scripts/test_nsisc_team_totals.mjs` compares the engine's computed team totals
against the meet's **official published scores**. It is the closest thing this
repo has to a ground-truth check on scoring.

**It is not registered in `scripts/run-tests.mjs`, so `npm test` has never run
it.** And it fails:

```
OK    Women University of West Florida : 1239.00  official 1239     delta   0.00
FAIL  Women Delta State University     :  936.00  official  916     delta +20.00
OK    Women Ouachita Baptist University:  536.00  official  536     delta   0.00
OK    Women Henderson State University :  476.00  official  476     delta   0.00
OK    Men   Henderson State University : 1056.00  official 1056     delta   0.00
OK    Men   Ouachita Baptist University: 1029.50  official 1029.5   delta   0.00
FAIL  Men   Delta State University     :  874.50  official  875.5   delta  -1.00
```

**Six of eight match exactly. Both failures are Delta State**, and they fail in
opposite directions: women **+20**, men **−1**.

---

## The engine is not the defect

First thing measured, because it decides where to look. `calculatePoints` was
run over the NSISC workspace and its output compared, **row by row and event by
event**, against the `points` already stored on those rows:

| | stored | computed | official |
| --- | --- | --- | --- |
| Women, all four teams | 1239 / 936 / 536 / 476 | **identical** | 1239 / **916** / 536 / 476 |
| Men, all three teams | 1056 / 1029.5 / 874.5 | **identical** | 1056 / 1029.5 / **875.5** |

Net difference between stored and computed, across every Delta State event in
both genders: **0**.

That is not circular. The stored `points` come from
`backend/point_calculator.py` — `backend/parse_meet.py` runs
`pdf_parser.extract → point_calculator.calculate` and persists the scored rows.
The TypeScript engine is a **second, independent implementation**, and it
reproduces the Python one exactly.

**Two independent scoring implementations agree with each other and disagree
with the meet. The defect is upstream of both, in extraction.**

---

## Women +20 — fully explained

The last row of `womenResults`, index 474 of 475:

```json
{ "rank": 1, "name": "Kiera Cloete", "team": "Delta State University",
  "prelimsTime": "NT", "finalsTime": "1:05.16", "roundSwam": "A Final",
  "points": 20, "event": "Event 938 Women 100 Yard Breaststroke",
  "isTimeTrial": false }
```

**936 − 20 = 916 = the official total, exactly.**

It is a time trial that lost its tag. Everything around it says so:

- It sits at the very end of the array, immediately after the time-trial block
  (rows 469–473 are `Event 400/404/500/501 … Time Trial`).
- `prelimsTime: "NT"` — the time-trial signature. Every tagged time trial in
  this workspace has it; no championship final does.
- Cloete already has a real 100 breaststroke row: Event 25, 1:03.53, 2nd, 17
  points. The 1:05.16 is a second, slower swim.
- Its event number, 938, exists in neither the meet program (events 1–42) nor
  the time-trial series (100–102, 200–202, 300, 400, 402–404, 500–501, 503).

The label lost its `Time Trial` suffix and the `isTimeTrial` flag came back
false. Both signals are what every downstream consumer keys on —
`prelimsProjection.ts:73`, `psychProjection.ts:117`, `utils.ts:475` all test
`/\bTIME TRIAL\b/i` against the event string or read `r.isTimeTrial`. With both
gone, the row is an ordinary event containing exactly one swimmer, so she wins
it: **20 points from nothing.**

## Men −1 — partly explained, and the residual is not what it looks like

`menResults` has the mirror-image row at index 444 of 445:

```json
{ "rank": 1, "name": "Jacob Hamblen", "team": "Delta State University",
  "prelimsTime": "NT", "finalsTime": "53.66R", "roundSwam": "A Final",
  "points": 20, "event": "Event 939 Boys 100 Yard Breaststroke",
  "isTimeTrial": false }
```

Same position, same `NT`, same phantom event number, same 20 points, and the
same athlete-already-scored-this-event pattern (Hamblen: Event 26, 54.37, 2nd,
17 points).

Note the gender token: **"Boys"**, in a men's college championship. That is not
incidental — `utils.ts` has a deliberate carve-out for it:

```ts
/** Post-meet championship swims (HyTek Boys/Girls events) — scored like finals, not exhibition TTs. */
function isChampionshipGenderEvent(event: string | undefined): boolean {
  return /\b(Boys?|Girls?)\b/i.test(event);
}
...
if (e.includes('TIME TRIAL') && !isChampionshipGenderEvent(event)) return true;
```

So even had the `Time Trial` suffix survived, this row would still score. That
carve-out is a judgment call someone made deliberately, and **it cannot be
adjudicated without the results PDF** (see the constraint below). It is flagged,
not changed.

Removing the phantom leaves Delta State men at 854.50 against an official
875.50 — a **−21** residual. Two candidate causes were examined and one was
eliminated:

- **Event 13, Men 100 Butterfly — a genuinely dropped row.** 29 rows: 6
  prelims-only, 8 A-finalists (ranks 1–8), 7 B-finalists (ranks 10–16), 8
  C-finalists. **Rank 9 is absent.** A B final seats eight; seven are present.
  The B-final winner's row — 9th place, 9 points — was dropped in extraction.
  Whose it was is unknown, so whether it belongs to Delta State is unknown.
- **Event 39, Men 200 Breaststroke — not a dropped row.** Rank 8 is absent, but
  Mark Eberhard is `F=DQ` in the A final; HyTek vacated the place rather than
  promoting the B-final winner. Correct behaviour, worth nothing.
- **Event 22, Men 500 Freestyle — not a dropped row.** Ranks 11–16 are absent
  and total exactly 21, which is seductive. They are absent because the B final
  drew only two swimmers and HyTek numbered the C final from 17. A red herring;
  recorded so nobody else spends the hour.

**The men's residual is not closed.** It is not a scoring error — see above —
so it is a second extraction defect, of which Event 13 is one confirmed
instance.

---

## Two more extraction defects found while measuring

### `officialTeamScores` is destroyed for any half-point total — ✅ FIXED

The workspace carries the meet's own published scores, and they are wreckage:

```json
"men": {
  "Henderson State University Henderson State University": 1056,
  "Ouachita Baptist University Ouachita Baptist University 1,029.": 50,
  "Delta State University Delta State University 875.": 50
}
```

The two corrupted entries are **exactly the two men's teams whose official
score ends in a half point** — and one of them is Delta State.

pdfplumber splits HyTek's proportionally-spaced totals at the decimal point, so
`1,029.50` arrives as `1,029. 50`. The regex in
`backend/team_rankings_parser.py` was

```python
r'^\s*(\d{1,2})\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s*(?:\t.*)?$'
```

With a lazy `(.+?)`, the leftmost viable split wins — and that is the space
*inside the number*. The school absorbs `1,029.` and the score becomes `50`.

This is the [04 §3](04-architecture-complexity.md) shape again: **the wreckage
is stored under a different key than the clean row**, so no consumer can tell a
corrupted entry from a missing one. Nothing threw. Nothing warned.

Fixed: the fractional part may now be separated from the point by whitespace,
and a parsed school name containing a digit **raises** — that is the signature
of a split landing inside the score, and a wrong official total is worse than
none, because it is compared against computed totals and reads as a scoring
defect. `scripts/test_team_rankings_parser.mjs` covers both forms and the raise;
it is registered, and it was watched failing against the old regex before being
kept.

### A duplicated row

`Event 39 Men 200 Yard Breaststroke` contains Mark Eberhard **twice**, identical
in every field but `id` (`rank: 1`, `F: DQ`). It scores nothing, so no total
moves — but it is the same extraction pass, and a duplicate that *did* score
would move one silently.

---

## Why nobody noticed

The test is not in the `TESTS` manifest. It is one line to add, and adding it
turns `npm test` red until the discrepancy is resolved — which is the correct
outcome, but it should be a deliberate choice rather than a surprise.

Note the parallel with the `console.assert` finding in
[06](06-testing-verification.md): the suite's most valuable checks were the ones
not actually running. Two independent instances of the same failure mode.

## What to do next

1. **Get the results PDF into the repo.** `loadedMeet.pdfFilename` records
   `2026_NSISC_Championships_Final_Results.pdf`, but the file is not committed —
   only cutline sources and a psych-sheet fixture are. Every remaining question
   here (is the "Boys" carve-out right? whose row is Event 13 rank 9?) is
   answerable in five minutes with the PDF and not at all without it. This is
   the single highest-value unblock in the folder.
2. **Then fix the time-trial tagging at the source**, in `backend/pdf_parser.py`
   — where the event header is scanned. Downstream is the wrong layer: three
   separate modules re-derive "is this a time trial" from the label, and all
   three were defeated by one bad label. The parser should refuse to emit a row
   whose event number falls outside the numbering it has already seen, per the
   `CLAUDE.md` rule that parsers fail loudly.
3. **Then register the test.** Once the extraction defects are fixed, either it
   passes or the remaining gap is understood and annotated with its reason.
4. **Do not "fix" it by adjusting the expected values to match the engine.**
   That inverts the test — it would pin whatever the app currently does, which
   is the trap [06 §1](06-testing-verification.md) already flags for the skipped
   `test_nsisc_output.json` fixture. It is now doubly wrong: the engine has been
   measured and is *not* where the error is.

## Related

[06 §1](06-testing-verification.md) records two *other* scoring tests skipped for
a missing fixture. Between them, **the three checks that would most directly
validate scoring are all inactive**: two skipped, one unregistered. All three
are blocked on the same missing artefact — the meet PDF.
