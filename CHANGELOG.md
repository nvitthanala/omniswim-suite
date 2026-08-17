# Changelog

User-visible behaviour changes only, newest first. Refactors, internal
restructuring, and doc-only changes are not recorded here — see `git log` for
those.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
