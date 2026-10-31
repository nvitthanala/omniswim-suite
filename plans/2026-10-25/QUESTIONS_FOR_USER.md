# Open questions for the user

Updated 2026-10-31. Each question names the default the build uses now.
Answer by number. Write "keep" to accept the default. Answers go to the
README decision table as new R rows.

## A. AutoBuilder (plans/2026-10-25/D5-AUTOBUILDER.md section 14)

**A1. Robust spread (14.1).** Default: value a swimmer by the slower middle
of their 5 most recent dated SCY swims, with at least 3 swims. A pair with
fewer swims is frozen: never added, never dropped, shown as "not enough
swims". Other option: value those pairs at their best time. That makes the
solver prefer swimmers with no history.
The robust mode (slice A7) is built on the default; an answer changes
only how thin histories are valued. A frozen entry that is already in your lineup
stays, even for an untagged swimmer, without forcing a roster spot. One
exception: an entry with no recorded time at all can still be replaced, in
every mode (see A9).

**A2. One swimmer on both the A and B relays (14.2).** NSISC v5 does not
forbid it. Default: never. No archived NSISC source allows it, and NCAA
5-7-1-g forbids it for timed finals. Allow it?

**A3. The current lineup already breaks a hard rule (14.3).** For example an
8th event under a cap of 7, or (new in A3) too many races in one session
under "respect". Default: return the best legal lineup as
`current_infeasible`, with its point change shown even when negative. Other
option: refuse until the coach fixes the current lineup.

**A4. Diver weight (14.4).** `scoreMeet` counts a swimmer who dives and swims
no relay at 1/3 (`results.ts:1002`). Its comment says only all-diving
swimmers count at 1/3 (`results.ts:980`). The AutoBuilder uses the strict
rule. Which rule is correct for NSISC? Until you answer, an explanation can
say a better event was skipped for "strict_diver_rule": the AutoBuilder's
own cautious count, not a meet rule.

**A5. Legs 2 to 4 without a flying split (14.5).** Default: not built until
the flyover setting (R14) lands. Current relays that use flat starts on
those legs stay candidates. Other option: SwimCloud's method, which uses the
flat-start time and flags it.

**A6. Session schedule for config C (new, A3).** The shipped NSISC session
schedule refuses config C:
- the 1650 free leaves `smallFieldSession` pending (which session swims a
  small field);
- there is no row for the men's 100 IM.

The schedule copies Table C of your plan (`00-USER-PLAN.md` lines 55-76).
Table C has no 100 IM, which suggests NSISC does not swim it at the
championship. Config C comes from SwimCloud's simulator, which does.
Pick one:
- (a) drop the 100 IM from config C when load is on;
- (b) give the day and session of the 100 IM;
- (c) let me download the 2026 NSISC final results PDF (Ouachita Baptist's
  site, sidearm S3) to confirm the order of events.

Also give the session for a 1650 field of 8 or fewer (morning or evening).
Nothing was guessed.

## B. Opponent scoring rosters (R70, D2 section 3.14)

**B1. What an edit does.** Default: an edit pins that swimmer, and the
suggester refills around it. Other option: the first edit saves the whole
roster as coach tags and freezes it.

**B2. When a suggestion refreshes.** Default: recompute whenever the coach
edits their own lineup. Opponent rosters can then shift between two what-if
lineups. Other option: freeze until the coach presses "Recompute" (needs a
new store).

**B3. The field for the other opponents.** Default: every entered swimmer of
the other opponents counts as a scorer. Other option: a second pass against
the first-pass suggestions. It changes the numbers, not the API.

## C. Scoring rules

**C1. A tie at the cap boundary (D2 9.5).** Two teammates tie exactly at the
per-team scorer cap. Today the engine removes one by internal id order. The
team total is right; which swimmer gets the points is arbitrary. Pick a
rule: split the points, keep the earlier seed, keep the swimmer with fewer
events, or leave it arbitrary and hide per-swimmer points for tied pairs.

## D. Data sourcing (P4): fetch approval

Each item needs extra SwimCloud requests. Say yes or no to each.

**D1. LCM swims.** Fetch long-course swims so the LCM to SCY conversion
(R58, R63) has inputs.

**D2. A wider date window** than the current one.

**D3. Roster season.** Fetch each team's roster for the season, so the
eligibility roster and class years can fill.

