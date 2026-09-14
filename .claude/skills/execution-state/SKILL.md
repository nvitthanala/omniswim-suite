---
name: execution-state
description: Track a long-horizon, multi-agent, multi-resume task (a refactor sweep, a multi-phase import pipeline build, anything that spans several subagent dispatches or session resumes) with one small canonical state file instead of conversation history. Use when a task will outlive a single turn — several Phase-N targets, a sweep across many files, a task likely to hit a rate limit and resume. Prevents the exact failure of losing or misattributing a subagent's verification results once the transcript that produced them is gone.
---

# Execution State

Source: distilled from "SKILL.state: Scalable Long-Horizon Agent Skills"
(Badhe, Tiwari, Chung — Google LLC & Purdue University, arXiv:2608.26263).
That paper is a runtime-architecture proposal for LLM agent loops in
general; this file is the project-level pattern it motivates, applied by
hand — nothing here talks to the paper's runtime directly.

## The failure this prevents

This branch has hit the paper's exact failure mode once already. A
subagent ran a mutation-testing pass on `relayLegSwaps.ts`, reported "19/23
caught, 4 survived" mid-turn, then hit a rate limit. By the time the work
resumed, the only record of that run was scattered scratchpad files with no
canonical name — and on inspection, the JSON that looked like a match
actually belonged to a *different*, already-committed refactor target. The
19/23 result was real but became unverifiable: nothing durable named which
mutations were tried, which file they targeted, or what "caught" meant for
each one. The fix that shipped instead re-ran a smaller, freshly-verified
check and said plainly in the commit message that the earlier number
couldn't be trusted. That plain admission is what this skill exists to
make unnecessary next time.

The root cause, in the paper's terms: state lived only in conversational
history (agent turns, scratchpad file names improvised per-run) rather
than in one explicit, named, structured place. History gets compacted,
subagents start cold, and file names improvised under time pressure
collide across concurrent runs. None of that is a discipline problem to
fix by trying harder — it's a state-design problem to fix by writing the
state down somewhere specific.

## The pattern

**One canonical state file per long-horizon task**, not one per subagent
run and not the conversation transcript. For this repo's refactor sweeps,
that's `docs/reference/PHASE_STATE.json` (create it the first time a sweep
starts; keep reusing it for later sweeps by adding entries, never by
starting a second file).

Fixed minimal schema — this is the sufficient statistic for "what's the
state of this sweep," nothing more:

```json
{
  "sweep": "phase-2-core-complexity",
  "targets": [
    {
      "name": "rankRelayLegSwaps",
      "file": "packages/core/src/lib/arbitrage/relayLegSwaps.ts",
      "status": "verified-committed",
      "rawCC": 50,
      "note": "lizard-measured; see cyclomatic-complexity skill's known false floors",
      "commit": "9ce2fcaf",
      "verifiedBy": [
        "scripts/test_relay_swaps.mjs: 6/6 groups, output identical to baseline",
        "npm run lint --workspace=@omniswim/core: clean",
        "node scripts/run-tests.mjs: no new failures",
        "export surface diffed by name against HEAD: unchanged",
        "spot mutation (onRelay guard removed): caught, reverted"
      ]
    }
  ],
  "nextTarget": null,
  "blockers": []
}
```

Rules for using it:

1. **Update it with a patch, right after a step is verified — not a
   rewrite of the whole file, and not a summary written from memory at
   the end.** A target's entry moves `pending` → `in-progress` →
   `verified-committed` (or `blocked`, with why) as it actually happens.
2. **`verifiedBy` lists only checks that were actually re-run and
   witnessed**, not what a subagent claimed. If a subagent's report can't
   be independently re-checked before the next step depends on it, the
   entry says so instead of repeating the claim as fact.
3. **A brief to a resumed or fresh subagent points at this file**, not at
   "continue where you left off" — hand it the target's current entry and
   the acceptance bar, not the transcript. The file is the memory; the
   transcript is disposable.
4. **Discard scratch verification artifacts once their result is folded
   into the state file.** Ad hoc scratchpad files (golden-output dumps,
   mutation lists) are fine as working material *during* a step, but they
   are not the record — the state file's `verifiedBy` line is. Don't leave
   five files with generic names like `mutation_results.json` for the next
   reader (or the next you) to guess the target of.
5. **One file per sweep, not per session.** A session boundary, a
   compaction, or a rate-limit resume should never require re-deriving
   what's done — read the state file's current entries and continue from
   `nextTarget`.

## When to skip this

Small, one-shot tasks that finish inside a single turn don't need it — the
paper's own limitation applies here too: if there's no fixed shape to the
state in advance, or the task's whole point is auditing the history itself
(this session's own retrospective, a "what happened" narrative), a state
file adds bookkeeping without buying anything. Reach for it specifically
when a task is going to span more than one subagent dispatch or is likely
to survive a rate-limit resume or a compaction.
