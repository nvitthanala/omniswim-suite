# 2026-10-25: Chrome extension redesign

The project pivots from a standalone suite to a Chrome extension that upgrades
the SwimCloud meet simulator, plus a dashboard inside the extension.

| File | What it is |
| --- | --- |
| `00-USER-PLAN.md` | The user's handwritten plan, verbatim. The embedded Table B image is extracted to `assets/table-b-altitude.png`; nothing else changed. |
| `01-REDESIGN-PLAN.md` | The detailed design: surfaces, architecture, feature specs, phases, delegation, risks, open questions. |
| `02-SIMULATOR-RECON.md` | Phase P0 checklist for studying the live simulator, and its findings. |
| `03-REPO-REORG.md` | The active-versus-legacy move map. |
| `docs/reference/REDESIGN_2026-10-25_STATE.json` | Progress record. Read it before resuming. |

## Decisions (user, 2026-10-25)

| ID | Question | Answer |
| --- | --- | --- |
| R1 | How to study the simulator | Claude researches it live through Claude in Chrome: "run your own research, i trust it". Start URL `https://www.swimcloud.com/meetsimulator/?event=1\|50\|Y\|1&teams=`. |
| R2 | Where the dashboard lives | "either within the extension, or have the extension be able to construct the dashboard into the meet simulator page". Plan: one dashboard app, two hosts. |
| R3 | The unmerged improvement-plan branch | Merge it first, then reorganize. PR #7. |
| R4 | NSISC total entry cap | 8 ("its nsisc, maximum of 8 cap"). The earlier 7 was the user's own incorrect information. Do not hardcode; every limit is configurable for any conference. Superseded by R73 (2026-10-27): the cap is 7. |
| R5 | AutoBuilder "cushion" | All four modes: max own total, margin over a rival, robust to slow swims, goal seek. |
| R6 | Default session load | 2 races per session, relays included. Editable per meet. |
| R7 | Wider date window | "try and see if you can modify the system that actually interacts and retrieves said data when setting the window". Widen the simulator's own data request. Low usefulness, but useful for a best-case view. Extra per-swimmer fetches were **not** approved; they need recon and an explicit yes first. |
| R8 | Audience | Personal unpacked install first. Share with other coaches later; plan for it now. |
| R9 | Diver weight | NSISC: each diver counts as 1/3 of a roster spot. |
| R10 | Table D and conversions | Use SwimCloud's own converted times first. Table D is the fallback only, for an LCM swim SwimCloud shows no conversion for. |
| R11 | "Close to a cut" | Within 1.0%, and always show the time gap. A swimmer with their division's B cut is tagged and shows the gap to the A cut. Thresholds are settings. |
| R12 | What carries over from the suite | Saved lineups and snapshots; reports and entry export. Everything else moves to `legacy/`. |
| R13 | Codex | Full fresh quota available (user, 2026-10-25). Update `PROVIDER_ROUTING.json`. |
| R14 | Flyover allowance | A number the user sets (x.xx seconds). No default. |
| R15 | NSISC scoring | SwimCloud already holds the NSISC scoring table: 16-place scoring. No limit on how many swimmers from one team score in an event. Only scoring-team swimmers score, and a team may enter as many scoring-team swimmers in one event as the entry limits allow. |
| R16 | Event order | The NSISC order (Table C) is the default, but every meet's order is customizable, and editable on the meet simulator page too, not only in the dashboard. |
| R17 | Sessions and load | A session has no meet-imposed race limit. The load limit protects swimmers' performance; it is a coach preference. Prelims usually swim in the morning and finals later the same day. Timed-final events (usually the distance events) swim once. Each event's format (prelims/finals or timed final) is a setting. |
| R18 | OpenCode | Add OpenCode to the provider pool for this work ("more resources to knock out the work"). This is the user approval the routing file's OpenCode `availableNote` asked for. |
| R19 | Chrome | The user will start a new session with Claude in Chrome running. The plan carries a fallback for getting the extension connected. |
| R20 | Distance events (Q-D3) | The 1000 and 1650 are **timed finals, split**: slower heats swim in the morning, the fastest heat swims in the evening. Each swimmer swims once, and the event scores as a timed final. The fastest-heat size is set by R35. |
| R21 | Scorers (Q-D1) | Scorers are picked automatically. The coach's tags override the automatic pick. |
| R22 | Diving and load (Q-D5) | Diving does not count toward the races-per-session preference. |
| R23 | Table D rounding (Q-D4) | Truncate. |
| R24 | Scoring-team size (Q-D1) | 18. |
| R25 | Scoring relays (Q-D1) | 2 per team per relay event (the A and B relays). |
| R26 | A final (Q-D1) | 8 swimmers. |
| R27 | Diving scorer cap (Q-D1) | Same rule as swimming: no limit on how many divers from one team score in an event. |
| R28 | Relay swimmers and the scoring team | A relay swimmer takes a full scoring-team spot, not half of one. This answers a question framed around scoring-team spots. It does **not** answer the code's `halfRateRelaySwimmer` flag, which sets each relay leg's share of the relay's points (1/4). R34 answers the flag. |
| R29 | Table D distance rows (Q-D2) | Do not use the 0.892 rows for 400→500, 800→1000 and 1500→1650. Use SwimCloud's own conversion first. Where SwimCloud has none, source the factors from SwimSwam's conversion tool (`https://swimswam.com/swimming-times-conversion-tool/`), archived with a manifest entry. The user's check value: a 4:00.00 400 m LCM is about 4:34.32 for a 500 yd (240.00 × 1.143). 1.143 is Table A's SCM factor, so the check value is a sanity range, not a conversion value. |
| R30 | SwimCloud plan (Q4) | The user has a Free SwimCloud account. Recon records what the simulator shows on Free. |
| R31 | Extra fetches (Q6) | Decide after recon. |
| R32 | NSISC documents (Q3) | Search the web for the New South ISC rule documents in the next session. |
| R33 | Housekeeping | Keep the untracked `omniswim-suite/data/` folder as it is (open item M3). Keep all git worktrees. |
| R34 | Relay share (Q-D6) | Each relay swimmer gets 1/4 of the relay's points in their own point total (`halfRateRelaySwimmer: true`, the legacy value). |
| R35 | Fast heat (Q-D7) | User: "usually, its 8, if the entries for the event are less than 16, itll be the bottom x number of swimmers in the entries, the fast heat in the evening will be a full heat." The top 8 seeds swim the evening heat; the rest swim in the morning. Editable per meet. With 8 or fewer entries, the meet decides: a per-meet setting with no default. |
| R36 | Relay format (Q-D8) | Every relay is a timed final in the evening session. |
| R37 | Relay legs | A relay scores only if all four legs are on the scoring team. |
| R38 | Auto scorers: individual | A swimmer who made an A or B final is marked as a scorer. |
| R39 | Auto scorers: relays | Swimming on a relay marks the swimmer as a scorer. |
| R40 | Auto scorers: distance | A swim in any heat of a split timed final marks a scorer. User: "you can have non scorers in either. the 2026 meet had non scorers in the fast heat and scorers in the fast heat. its mildly complicated but the scoring roster has precedent over placement". |
| R41 | Non-scorers and places | Only scoring-team swimmers are placed for points. A non-scorer is removed from the places, and the scorers behind move up, as with an exhibition swimmer. Example: a non-scorer wins the 100 Free; the 2nd finisher, a scorer, earns 1st-place points. The same rule applies to relays. The legacy scorer differs: a non-scorer keeps the place and earns 0. |
| R42 | Relays per team | Do not hardcode the scoring relay limit; some conferences allow more than 2. NSISC has no non-scoring relays: a team enters only relays that score. For NSISC a 3rd relay is an entry violation. |
| R43 | Finals placement | In NSISC, the A and B finals hold scorers only. Non-scorers never swim an A or B final. |
| R44 | C final | The 8 fastest non-scorers from prelims swim a C final in the evening. The other non-scorers swim prelims only. |

