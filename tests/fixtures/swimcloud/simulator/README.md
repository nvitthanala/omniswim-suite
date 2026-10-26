# SwimCloud meet simulator parity fixtures

Captured 2026-10-26 (03:32–03:38 UTC) from
`https://www.swimcloud.com/meetsimulator/`, signed out, in the user's Chrome
through Claude in Chrome. Recon phase P0; findings are in
`plans/2026-10-25/02-SIMULATOR-RECON.md`. Simulator bundle:
`media/webpack/simulator/index.1792676876.js`.

Men, SCY, season 2025-26 (`2025-09-01`..`2026-08-31`), "Fastest" times,
"Aggregate" relays. Teams: Henderson State (58), Delta State (48), Ouachita
Baptist (412), the 2026 New South Intercollegiate Swim Conference (NSISC)
men's field.

## Files

| File | What it holds |
| --- | --- |
| `team-58.json`, `team-48.json`, `team-412.json` | One `GET /api/teams/{id}/simulator/` response per team, sanitized. Rows are `[eventstroke, eventdistance, eventcourse, eventtime, pointvalue, flystart]`. |
| `config-A.json` | Dual meet 58 v 48, page defaults (16 Event Order: College points 9-4-3-2-1 / 11-4-2, 3 scorers per team, 3 per athlete, 3 per team). SwimCloud total 58: 186, 48: 102. |
| `config-B.json` | 58 + 48 + 412, page defaults. Totals 58: 138, 412: 92, 48: 70. |
| `config-C.json` | B with 16 Place Scoring, 4 scorers per team, individual 4 per team. Totals 58: 849, 412: 777, 48: 575. |
| `config-D.json` | C with 2 scorers per team. Exercises the cap: an over-cap entry earns 0 and keeps its place. Totals 58: 544, 412: 544, 48: 483. |

Diving rows carry `eventcourse` `"6"` or `""`. The page keeps each diver's
highest score across both codes for an event (in `config-A.json`, T48-S03
3 m scores 451.28 from the `""` row, not 292.20 from the `"6"` row).

A config file holds the page's settings (Redux store values), the entries
the page chose per event as `[teamId, swimmer sid or relay:<name>,
eventtime, points, relay legs]`, and the page's `totalScores`. `points:
null` means the entry placed beyond the point table.

## Sanitizing

Swimmer names, SwimCloud swimmer ids, swim ids, photos, profile URLs and
locations are removed. Each swimmer is `T<teamId>-S<nn>`, numbered by
ascending SwimCloud id within the team, the same across all files. Team
names and ids are kept. Times are SwimCloud's published results.

## Checked

Each file was moved out of the page in 1,000-character chunks and verified
against a checksum computed in the page (length and djb2). An offline
re-score with SwimCloud's rule (sort by time, diving by score descending;
points by index in the full list; per-team cap per event, over-cap entries
0 and keep their index; no tie splitting) reproduced every entry's points
and every team total in A–D.

These are a parity reference for SwimCloud's rule only. NSISC scoring
differs (R41: non-scorers leave the places); do not use these files as
NSISC goldens.