**D4. Relay splits.** Fetch the team simulator relay splits
(`/api/teams/{id}/simulator/`) for flying-start legs.

**D5. Class year source.** No recon shows which SwimCloud page carries a
class year. May I look for it (one roster page, read-only)?

## E. Other open items

**E1. Class year codes.** The new engine uses FR/SO/JR/SR/GR. The legacy
engine uses FR/SO/JR/SR/HS (HS = recruit). Which set wins, and where do
recruits go?

**E2. Dark-mode good and bad colors.** Light mode and dark "warn" are
answered (R46, R57). The Material 800 good and bad shades fail 4.5:1
contrast on the dark background. Pick shades, or approve the 300 shades
(lighter, pass contrast).

**E3. Backup before a database upgrade (D3 5.7).** Not built. A P1 build
cannot open a v2 database. Build the "export a backup" prompt now, or
later?

**E4. Live UI check.** The meet planner and the page schedule editor pass
their tests but have not been checked in your Chrome. May I open SwimCloud's
simulator in a new tab and check them, read-only?

## A (continued)

**A7. Session load for your swimmers the AutoBuilder cannot move (new,
A5).** Under "respect", the AutoBuilder keeps every swimmer it may move
within the races-per-session limit. Some of your swimmers stay fixed:
non-members of the scoring roster, non-scorer roles, and swimmers on a
relay the AutoBuilder cannot rebuild. A proposal can still change their
race count, for example by moving one of them up into a final. Default:
allow it and show a warning. Other option: refuse any proposal that puts
a fixed swimmer of yours over the limit (opponents always get only a
warning).

**A8. Goal seek with the "prefer" load setting (new, A6).** Goal seek finds
the fewest changes that reach a target score. Under "prefer", extra races
in one session cost penalty points. Should the target count the penalty
(reach the target after the penalty) or ignore it (raw points only)?
Default today: the AutoBuilder refuses goal seek with "prefer" and says so.

**A9. Entries with no recorded time (new, A7).** If a swimmer is entered in
an event where they have no usable time, the AutoBuilder cannot value that
entry, so every mode may replace it. Default: allow it, and list the removal
with reason "replaced". Other option: always keep such entries as entered.

**A10. What Accept writes when you accept a roster swap (new, A9).** With
the opt-in "propose swaps" setting, the AutoBuilder may suggest taking a
tagged scorer off the scoring roster. When you accept, should the app:
- (a) delete that swimmer's scorer tag, so the next run may add them back
  as an untagged swimmer, or
- (b) tag them "non-scorer", which keeps them off until you change it?
Default until you answer: U1 asks at Accept time, with (b) preselected.

## F. Dashboard (phase P7, plans/2026-10-25/D6-DASHBOARD.md)

**F1. Rival default.** If you pick no rival, which team should the score
chart highlight? Default: the team closest to yours on final points; on a
tie, the team above yours.

**F2. Restoring a snapshot.** Should restoring a saved snapshot write its
lineup back into SwimCloud's simulator? Default: no. Snapshots are for
viewing and comparing only, because the extension writes simulator
settings, not entries (D4).

**F3. Chart library.** Recharts adds about 0.9 MB of JavaScript that loads
on every simulator page view in the docked panel. Default: a lighter custom
SVG chart with the same lines and both themes. Choose Recharts instead?

## G. AutoBuilder panel (U1-b)

**G1. What Accept does with the lineup.** The extension can write SwimCloud
simulator settings, but not its entries (D4). Default: Accept saves your
scorer tags and stores the proposed lineup in the extension, then lists each
entry change ("add X to the 200 free") for you to make in SwimCloud. Other
option: build entry writing into the simulator (new D4 work, with read-back
checks like the settings write).

## H. Snapshots and undo (U-c, added 2026-10-31)

**F4. Reports for a saved lineup.** A saved lineup stores entries, tags and
seed facts, but no results, so it opens no report, chart or comparison.
Only a snapshot does. Default: keep it that way, and save a snapshot to
report on a lineup. Other option: re-score a saved lineup against its meet
when you open it (new work; the meet data may have changed since).

**G2. Undo for AutoBuilder Accept.** Undo covers "Save snapshot" and "Save
lineup". Accept is not undoable, because it can delete scorer tags and the
storage layer cannot yet check that a deleted tag is still absent. Default:
build that check later, then make Accept undoable. Other option: never undo
Accept; you fix tags by hand.
