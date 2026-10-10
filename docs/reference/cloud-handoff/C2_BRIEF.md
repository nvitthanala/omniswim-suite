# Phase C2 brief: paste this into a Claude Code cloud (web) session

Repo: github.com/nvitthanala/omniswim-suite, branch `nvitthanala/ui-simplification`.
Work on a new branch `cloud/c2-relays`. Commit in small commits. Push that branch only.
Never push to `main` or to `nvitthanala/ui-simplification`. Never force-push.

## Budget (hard rules)
- Credit cap for ALL cloud work: $75 (75% of a $100 balance). Spent before C2: $0.
- Phase C2 ceiling: $25. Stop starting new work at $20.
- At the start run `date -u +%FT%TZ` and keep it as START.
- After each milestone run `node scripts/claude-cost-report.mjs --since <START>`. It prices this
  session's transcripts per model. Paste the full output into your report.
- Use Sonnet 5.5 for building. Use Opus 5.5 once, for a read-only review, at the end. No Fable.
  Do not run more than two subagents at once. Do not loop on a failing command more than twice.

## Network rule (absolute)
Never request swimcloud.com. SwimCloud forbids automated access and Cloudflare blocks it. All
SwimCloud data in tests comes from committed fixtures. The cloud network is for git and npm only.

## Read first (short)
CLAUDE.md ("Data provenance" is binding), docs/reference/THEORETICAL_MEET_PLAN.md,
docs/reference/THEORETICAL_MEET_STATE.json, docs/reference/CLOUD_CREDIT_LEDGER.json,
docs/reference/cloud-handoff/C1_REPORT.md.

## Setup
`npm ci`, `npx playwright install chromium`. Baseline: `npm run lint` (0 errors; 2 known
complexity warnings), `npx vitest run` (14 skipped by design; 2 tests that need the git-ignored
capture folder may fail in a clean checkout: say so, do not fix), e2e on a temp data copy:
`PORT=<free> npx playwright test <spec>`, harness: `npm run test:harness`.

## Task 1: relays from individual bests, labelled as estimates (user decision, 2026-10-04)
A theoretical meet has no relays today, so team totals run low (the Matrix banner says so).
Build relay entries from each team's individual bests:
1. First read how the Manager builds relays: relayLegSplitDetail, relayMissingLeg,
   relay_leg_overrides, RelayGroupCard, and any code that estimates a flying-start leg from a
   flat-start best. Reuse it. Do not write a second relay builder.
2. Design before building (write it into docs/reference/THEORETICAL_MEET_PLAN.md, short): which
   relay events NSISC scores; how legs are chosen (fastest four by flat-start best for the event's
   stroke, leg order rule); how a flying-start adjustment is applied (a setting with a stated
   source, never a typed-in constant; if the app has none, make it a user-visible setting with the
   default OFF and say what it does); how the team time is formed.
3. Provenance rules: a relay time built this way is an ESTIMATE. It is never stored as a real leg
   time, never mixed with real legs, and every row carries a visible 'estimated' tag. Absent is not
   zero: a team without four swimmers for a relay gets no relay entry, with a reason.
4. Output rows feed the existing scoring path the way the individual meet rows do (see
   packages/manager/src/lib/theoreticalMeetWorkspace.ts, rank bands A Final / B Final / C Final,
   no pdfPoints). Check what the scoring engine needs from relay rows (relay scoring, doubled
   points if the preset says so) by reading it; prove the totals with a hand-computed test.
5. The dialog (packages/manager/src/components/theoreticalMeet/) gets an 'Include relays
   (estimated)' switch, default on, with one plain sentence of what it means, and the preview
   lists each relay entry with its four swimmers and the 'estimated' tag. The banner text changes
   from 'Relays are not included' to say they are estimated when included.
6. Do NOT edit packages/core scoring logic. Additive core types only, and only if unavoidable
   (say why).

## Task 2: editable chosen events (only if the budget allows after Task 1)
The preview shows each swimmer's chosen events as read-only chips. Make them removable while the
caps stay honest. The seed builder (packages/manager/src/lib/theoreticalMeetSeeds.ts) picks events
under the caps with the existing selector; add an input that excludes named events, so removing a
chip re-runs the selection with that event excluded and the next-best event fills the slot.
Do not write a second selector.

## Gates (run yourself; paste real tails)
`npm run lint` 0 errors; `npm run lint:extension`; `npx vitest run` green; the theoretical-meet
e2e spec; `npm run test:harness`. Tests must fail first, then pass; do 3 real mutations per task
(restore each file; verify sha256).

## Review (Opus 5.5, read-only, one pass, last)
Ask for confirmed defects only, each with a concrete failing scenario: relay legs chosen wrongly,
a relay time stored as real, double counting a swimmer across relays beyond the meet's rules,
points wrong. Fix what is confirmed. Re-run the gates.

## Report (plain short sentences)
Branch and commits, what was verified, the design decisions, the full cost output, gate tails,
what is blocked, and the exact next step. Write docs/reference/cloud-handoff/C2_REPORT.md with the
same facts and a 'Vault notes' list (the Obsidian vault is not reachable from the cloud).
