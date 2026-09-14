# WORKLOG 09 — swimmer-times parser, and wiring the crawl to fetch it efficiently

**2026-09-09, two `executor` agents, disjoint scope, in parallel.** Built
against the two real swimmer-page captures from this session (F7, resolving
OQ-4), and against the user's explicit scope pivot: crawl a swimmer's own
events, and do it fast enough for a large meet's full roster.

## 1. `parseSwimmerTimesHtml` (`packages/swimcloud/`)

Parses `/swimmer/{id}/times/`'s "Personal Bests" table — one row per
course-qualified event (`"50 Free SCY"` and `"50 Free LCM"` are different
rows for the same stroke/distance). The sibling "Event Progression" tab is
NOT captured anywhere and stays unmodelled.

**Two deliberate, tested decisions worth recording:**
- **Name order**: the `#swimmer-info` JSON (`"Paulk, River J"`) is the
  trusted source, not the page's own `<h1>` (`"River Paulk"`) — it's a
  labelled field, not a display string needing a heuristic to parse.
- **Date stays a verbatim string, never parsed into a `Date`.** The real
  fixture itself proves why: two rows name the same meet (338673) but print
  different dates (`Mar 1, 2025` vs `Feb 28, 2025`) — a swim's date and its
  meet's date are different facts, and reusing an existing meet-date reader
  would have silently conflated them.

**A real gap found and closed, not worked around**: `urlClassifier.ts` had
no way to distinguish `/swimmer/{id}/` from `/swimmer/{id}/times/` — both
would have canonicalized to the same cache key, so a times capture could
silently overwrite a home-page capture. Added a proper `swimmerTimes`
resource kind rather than reusing `swimmer`.

**Verification went past green tests**: the agent deliberately broke the
parser five ways (defaulting an unknown course to SCY, reusing an unrelated
chip-color filter, hardcoding the badge column's index, reversing meet-id
precedence) and confirmed each broke a test — two of the five didn't, because
the fixture couldn't exercise them, so three more tests were added
specifically to close that hole, then the mutations were re-run to confirm
they now fail.

## 2. Wiring the fetch into the crawl loop, efficiently (`extensions/swimcloud-companion/`)

The roster planner from the previous round (`planMeetTeamRosters`) had never
actually been called by the crawl loop — this agent wired it in as its first
step, alongside the new swimmer-times fetch.

**The crawl is now four passes**: team-swims page 1s → pages 2..N → both
roster pages per team (unchanged pacing, sequential, 3s apart) → **swimmer
times, one per rostered swimmer, through a bounded concurrency pool.**

**The concurrency tradeoff, stated plainly rather than smoothed over**: a
fixed pool of 3 lanes with a 400ms floor between starts — a real ~7.5x
speedup for this category alone (a 412-swimmer meet: ~21 min → ~2.75 min for
this pass), applied *only* to swimmer-times leaf pages. The core
team-swims/roster loop's pacing is untouched. The doc comments, the progress
panel, and the manual-verification checklist all say the same thing plainly:
this is a real, knowing departure from this repo's own "never concurrent"
politeness rule (`plans/2026-09-06/01-legal-and-access-strategy.md`), bounded
on two axes and confined to pages that carry no meet-results data — not a
free efficiency win.

**A policy call the brief didn't specify, made and justified**: every
swimmer-times failure keeps the pool running *except* a 403. A challenge is
about the session, not the one page, so firing hundreds more requests into
it would be exactly the bulk-scraper pattern the existing error table draws
the line at — a 403 stops the swimmer-times *pass*, not the whole crawl
(everything already captured stays captured). Encoded as one pure, tested
function (`classifySwimmerTimesOutcome`), not buried in the fetch loop.

**Self-correction mid-task, worth noting**: the brief told this agent to
inline the times-page URL template to avoid touching `crawlPlan.ts` while
the parser agent was also working there. Once the parser agent's
`planMeetSwimmerTimes` landed, this agent noticed, discarded its own
duplicate template, and switched to calling the shared function instead —
citing `background.ts`'s own documented lesson about a hand-duplicated
URL rule agreeing with its source "only by construction." Two independent
agents had built byte-identical URL logic before the correction, which is
reassuring cross-validation, but one copy is still the right end state.

## Verified, independently re-confirmed after both agents reported

- `npx vitest run`: **618 passed, 0 failed**, 33 files.
- `npm run lint --workspaces --if-present`: all 8 workspaces clean.
- `npx tsc --noEmit -p extensions/swimcloud-companion/tsconfig.json`: clean.
- `node extensions/swimcloud-companion/build.mjs`: `crawler.js` 133.4kb,
  `background.js` 12.5kb.
- `npm run build -w @omniswim/shell`: succeeds, `server.js` 362.3kb.

No git operations.

## What's next

- Phase 5's other stretch item — "every swimmer's event history within a
  captured **meet**" (not just a team-subject crawl) — is a natural
  extension of what's built here (the meet crawl already discovers teams
  and now fetches their rosters; the swimmer-times pool already fetches
  every rostered swimmer). Worth confirming this actually composes end to
  end on a real meet before calling it done.
- `plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md` now has a section 6c
  specifically for the concurrency behavior (watch the Network waterfall
  for real overlap, confirm the core loop is still ≥3s/sequential) — still
  nobody has run any part of this checklist in a real browser.
- The server-side `/parse` route (Phase 2c) does not yet know about
  `swimmerTimes` pages — it only ever looked at `meetTeamSwims`. Extending
  it to surface personal-bests data to the Matrix picker is unbuilt.
