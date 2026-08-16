# Changelog

User-visible behaviour changes only, newest first. Refactors, internal
restructuring, and doc-only changes are not recorded here — see `git log` for
those.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
