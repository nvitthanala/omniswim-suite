# 03 — Where the model is thinner than the UI implies

Not bugs. Places where the app presents a confident answer to a question it is
not yet equipped to answer well.

---

## 1. Relays are ranked by nothing

**Severity: P1.** `packages/core/src/lib/athleteHistory.ts` —
`categorizeBestEvents`

Individual events now rank by quality against the published standard
(`350a42a7`). Relays do not rank at all:

```ts
const relayList = relayEvents.slice(0, relayCap);
```

`relayEvents` comes from `relayEventsForAthlete`, which returns the relays an
athlete *already swam in the loaded meet*, in map-iteration order. The `.slice()`
then keeps the first N arbitrarily.

### Why it matters

Under NSISC's 7-event total cap, relay entries compete with individual entries
for the same slots (`maxTotalEntriesPerSwimmer: 7`, per-type caps 999). So the
cap arbitrates between a ranked list and an unranked one. An athlete at the cap
may keep an arbitrary relay over a quality-ranked individual event.

Relays are also where the points are: a relay typically scores double an
individual event, so getting this wrong is more expensive per slot than anything
in the individual ranking.

### Why it is hard

A relay's value is not a property of one athlete. Whether Swimmer X should be on
the 400 Medley Relay depends on who else is available for the other three legs
and what they would otherwise be doing. That is an assignment problem, not a
sort. `relayBuilder.ts` and `rankRelayLegSwaps` in `crossCourseArbitrage.ts`
already do real work here — the gap is that the *profile* does not consume it.

### Proposed direction (needs a decision)

- **Option A — leg-quality proxy.** Rank an athlete's relay candidacy by the
  quality of their corresponding individual leg (100 Free time → 400 Free Relay
  candidacy), reusing the ratio machinery from today's fix. Cheap, obviously
  better than arbitrary, still not a true assignment solution.
- **Option B — defer to the relay optimiser.** Do not rank relays in the profile
  at all; make the cap arbitration ask `rankRelayLegSwaps` for the marginal value
  of each relay slot. Correct, considerably more work.
- **Option C — surface the ambiguity.** Keep the cap from silently choosing:
  when an athlete is at the cap with both relay and individual candidates, flag
  it in the compliance checklist for the coach to resolve.

**Recommendation:** C then A. The checklist already exists and already reports
over-cap athletes; making it say *which* choice was arbitrary is a small change
that converts a silent decision into a visible one.

---

## 2. Diving is excluded everywhere, silently

**Severity: P1 (or "correct, undocumented" — needs your call).**

`canonicalMeetEventLabel` (added today) returns `null` for diving, so diving
never enters the meet program, never appears in a profile, and cannot be
proposed. `cutlineUtils.ts` is explicit that this is deliberate for *cut*
comparison — `not_a_timed_event`, *"scored in points, against a dive-count-specific
total. Comparing it to a swim standard is a category error."*

That reasoning is right for cutlines. It does not obviously extend to lineups:
the loaded meet **does** contest `Event 9 Men 1 mtr Diving` and
`Event 29 Men 3 mtr Diving`, and those events score into the team total.

### The observable consequence

Before today's arbitrage fix, the panel emitted
`Gabriel Palomino: 1 mtr Diving over 3 mtr Diving (+30.7)` — a nonsense card
built on the fabricated-points heuristic. That is gone. But so is any ability to
reason about divers at all.

### Answered from data, 2026-08-16 — moot for HSU, not for everyone

Measured against the loaded NSISC meet:

| Team | Divers | Diving rows |
| ---- | ------ | ----------- |
| Ouachita Baptist | 5 | — |
| Delta State | 4 | — |
| University of West Florida | 4 | — |
| **Henderson State** | **0** | **0** |

25 diving result rows carrying **360 points**, out of 6,147 points across the meet.
**Henderson State fields no divers at all**, so excluding diving from the roster
optimiser costs HSU nothing today. The open question is closed for the current
user.

