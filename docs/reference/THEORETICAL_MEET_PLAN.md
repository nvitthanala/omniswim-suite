# Theoretical meet from crawled teams (plan, 2026-10-04)

Goal: project a meet from teams already crawled with the extension, with no meet PDF. The user has
three crawled teams (412, 58, 48 for 2026-2027). The Matrix demands a loaded meet today because its
standings come from `menResults` and `womenResults` (meet rows). Psych rows are only an overlay.

## Decisions (user, 2026-10-04)
- Seed time: all-time best per event, SCY only (see `SWIMCLOUD_MULTI_TEAM_CRAWL_PLAN.md`, B4).
- Entries follow the scoring caps (conference overrides merged).
- Destination: a NEW workspace each time. Nothing existing is overwritten.
- Relays: built from individual bests, labelled as estimates, never stored as real leg times.

## How it enters the app
The theoretical meet is a workspace whose meet results are the seeded entries ranked by seed time.
That unlocks Standings, Analyze, Team cards and the Manager's what-if tools, with no change to the
scoring engine. `loadedMeet` carries a "Theoretical meet" label so every gate that checks for a
loaded meet opens.

## Phases
- **U1 data layer** (pure, tested): captures to `TheoreticalMeetInput`; seeds to a workspace payload.
- **U1c relays** (after a design check): relay rows from individual bests, labelled estimated.
- **U2 UI**: "Build theoretical meet" dialog (pick crawled teams, scoring, preview, caveats), entry
  points in the Matrix Meet step and the workspace list, sensible empty states.
- **U3 proof**: end-to-end on the three real captured teams; manual checklist; vault and state.

## Caveats the UI must show
- Seeds are all-time bests and can overstate a swimmer who has since slowed.
- Relays are estimates (once built); until then, "relays not included".
- Exhibition swims can still become seeds (known issue, needs a core type field).
- Only SCY meets. Diving is not included.

## Relays from individual bests (design, 2026-10-09)

Decided by the user on 2026-10-04: build relays from individual bests, label them estimates. The
orchestrator resolved two conflicts on 2026-10-09 (below). Code: `theoreticalMeetSeeds.ts` builds the
relay entries, `theoreticalMeetWorkspace.ts` turns them into scored rows.

**Which relays.** The relay program of the NSISC championship, read from the real 2026 results
(`tests/fixtures/nsisc-2026-relay-followups-r1.json`, men; `data/meets.json`, women, same five events):
800 Free, 200 Medley, 400 Medley, 200 Free and 400 Free relays (4x200, 4x50, 4x100, 4x50, 4x100). No
other conference has a relay program on record in the app, so with another scoring preset no relay is
built and the preview says so. No program is guessed. Labels follow the individual rows: `200 Free Relay
SCY`. One relay per team per event (the NSISC scoring cap is 2 per event, so a second relay is out of
scope and stated).

**Legs.** Each leg takes the swimmer's flat-start best in the meet course (SCY) for the leg's stroke and
distance. Only a result counts (`isRankableSwim`: no extracted split, no self-reported time). No course
conversion. Legs are filled in leg order with the Manager's own selector (`suggestBestRelayLegFill`, the
function behind `buildRelaysFromIndividualLineup`): the fastest eligible swimmer who is not already on
this relay. Medley order is back, breast, fly, free. On a free relay leg 1 is the fastest, leg 4 the
fourth fastest; the order changes only who is named leadoff, never the total. This greedy fill is not a
guaranteed minimum total for a medley. It is the Manager's autofill rule, so both agree.

**Flying start.** A relay leg after the first starts in the water, and a flat-start best is slower. The
app has no published figure, so there is none here. The setting is a switch in the dialog, default OFF.
OFF: legs 2 to 4 use the flat-start best, unchanged. ON: the user enters seconds per leg distance (50,
100, 200). A distance with no value gets no adjustment, and the UI says so. The adjustment is subtracted
from legs 2 to 4 only. Leg 1 is a flat start and is never adjusted. The total is the sum of the four leg
times, rounded to hundredths. No default value exists in code.

