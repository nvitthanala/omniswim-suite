# Changelog

User-visible behaviour changes only, newest first. Refactors, internal
restructuring, and doc-only changes are not recorded here — see `git log` for
those.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

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
