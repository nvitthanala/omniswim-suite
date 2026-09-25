# Changelog

User-visible behaviour changes only, newest first. Refactors, internal
restructuring, and doc-only changes are not recorded here — see `git log` for
those.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **A swimmer's personal bests can now come straight from SwimCloud's own
  data, not just the rendered page.** The extension reads the JSON a
  swimmer's times page fetches for its own table
  (`/api/swimmers/{id}/profile_fastest_times/`), under a robots.txt
  exemption for that one path (user decision — every other `/api/` path
  stays off-limits). This lands every recorded swim, not only what the page
  happens to render.
- **Diving scores are recorded and merged correctly.** A dive result comes in
  with its score, and a history merge keeps the *higher* of two stored
  scores for the same dive instead of the lower.
- **A save that would wipe out real data now warns you first.** If a save
  would drop a team's men's results, women's results, or athlete history
  from 20 or more rows to zero, or to under half, the app takes a backup
  before saving and shows a persistent message naming the drop and the
  backup file, with a **Restore** button (confirms before it replaces
  anything). A failed backup never blocks the save.
- **Course conversions now use the right table for a team's division.**
  Short-course-meters times convert to yards with the NCAA's own table for
  that team's division — Division I's own factors, or the NCAA Rules Book
  Appendix A-2 factors for D2, D3, NAIA, and any team whose division is
  unknown. Division I is never applied to a team that is not Division I.
  Every conversion is truncated to the hundredth of a second, matching the
  NCAA's published procedure (no rounding).
- **Converted times, altitude-adjusted times, and self-reported times are
  now marked and handled differently from a real result.** A time converted
  from LCM or SCM to SCY is tagged as an estimate everywhere it appears — cut
  badge, recruit projection, entry — never presented as an achieved yards
  time. A SwimCloud time already marked "Altitude Adjusted" is shown as
  such and is never run through the NCAA altitude table again (that would
  adjust it twice). A "User Inputted" (self-reported) SwimCloud time is kept
  and shown, but never becomes a best time, a cut badge, an entry, or a
  projection.