## Decisions (user, 2026-10-26)

Asked after P1. The state file `docs/reference/REDESIGN_2026-10-25_STATE.json` (`userAnswers`) holds the same answers.

| ID | Question | Answer |
| --- | --- | --- |
| R45 | NSISC points (Q-D1 rest) | Individual and diving: 20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1. Relays: double (40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2). Ties split. User: "yes, its just like that, swimcloud already has a scoring preset that matches (16 place scoring)". |
| R46 | Status colors | Material 800 shades: good `#2E7D32`, warn `#EF6C00`, bad `#C62828`. Orange fails text contrast (3.1:1 on white, 2.95:1 on `#FAFAFA`), so the user chose: warn is a fill only, a badge or chip background with dark text (about 6.8:1). It is never a text or thin-icon color. Good and bad pass as text (5.1:1 and 5.6:1). |
| R47 | Extra SwimCloud requests (Q6) | Only on a user click. One request at a time, no background fetches, stop on any Cloudflare challenge. |
| R48 | Distance conversions (Q-D2) | Archive SwimSwam's conversion factors for 400→500, 800→1000 and 1500→1650 once, with a manifest entry. Finding (2026-10-26): the SwimSwam page publishes no factors. It converts on its server and credits Colorado Timing's conversion factors. Nothing was archived; open question `Q-D2-swimswam` in the state file. |
| R49 | Date window (S2) | User: "i want the date range to be applied so that you can search through an athletes history in the selected event and project the performance against the field in the simulator. the issue with the date range is that it opens up people who had previously swam on the team but may not be on the current seasons roster. thats what the scope of the expanded range was for, to pull historical swims from athletes who are on the current seasons roster. this can also be transitive and applied for future recruits". Swimmer 1130590 transferred into Henderson State and is a senior; their 2022-23 swims were at another school. |
| R50 | History loading | One click per roster: "Load history" fetches each current-roster swimmer's history in turn, with progress, cached, and stops on any Cloudflare challenge. |
| R51 | Class year | User: "allow an user-overridden class tag, automatically source it from swimcloud but allow the user to select and change it if they wish." |
| R52 | Recruits | Added by SwimCloud swimmer link or ID. Adding one reruns the optimizer and shows the new lineup and point change. Nothing changes until the user accepts. |
| R53 | Empty rosters (P4) | Store a roster with no members as verified-empty, with its fetch time and source, apart from "not loaded". |
| R54 | Draft meets (P3) | A meet with no teams saves as a draft. Scoring and the optimizer refuse a draft. |
| R55 | Overlay bundle | Switch the overlay's validation to `zod/mini`. |
| R56 | Panel widths (Q16) | Claude may resize the user's window to measure. The window stayed maximized, so the harness checks the panel geometry instead (D3 §13). |
| R57 | Dark status colors | Carry the light warn pair (`#EF6C00` fill, black text) into dark mode. Good and bad stay system colors in dark: the 800 shades fail 4.5:1 on a dark background. |
| R58 | LCM to SCY conversions (Q-D2-swimswam) | Disregard Table D for every event. User: "completely disregard table d, its incorrect." Record SwimSwam converter outputs per event instead, labeled tool-derived, with an "est." badge. SwimCloud's own conversion still comes first (R10). Captures and the fitted model: `data/conversions/swimswam/`. This replaces R29's SwimSwam plan and Table D's role in R10. It is a user-approved exception to the CLAUDE.md data-provenance rule against estimates: the values are inferred from tool outputs and labeled as such. |
| R59 | Conversion precision | User: "you can round, we dont need precision beyond final resultant times to hundreths of seconds." The R29 check value 4:00.00 → about 4:34 is SCM to SCY. LCM to SCY gives 4:28.90. |
| R60 | Conversion sources | Convert to SCY from each source course: SCM uses the NCAA-archived factors (Table A); LCM uses R58. Convert individual swims and relay splits. The 800 free relay's full-relay conversion is not needed ("most times its a moot point"). |
| R61 | Cut tags from estimates | An estimated (converted) time may earn an "estimated cut achieved" tag. When the swimmer swims the cut, the normal cut tag replaces it. This replaces the earlier rule that estimated times never tag. |
| R62 | Relay split conversion | Yes: convert a relay split with the individual conversion for its stroke and distance. User on the flyover (R14): "the flyover/relay exchange modifier is to subtract a little bit of time due to the momentum gained and reaction on the exchange of the entering swimmer". |
| R63 | Provenance exception | Yes: the R58 tool-derived conversions are a recorded exception to the CLAUDE.md data-provenance rule against estimates. Added to CLAUDE.md. |
| R64 | Per-event scorer cap (2026-10-27) | A per-event scorer cap is a preset setting, never assumed. User: "in some conferences/meets you can have as many scorers as you want in each event as long as you are meeting the limitation for the scoring roster and individual event limits." That is the `'unlimited'` value (NSISC, R15). The removal rule of 0db42160 applies only to a preset that sets a number. |
| R65 | Scorers before finals (Q-roster-untagged) | Option (c): the coach tags the scoring team first. Until then the meet is not scored. The AutoBuilder later shows possible swaps: moving a scorer between events, or putting one swimmer on the scoring team instead of another. |
| R66 | Read and write the simulator page (Q-P3-ui-target) | Yes. The extension reads and writes SwimCloud's simulator settings. When a rule changes on the page, the extension sees it and acts on it. User: "the original intention was for the extension to add these features as much as possible onto the swimcloud meet simulator page, not house absolutely everything within a docked overlay". |
| R67 | Relays over the scoring limit (Q-relay-overcap) | A relay entered beyond the scoring-relay limit is tagged exhibition. User: "we can add a field where we can limit the 'scoring' number of relays". SwimCloud's entry-limits tab allows more relays but marks them all scoring. User, 2026-10-27: "the relays that are entered that dont score can be tagged as exhibition". |
| R68 | Swim history and relay splits (Q-history-depth) | Look for an endpoint with every swim, and pull the best swims from it (like the athlete Times page). Also find where SwimCloud tracks relay splits; the Times tab does not show them. Example: swimmer 1472365, flat-start 50 free 19.42, fastest 50 free relay split 19.06 (https://www.swimcloud.com/results/357106/swimmer/1472365/). |
| R69 | Real and estimated cuts together (Q-R61-weaker-real) | Show both tags. |
| R70 | Opponent scoring rosters (Q-core-b-opponents) | Option (c): build a best-fit scoring roster for each opponent the coach has not tagged. The user can change it. User: "build a best fit roster for the opponents, allow it to be modifyable by the user." |
| R71 | Relays and the scoring roster (Q-core-b-relay-marks) | Swimming a relay does not add an untagged swimmer to the scoring team: only the coach's tags count before finals. User: "relays that score must be made up of swimmers that are on the scoring roster in the nsisc. exhibition relays dont really exist in the nsisc". Outside NSISC the user assumes a relay that may not score is made up only of non-scoring-roster swimmers. That is an assumption: a search of the 2025-27 NCAA rule book (R72) found no such rule. |
| R72 | NCAA rule book, 2025-26 and 2026-27 (read 2026-10-27, not archived) | Read from the PDF linked on the NCAA playing-rules page. Rule 7-10-1: exhibition swims are not scored, and everyone else scores "with the exhibition swimmers removed from consideration". Rule 5-5-1: a coach designates an exhibition (nonscoring) competitor; in a dual meet only by consent of all head coaches, in an invitational or conference meet only if published in advance; an exhibition performance does not count toward a team's entries per event or a swimmer's events per meet. Rule 5-2-1-a: dual-meet entry limits by lane count. Rule 5-7-1-g: in a timed-final relay, a swimmer may swim on only one of the team's relays. A text search of the rule book (exhibition, relay team, relay entries, scoring) found no rule that ties relay members to a scoring roster. |
| R73 | NSISC total entry cap (corrects R4) | 7 total events per swimmer, individuals and relays together. User, 2026-10-27: "the nsisc is actually capped at 7 total events across individuals and relays. apologies for the incorrect knowledge. 7 was the correct one this whole time." R4's 8 was wrong. The legacy value of 7 (`scoringDefaults.ts:58`, D2 F1) was right. |
| R74 | Exhibition swims and entry limits | An exhibition swim does not count toward the NSISC total of 7 (R73). User, 2026-10-27: "exhibition swim does not count towards 8 event total" (said of the total cap, which R73 corrects to 7). NCAA Rule 5-5-1 (R72) says the same for NCAA entry limits. Superseded by R75 (2026-10-27): entry limits apply to every swimmer. |
| R75 | Entry limits apply to every group (corrects R74) | Entry limits (per-swimmer individual, relay and total) count every entry, whether the swimmer is a scorer, a non-scorer or exhibition. The scoring roster only decides who scores and who may swim a scoring relay. User, 2026-10-27: "swimmers who are marked as non scorers still have event limits, they just cant swim scoring relays. for entries sake, entry limits are still present regardless of what group you are in." This differs from NCAA Rule 5-5-1 (R72), which exempts exhibition performances; the user's rule applies to NSISC. |
| R76 | A relay with an exhibition leg | The whole relay is exhibition. User, 2026-10-27, answering "a relay with one exhibition-tagged leg is wholly exhibition": "yes". |
| R77 | Untagged relay leg when legs need not be scorers | When `scorers.relayLegsMustBeScorers` is false, a relay with an untagged leg still scores, and the engine warns. User, 2026-10-27: "sure but also throw a warning for that". |
| R78 | Tagged swimmer with no entry | A tagged swimmer with no entry in the meet takes a full scoring-roster spot, and the engine warns. User, 2026-10-27: "yes but also throw a warning for that." |
| R79 | sim-bridge size cap | 10,000 bytes, raised from 5,000 so the simulator settings writer (D4) fits. User, 2026-10-27: "make the cap 10kb, should be more than enough". |
| R80 | Applying a preset to the simulator (D4 question 1) | Picking a saved preset only previews it. The extension writes the supported settings to the SwimCloud page only when the user clicks a separate Apply. User, 2026-10-27, chose "Separate Apply click". |
| R81 | In-page panel default (D4 question 2) | The OmniSwim panel beside the simulator results starts open. User, 2026-10-27, chose "Start open". |

NSISC is the New South Intercollegiate Swim Conference. The repo's meet data
labels its meet "New South Championships". It is not the Northern Sun
conference (NSIC). An early research pass on 2026-10-25 confused the two;
nothing from that Northern Sun material is used here.

## Verified sources for the user's tables

- **Table A** (SCM to SCY) matches the NCAA Division II 2026-27 qualifying
  standards PDF (`https://ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d2/2026-27D2WSW_QualStandards.pdf`,
  which cites the 2026-27 Rules Book, Appendix A-2), and
  `NCAA_SCM_CONVERSION_TABLES` in `packages/core/src/constants.ts`.
- **Table B** (altitude) matches the same PDF and
  `NCAA_ALTITUDE_ADJUSTMENT_TABLE` in `constants.ts`. The image shows ".0"
  for 100 yards at 3,000 to 4,250 ft; the PDF and the code both read 0.
- **Table C** (NSISC event order): no published source archived yet. Ships as
  a `user-stated` session preset.
- **Table D** (LCM to SCY with turn adjustments): disregarded for every event
  (R58). The user called it incorrect. Its distance rows convert a 4:00.00
  400 m to 3:28.37 for the 500. The LCM fallback is now the SwimSwam capture
  in `data/conversions/swimswam/`.