**Estimate tag.** The relay is always an estimate: no such team ever swam it. Legs use the spec shapes
(`ProjectedRelayLeg`, basis `flat-start-best` for leg 1 and `estimated-from-flat-start` for legs 2 to 4;
real credits can use the other bases later). Stored `relayLegCredits` are not read. The entry is never
written as a real leg time anywhere except the rows of this theoretical workspace, where every relay row
is an estimate by construction (`isEstimatedRelayRow`).

**Entry caps and order.** Relay legs count toward the swimmer's caps (NSISC: 7 in total, any mix, so one
relay costs one entry; `maxRelayEntriesPerSwimmer` from the preset). Relays are chosen FIRST, then the
existing individual selection runs on the capacity that is left. Reason (corrected 2026-10-09): the cap.
Individual selection offers up to 7 events from all-time bests, so individual-first would fill the 7
entries and no relay could be built. It is not that a relay pays more per swimmer: under NSISC a relay
leg pays `relayMultiplier x place points / 4` = 2 x place / 4, which is HALF what an individual swim at
the same place pays. A swimmer on many relays can therefore give up individual events worth more. The
dialog setting "Relays per swimmer: at most N" (`maxRelaysPerSwimmer`) limits that. It is unset by
default, which keeps the fill bound by the entry caps alone. When set, the leg fill skips a swimmer who
is already on N relays (as it skips a swimmer at a cap). The entry cap itself stays total-only. The
preview shows the limit and, for a relay left out, how many swimmers were stopped by it. A swimmer is never twice on one relay. A swimmer at a cap is not
offered a leg (`canAcceptAnotherEntry`, the same function the individual walk uses). A partly filled
relay charges nobody. Relay events run in the program order above. The individual walk starts from each
swimmer's relay counts, so the caps stay true in either order. With relays off nothing changes, byte for
byte. User removals (`excludedEvents`) still work: they name individual events and are applied by the
same walk after the relays.

**Absent is not zero.** A team without four eligible swimmers for a relay gets no relay entry for that
event and a stated reason per missing leg: nobody on the team has a best at that stroke and distance, or
everyone who has one is at the entry cap or already on the relay. No time is made up.

**Scoring path.** Each relay is four rows (one per leg) that share event, team, round, place and team
time, as a HyTek relay does. Teams are ranked by estimated team time per event and gender (ties: 1, 2,
2, 4). Bands: places 1 to the A bracket are `A Final`, the next bracket `B Final`, the rest `C Final`
(scored 0). No `pdfPoints`. The engine then pays `scoringPoints[place] x relayMultiplier` (or
`relayPoints`) per relay, divided across the legs (`halfRateRelaySwimmer`). Relay rows sit after the
individual events in row order.

**Tied relays.** Core relay scoring (`scoreRelaysInEvent`) does not split tied relay points: each tied
relay is paid the full points of the shared place. Individual ties are split. This build does not change
core scoring. The meet names each group of tied estimated relays in its caveats and says each receives the
full place points today. A test pins that behaviour. Changing it needs a user decision.

**Cut tags.** An estimated relay is not judged against a relay cut. Matrix `buildTeamRowCutlineTags` takes
`estimatedRelay` (from `isEstimatedRelayRow`) and returns no relay verdict; the card shows "Estimate, not
judged". That is a state of its own, not absent and not `no_cut`. Leg 1 keeps its own verdict.

**Other readers.** The relay split inspector labels the split column "Estimated (flat-start best)" for a
theoretical meet. The season analytics skip a theoretical meet, so its points and seed times do not reach
the cross-meet chart.

**Dialog.** The switch "Include relays (estimated)" is on by default. The preview lists each relay, its
four swimmers, leg times and the tag, and each relay that could not be built with the reason. The
banner says relays are estimated when the workspace holds relay rows.
