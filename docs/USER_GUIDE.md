# Omni Swim Suite — how to use it

A guide for coaches. It covers what the app does, in the order you would
actually do it. No code, no setup beyond starting the app.

Nothing here is specific to one team, division, conference or meet format.
Where a screen needs a real example, it says so.

**Contents**

1. [Start the app](#1-start-the-app)
2. [Workspaces](#2-workspaces)
3. [Set the scoring rules](#3-set-the-scoring-rules)
4. [Get swimmers in](#4-get-swimmers-in)
5. [Build a lineup](#5-build-a-lineup)
6. [Relays](#6-relays)
7. [Optimize](#7-optimize)
8. [Score a meet](#8-score-a-meet)
9. [Check your work against official results](#9-check-your-work-against-official-results)
10. [Back up your data](#10-back-up-your-data)
11. [What the app will not do](#11-what-the-app-will-not-do)
12. [When something looks wrong](#12-when-something-looks-wrong)

---

## 1. Start the app

Double-click **`Start-OmniSwim-Suite.bat`**. A terminal window opens, then a
browser tab at `http://localhost:3000`.

Leave the terminal window open. Closing it stops the app.

For day-to-day use, prefer **`Start-OmniSwim-Suite-Prod.bat`**. It builds once
and then runs a production server, which starts slower the first time and is
faster and steadier afterwards. The plain launcher reloads on every code
change, which you only want if someone is editing the code.

Everything runs on your machine. No account, no cloud, no internet needed
except when you are importing from SwimCloud.

### The three applets

| Applet | What it is for |
| --- | --- |
| **Manager** | Rosters, entries, relays, optimisation |
| **Matrix** | Scoring a meet, standings, projections |
| **Metrics** | Video tagging. **Marked Experimental — not meet-ready.** |

Manager and Matrix share the same workspace data. A roster change in Manager
shows up in Matrix without a reload.

---

## 2. Workspaces

A **workspace** is one self-contained set of data: a roster, its meets, its
scoring rules. Think one per season, or one per what-if.

The sidebar on the left lists them. Use it to switch, rename, create (**+**)
or delete.

Create a second workspace whenever you want to try something without
disturbing the real one. They are fully independent.

---

## 3. Set the scoring rules

**Do this first.** Every number the app shows you depends on it.

In **Matrix → Score**, pick a rule set. The app ships **22 built-in rule
sets**, and the point tables come from the NCAA rulebook rather than from
anybody's memory.

### Picking the right one

| Your meet | Rule set |
| --- | --- |
| A dual meet, 6+ lanes | **Dual meet — six lanes or more** (individual 9-4-3-2-1, relays 11-4-2) |
| A dual meet, 5 lanes or fewer | **Dual meet — five lanes or fewer** (individual 5-3-1, relays 7) |
| Tri or quad meet | **Double-dual, triangular or quadrangular** |
| Conference or NCAA championship | **Championships — N competitors qualify**, matching your final field (6, 8, 12, 16, 18 or 24) |
| A relay-only meet | **Relay meet** |
| An invitational | **Invitational — host-published table** (see below) |

If your meet contests diving under the dual-meet diving rules, there are
combined rule sets — for example *Dual meet — six lanes or more + diving, a
team with four or five divers* — because diving uses its own point table,
not the swimming one.

> **Relays are not always double.** At a championship meet the relay table is
> exactly twice the individual table. At a dual meet it is not: 11-4-2 against
> 9-4-3-2-1. Pick the rule set that matches the meet rather than adjusting a
> multiplier.

### Invitationals

NCAA Rule 7-4 leaves the point table to the host, so the app ships **no
numbers** for an invitational. It asks you for the host's published table.
This is deliberate: the app will not invent a competition value. Get the
host's table and enter it.

### Making your own rule set

Click **Manage rule sets** next to the picker.

- **Duplicate** a built-in, then edit the copy. Built-ins are read-only, so
  your changes can never quietly diverge from the published rule.
- Edit the places table, scorer caps, entry limits per swimmer, relay rules
  and diver weighting.
- **Export** a rule set to a file and **Import** one, to hand a format to
  another coach instead of them rebuilding it.

Some controls disable themselves and say why. That is not a bug: it means the
scoring engine will ignore that value under the current rules, and the app
would rather tell you than accept an edit it is going to discard.

---

## 4. Get swimmers in

**Manager → Source.** There are four ways in; use whichever you have.

### Paste

Paste a roster or a times list. Review the parsed rows before confirming.

### CSV

Upload a spreadsheet export. Same review step.

### A meet PDF

In **Matrix → Load**, upload a HyTek meet PDF. This is the most reliable
source, because it carries real results and real places.

### SwimCloud

Two ways, both needing the companion browser extension
(`extensions/swimcloud-companion/`).

**One page at a time** — open a SwimCloud page, click the extension, then use
**From clipboard** in Manager.

**A whole meet** — open a SwimCloud meet page and click **Start crawl**. Pick
which teams you want, then pick **how much** to pull:

| Scope | Pulls | Use it when |
| --- | --- | --- |
| **Meet results only** | Team swims and per-event results | You want to score or scout this meet. **Much the fastest.** |
| **Rosters and season bests only** | Team rosters and each swimmer's personal bests | You want season-best data, not this meet's results |
| **Everything** | All of the above | You want both and do not mind the wait |

The panel tells you the page count and rough time before you start. On a real
four-team meet, *Meet results only* was **42 pages against 234** for
*Everything* — so choose the narrow scope unless you need the rest.

Crawls are paced on purpose, a few seconds per page. It is not stuck. You can
pause and resume, and re-running a crawl skips pages already stored.

> A capture always tells you which scope produced it. If you pull *Meet
> results only* and later go looking for rosters, the app says the crawl never
> asked for them — rather than showing an empty list that looks like the meet
> had no swimmers.

---

## 5. Build a lineup

**Manager → Lineup.** Pick a team, then a swimmer from the roster table. A
panel slides in from the right with that swimmer's events, times and history.

- Add an event, edit a time, toggle an entry on or off, or remove it.
- The entry counter shows where the swimmer stands against the limits your
  rule set defines — for example `5/7 total (3 ind · 2 relay)`.
- **Paste** parses a block of entries into a checklist first. Nothing is
  applied until you confirm, so a paste can never wipe what is already there.

### The side panel

Three tabs beside the roster:

- **Checklist** — what is not yet legal or not yet filled: entry limits,
  empty relay legs, unmapped teams.
- **Arbitrage** — swaps that would gain points, with the gain stated.
- **Scenarios** — save the current lineup, try something else, compare.

Checklist items are information, not blockers. The app will not stop you
entering a lineup; it tells you what a referee would notice.

---

## 6. Relays

**Manager → Relays.** Assign legs per relay, or build a relay from the
individual lineup.

Vacant legs show as vacant. The app does not fill one with a guess.

---

## 7. Optimize

**Manager → Optimize.** Pick a team and run it. The optimiser proposes lineup
changes that raise the team score under your current rule set.

Afterwards a panel lists **exactly what changed** — which swimmer moved into
or out of which event. Read it before accepting. The optimiser is a
suggestion, not an instruction, and it does not know about an injury, a
travel roster, or anything else you have not told it.

**All teams** runs it across every team, which is useful for projecting an
opponent, not just your own squad.

---

## 8. Score a meet

**Matrix → Standings.** Team totals, the order, and the swims behind each
total.

**Matrix → Analyze** explains the result: where the score moved, how prelims
compare to finals, and how projections shifted.

Scoring reflects your rule set, so if a total looks wrong, check section 3
first.

---

## 9. Check your work against official results

When a meet publishes official team scores, load them, and Matrix compares
them against what the app computed.

The comparison appears **only when both sides are present** — official totals
*and* imported results. With only one, there is nothing meaningful to compare,
so the app stays quiet instead of reporting a mismatch against data you have
not loaded yet.

Each team lands in one of four buckets:

| Bucket | Meaning |
| --- | --- |
| **Matched** | Agrees with the official total |
| **Mismatched** | Both sides have this team, totals differ — worth investigating |
| **Official only** | The results name a team the app did not match, usually a team-name spelling difference |
| **Computed only** | The app has a team the official sheet does not |

A mismatch is usually one of: the wrong rule set, a missing swim, or a team
name that did not match between two sources.

---

## 10. Back up your data

Your data lives on your machine, in `data/`. Losing it means rebuilding a
roster by hand.

- The app **backs up automatically** when it starts, and again before you
  delete a workspace.
- For a backup right now — before trying something risky — click the **backup
  icon** in the workspace sidebar, next to **+**. A message names the file it
  wrote.

Backups go to `data/backups/`. The app keeps the 20 most recent of its own and
**never touches files you put there yourself**, so your own copies are safe.

To restore, replace `data/meets.json` with a backup file and restart. Copy the
current one somewhere first.

---

## 11. What the app will not do

These are deliberate. Each exists because the alternative is a plausible wrong
number, which is worse than a gap.

- **It will not invent a competition standard.** If a governing body has not
  published a value, the app shows it as absent rather than estimating.
- **It will not guess a swimmer's round.** If it cannot tell a prelim from a
  final, it excludes the swim and says so instead of picking one.
- **It will not assume a team's division.** An unmapped team reads as unknown,
  never as a default.
- **It will not treat missing data as zero.** "No cut achieved" and "we have no
  data" are shown differently everywhere.
- **Converted times are marked as estimates.** No governing body publishes an
  official course-conversion table, so any converted comparison is labelled
  indicative and never presented as an official time.

---

## 12. When something looks wrong

| Symptom | Check |
| --- | --- |
| Team totals look wrong | The rule set (section 3). A championship table at a dual meet inflates relays badly. |
| A swimmer is missing after an import | Did the crawl use a narrow scope? The capture panel says which pages it pulled. |
| Cut tags say "unknown" | That team is not mapped to a division, or the school does not sponsor that gender. |
| A relay scores nothing | A vacant leg, or legs that are not eligible under the rule set. |
| A crawl seems frozen | It is paced on purpose. The panel shows progress and lets you pause. |
| The app will not start | Another program may be on port 3000. Close the old terminal window and start again. |

Anything that still looks wrong is worth reporting with the workspace name,
the rule set, and what you expected. A wrong number that looks plausible is
the failure mode this app is built to avoid.

---

## Before sharing this with anyone else

Today this suite is a personal tool for one or two coaches, and the sample
data shipped with it is a real roster. Before handing it to anybody outside
that circle, a new installation must start from an empty or demo workspace
instead of live team data. See `docs/reference/PRODUCTION_READINESS_STATE.json`
(`od4`) for the detail.