- **Provenance badges on every swim.** Athlete views now show a small badge
  next to a time: **Extracted** (pulled from a longer swim's splits),
  **Self-reported**, **Altitude-adj.**, or **Est. from LCM/SCM** for a
  converted time. A converted time's tooltip states the source time and the
  table used, for example "SCM 54.49 -> 48.82, NCAA Rules Book A-2 (D2)".
- **A Lifetime / This season toggle on an athlete's swim history.** Season
  is labelled by the date range of that season's own swims; the toggle is
  display-only and never changes scoring or entries.
- **"Bests pulled" date.** An athlete's history shows the most recent date
  its SwimCloud data was captured, when known.
- **Refreshing one team's personal bests without a full crawl.** The
  SwimCloud crawl panel gains a "Refresh personal bests already captured"
  option. Checked, with only one team selected and scope set to "Rosters and
  personal bests," it re-fetches every rostered swimmer on that team instead
  of skipping pages the capture already holds.
- **A before/after preview when re-importing from SwimCloud.** Re-importing
  a roster or a single swimmer now shows "N swimmers improved in M events",
  expandable to each swim, for example "100 Back SCY 49.58 -> 48.90
  (-0.68)". The comparison uses the workspace's own stored SwimCloud history
  as the "before," matches by event and course, and never counts an
  extracted split or a self-reported time as an improvement.
- **A SwimCloud reimport can replace a team's SwimCloud data instead of
  merging into it.** Both SwimCloud import screens now offer **Merge into
  existing data** (the default, unchanged) or **Replace this team's
  SwimCloud data**. Replace removes that team and gender's SwimCloud-sourced
  history (swims with source `swimcloud` or `paste`), the recruit rows built
  from it, and the SwimCloud and scoring-theory (optimizer) lineup entries
  built from it, then imports fresh — so a row written under an older,
  since-fixed rule (for example a recruit time built from a self-reported
  swim) does not survive a reimport by accident. Manual and PDF data are
  never touched. Before anything changes, a preview lists what would be
  removed, why, and which swimmers lose data but are missing from the new
  capture; confirming takes a backup first and stops if the backup fails. A
  recruit typed in by hand is now marked `manual` so a replace can never
  remove it.
- **The server reports when a cut table is out of date.** At startup, it
  logs each division whose archived cut table is older than the current
  season — for example, the Division I table, still 2025-26. It only
  reports; it never fetches a new one automatically.
- **NAIA short-course-meters swims now get a direct cut verdict** instead of
  an estimate. NAIA's published sheet heads its metric column "METERS" with
  no stated pool length; per a 2026-09-24 user decision, those times are
  read as short-course meters and judged directly against the NAIA
  standard. NAIA long-course-meters swims still convert to yards as an
  estimate, same as before.
- **Every published NCAA meet format can now be scored.** Built-in rule sets go
  from 2 to 22: dual meets (six lanes or more, and five or fewer), the three
  dual-diving tables, double-dual/triangular/quadrangular, relay meets,
  invitationals, and championships at all six published field sizes, plus six
  dual-plus-diving combinations. Point tables are generated from the archived
  NCAA rulebook rather than transcribed. A dual meet was previously impossible
  to represent, because relay points were modelled as a multiple of the
  individual table and a dual meet scores individuals 9-4-3-2-1 with relays
  11-4-2.
- **Rule sets can be created and edited in the app.** Matrix → Score → *Manage
  rule sets* duplicates a built-in, edits the places table, caps, entry limits,
  relay and diving tables, and imports or exports a rule set as a file so a
  format can be handed to another coach. Built-ins stay read-only.
- **Invitational meets ask for the host's point table.** NCAA Rule 7-4 leaves
  that table to the host, so none is shipped and none is invented.
- **Crawls can fetch only what the job needs.** A SwimCloud meet crawl now
  offers *Meet results only*, *Team rosters only*, or *Everything*, with the
  page count and rough time shown before it starts. On a real four-team meet,
  meet results alone was 42 pages against 234.
- **Backups happen on their own.** One is written when the app starts and
  again before a workspace is deleted, and a backup button sits in the
  workspace sidebar. History is capped at 20 (`OMNI_BACKUP_KEEP` to change it),
  and retention only ever removes files the app itself wrote.
- **A user guide**, at `docs/USER_GUIDE.md`.

### Changed

- **Roster event labels are compact and readable.** A swimmer's event list
  used to print the raw meet-result label ("Event 4 Men 1000 Yard
  Freestyle"). It now shows "1000 Free (SCY)". The underlying data is
  unchanged; only the display shortens.
- **Paste import panels report unread rows in one line.** Instead of one
  warning per row, a paste that could not read some rows' stamps now names
  the affected events in a single summary line.
- **The analytics table splits an event by course and shows how many meets
  were swum.** A swimmer with both an SCY and an SCM time in the same event
  now gets two rows instead of one colliding row. The table gained a
  **Course** column, and the column that showed a meet count — mislabeled
  "Points" — is now headed **Meets**.

### Changed

- **Crawls no longer request swimmer personal-best pages.** That page builds
  its table in the browser, so a fetched copy contains no times — measured
  across every one of the 73 pages that returned successfully in a real crawl.
  Those requests were 184 of 234 and produced nothing. Personal bests still
  come from the extension's clipboard button, which reads the rendered page.
- **Comparison against official results waits for both sides.** With official
  totals loaded and nothing imported, Matrix used to report "0 of N teams
  match" — a total-failure reading of an empty workspace. It now stays quiet
  until there is something real to compare.
- **The Metrics applet is marked Experimental** everywhere it appears. It is
  not meet-ready and is not covered by this round of work.

### Changed

- **Buttons across the app now share one definition.** 143 controls moved onto
  the shared `Button` primitive, so corners, weight, spacing and disabled states
  are consistent instead of hand-rolled per screen. Corners are slightly
  rounder and labels slightly bolder than before. Tab strips, disclosure
  headers and row selectors are deliberately unchanged — those are layout, not
  buttons.

### Changed

- **A fresh installation no longer starts from somebody else's roster.**
  `data/meets.json` was both the live working store and the seed committed to
  the repository, so cloning the project handed you real athlete names, history
  and recruit lists as your starting data. The two roles are now separate files:
  `meets.json` is local and untracked, and a new install seeds from
  `data/demo-seed.json` — one clearly-labelled sample workspace with invented
  schools and swimmers. Existing installations keep their own data and see no
  change.

### Removed

- **The Team Roster Catalog is gone.** It never worked: its client called 13
  server routes that were never written, so every request returned "API route
  not found". Manager's "Team Catalog" button opened a panel whose every call
  failed silently, and Matrix's "Catalog:" dropdown could only ever offer
  "(off — PDF only)". Removed rather than finished, because nothing depended on
  it and a control that silently fails is worse than no control.

### Fixed

- **A distance freestyle swim recorded in the wrong course is flagged, not
  converted.** There is no 1000 Freestyle in short-course meters: that course
  swims the 800 in its place. An SCM "1000 Freestyle" used to convert to
  yards with the NCAA's 800-meter factor, then rank, earn a cut badge and
  become an entry like a real time. Now a 500, 1000 or 1650 Freestyle
  recorded SCM, and a 400, 800 or 1500 Freestyle recorded SCY, stays in the
  swimmer's history but is never converted, ranked, cut-tagged or entered.
  Its cut tag shows "Unknown" with the reason. The import names the swim in
  a warning. A recruit row or planned entry like it is left out of scoring
  and listed on the lineup checklist. The pairing comes from the archived
  NCAA conversion tables and NAIA sheets. Long-course meters is not checked,
  because no archived source lists its events.
- **NAIA short-course-meters swims now show their cut badge.** The cut tag
  already judged an NAIA team's SCM swim against the NAIA meters standard,
  but the badge stored with pasted history and roster-catalog times skipped
  every metric swim, so it was missing. Both badges now use the NAIA SCM
  standard. The import panel's badge tooltip now quotes the standard in the
  swim's own course, for example "Beats NAIA 2026-2027 automatic standard —
  22.27 (short-course metres)", instead of a yards time, and no longer
  reads "NCAA NAIA". Every other metric swim still gets no badge: its
  converted time is an estimate.
- **Relay legs no longer get filled from the wrong swim.** A relay leg used
  to match an individual swim by checking whether one event name contained
  another, so a swimmer's 1000 Free could stand in for a 100 split, and a
  500 could stand in for a 50. This produced impossible relay times (a
  400 Free Relay computed at -373.17) and offered distance swimmers for
  sprint relay legs. Legs now match on the exact canonical event, so HyTek,
  SwimCloud, and short display labels ("100 Free") all still match
  correctly. Under this app's default NSISC rules no team's final score
  changes, because relays there score by stored place; relay times, the
  autofill suggestions, and swap rankings do change.
- **Extracted splits and self-reported times can no longer become a
  swimmer's "best."** They used to leak into entry suggestions, the
  cross-course comparison table, theory-plan history, season charts, and
  history merges — meaning splits pulled out of a longer swim, and times a
  swimmer typed in themselves, could outrank or replace a real result.
  One rule now decides eligibility everywhere. Best times are also now
  matched by the swim's actual event and course, not by whichever label
  happened to import it, so "50 Free SCY" and "50 Freestyle" are correctly
  treated as the same event instead of two.
- **A meet's results were sometimes invisible on the athlete's own
  profile.** A HyTek result label could fail the check for "is this event
  offered," so the swim never reached that athlete's profile at all. Fixing
  this surfaced two more: a relay-split time trial could be ranked as a
  real best, and a relay leg could be matched to an individual swim by
  overlapping numbers rather than the exact event (see the relay-leg fix
  above).
- **Pasted meet rows no longer lose their meet name to a multi-word cut
  label.** A row containing a chip like "D2 B" or a glued chip like
  "NCSAX" could overwrite the meet name or import as a spurious result.
  Rows are now read column by column, and a glued chip is only split when
  it matches a known cut label.
- **Creating your first workspace no longer crashes Manager.** A hook was
  called after an early return, so going from no workspace to one changed the
  number of hooks React saw on a mounted component. Deleting the last
  workspace did the same in reverse.
- **Choosing the invitational rule set no longer throws.** It correctly
  refuses to invent a point table, and nothing caught the resulting error.
- **The relay multiplier no longer accepts edits the engine discards.** When an
  explicit relay table is set, the multiplier is ignored; the control now says
  so instead of taking the value.
- **A narrowed capture no longer reads as an empty meet.** A capture explains
  which passes its crawl planned, so "no rosters here" is distinguishable from
  "this meet has no swimmers".

### Added

- **Roster import can now pull a swimmer's personal bests straight from
  SwimCloud.** Install the browser extension in `extensions/swimcloud-companion/`,
  click "Copy for Omniswim" on a swimmer's SwimCloud profile page, then use
  the new "From clipboard" button in the roster importer. Requires the
  extension (a separate, manual install — nothing fetches automatically).
  Only swimmer profile pages are supported; team-roster and meet-results
  pages are parsed internally but have no import UI yet. See
  `plans/2026-09-06/` for the full design and its data-provenance/legal
  reasoning.

## 2026-08-16

### Fixed

- **Benching one athlete no longer zeroes their teammates.** Scorer-roster
  eligibility was applied to a whole tie group at once, so a single athlete
  turned off cost every teammate tied with them. On the HSU 2026-27 roster this
  was the mechanism behind "Optimize team" destroying the projection: the
  scorers stage alone scored **213**, and now scores **1270**. Displayed team
  totals are unchanged — the bug only surfaced once an eligibility override
  existed. Benched points are forfeited, not redistributed to teammates.
- **"Optimize team" finds a better lineup on a roster-only workspace.** Best
  available result on HSU men rises from 1395 to **1407.27** (current 1277),
  because the stage combination that previously collapsed to zero is now viable.
- **Official team scores ending in a half point are no longer destroyed on
  import.** A meet PDF total of `1,029.50` was being read as the school
  "… 1,029." scoring `50` points, silently, for every team whose score ended in
  .50. Such a line now parses correctly, and a line that still cannot be split
  safely raises instead of storing a wrong total.

## 2026-08-15

### Changed

- **Server now binds `127.0.0.1` by default.** Set `OMNI_HOST` to expose it on
  another interface deliberately — previously the server was reachable from
  other devices on the network without anyone choosing that.
- **Cut badges for teams with no mapped division now show unknown, not a D1
  judgment.** A team missing from `teamDivisions.ts` used to be silently
  scored against the D1 cut table; it now renders as unknown instead of a
  wrong-but-confident badge.
- **Point-arbitrage cards state real points, and run on request.** Cards used
  to show a fabricated value (`seconds gap × 2`, labelled as points) computed
  automatically on every render. They now report the actual point swing from a
  re-scored swap, and the scan runs from a button instead of blocking the page
  on open.

## 2026-08-14

### Changed

- **Athletes are only offered events the loaded meet actually contests.** The
  event picker used to fall back to a hardcoded list; it now defers to the
  loaded meet's program and only falls back when no meet is loaded.
- **An athlete's best events are now ranked by quality against the published
  standard, not by raw elapsed time.** This changed which events some athletes
  are entered in — a swimmer's fastest *time* is not always their strongest
  event relative to the field.
- **IM course conversions were using the 50 Freestyle factor.** Corrected to
  use the right conversion factor for IM events; any IM time that had been
  converted between courses (SCM/LCM to SCY) before this fix may have been off.
- **A workspace loading a meet now takes its name from the PDF when the
  workspace was still unnamed**, instead of staying "Blank Workspace N".

## Earlier

See `docs/archive/` for the handoff documents behind earlier rounds of work
(roster data overhaul, matrix rescore, alias declutter, lineup bug fixes) —
those predate this changelog and are not reconstructed here entry-by-entry.