Two things that follow, and neither needs a decision now:

1. **Rival totals already include diving.** Those 360 points come from the parsed
   PDF and land in the standings normally. Nothing is under-counted in the
   scoreboard — the exclusion only affects *optimising a team you own*.
2. **The exclusion becomes real the moment HSU recruits a diver**, or the moment
   anyone at Delta State, OBU or UWF uses this tool — all three field divers, and
   for them the "optimised" total would be systematically missing a component
   worth up to ~120 points.

So: no work needed, but the assumption is now written down with the number that
makes it safe, rather than being an unexamined silence.

---

## 3. Time trials score nothing but can still earn a cut

**Severity: Open question.** `meetProgramEvents` (added today) skips
`r.isTimeTrial`.

Measured in the loaded meet: **7 men's and 6 women's time-trial events** are
excluded, e.g. `Event 300 Men 50 Yard Freestyle Time Trial`,
`Event 101 Men 200 Yard Breaststroke Time Trial`.

Excluding them from the *program* is right for the question I was answering:
"which events can this athlete be entered in to score points?" A time trial
awards none.

But a time trial is a real, officiated swim, and in NCAA practice a time trial
swim **can** achieve a qualifying standard. So for the *cutline* question the
same rows matter. The suite currently treats "program" as one concept serving
both questions.

### Answered from data, 2026-08-16 — no change needed

The hypothesis was right, and it is now measured rather than believed. The
cut-tagging path reads result and history rows directly; it never consults
`meetProgramEvents`. So excluding time trials from the lineup program did not
touch cut tagging.

Measured over the 18 time-trial rows in the loaded meet, via
`buildCutlineTagForTeam`:

| Result state | Count |
| ------------ | ----- |
| `tagged` (a real cut earned) | **4** |
| `no_cut` | 14 |

And a control — the identical time submitted under the event label with the
`Time Trial` suffix stripped — returns the **same state** in every case. The
suffix does not gate the verdict.

So a time trial that achieves a standard is already tagged as achieving it,
which is the correct behaviour, and the two concepts are already separate in the
code even though they were not separate in my head. **No `scoringProgram` /
`officiatedProgram` split is needed.**

Worth keeping in mind for anyone who later "tidies up" by routing cut tagging
through `meetProgramEvents`: doing so would silently drop four earned cuts.

---

## 4. The projection has no uncertainty

**Severity: P2, but the highest-leverage product idea here.**

Everything the suite projects is a point estimate. `1277.0`. `+5.4 pts`. A coach
reads that as more certain than it is: it assumes every athlete swims their
season best, on the day, in every event they are entered in.

`calculateProjectedTime` (`utils.ts:302`) already models improvement over a
career with a `overallDropPercent = -1.0` default — so the concept of "times
move" exists, applied only to class-year projection.

### The idea

Give the headline total a band, not a number. The inputs already exist in
`athleteHistory`: most athletes have several swims per event across a season, so
their actual within-season spread is measurable — no model needed, just the
observed distribution of their own times.

Render `1277.0` as `1263–1291` (or `1277 ± 14`), driven by each athlete's own
historical variance, with the point estimate still shown.

- **Why it is the best product idea in this folder:** it changes the tool's
  claim from "this is your score" to "this is your score, and here is how much
  the lineup choice actually moves it" — which is the question a coach is really
  asking when comparing two lineups. A 4-point "improvement" inside a 28-point
  band is not an improvement, and right now nothing says so.
- **Why it fits the codebase's values:** it is the opposite of fabrication. It
  makes existing uncertainty visible rather than inventing precision.
- **Effort:** ~2 days for a first version.
- **Risk:** must not be presented as a probability distribution — it is an
  observed spread of past swims, and should be labelled as exactly that.
- **Guardrail:** an athlete with one recorded swim has no spread. That must
  render as *absent*, not as `± 0`, or it reintroduces the pattern
  [01](01-fabricated-values.md) exists to prevent.
