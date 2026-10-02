---
name: provider-routing
description: Split, hand off and continue work across Claude, Codex and Cursor in this repo. Use when a task can be divided across providers, when one provider is blocked or low on quota, or when a diff needs review from a different provider than the one that wrote it. Reads docs/reference/PROVIDER_ROUTING.json. Dispatches non-Claude work through Orca.
---

# Provider routing

Three providers do work here: Claude, Codex and Cursor. The orchestrator
splits a task, sends each piece to the best available provider, and verifies
every result itself. Routing lives in data, not in this file:
`docs/reference/PROVIDER_ROUTING.json`. Read it first. Edit it to change
routing.

This skill replaces the retired `fleet-routing` harness. That harness stays
retired. Orca is the only cross-provider layer.

## Step 1. Classify each piece of work

Pick one risk class from the JSON: `design`, `core`, `ui`, `mechanical`,
`adversarial`. When a task mixes classes, split it. Core and design pieces
land first. UI pieces wait for the reported API.

## Step 2. Pick the provider

For the class, take the first provider in `build` that passes the rules:

- Skip a provider whose `available` is false.
- Skip a provider whose `remainingPct` is a number below 10.
- Unknown budget means usable. Say so in the report.
- Claude's budget is live: read the `command-center` band, `/budget`, or the
  "Budget tier" line. Use the lower of the 5h and 7d windows.
- Run `node ~/.claude/scripts/provider-usage-report.mjs --json`. Codex: remaining
  is 100 minus `codex.primary.usedPct` (read from Codex's own session logs).
  Cursor: publishes no figure locally. Use `cursor.remainingPct` only when it
  was entered by hand and `isStale` is false; otherwise treat it as unknown.
  Enter a Cursor figure with `--set cursor <remainingPct>`.

## Step 3. Write a standalone brief

A worker starts cold. Every brief, to any provider, has these five parts:

1. **Target:** exact files, component or environment.
2. **Change:** the concrete result.
3. **Constraints:** do-not-touch files, additive APIs only, no git
   operations, never invent a competition value (see `CLAUDE.md` data
   provenance rules), nothing hardcoded to a conference or division.
4. **Ownership:** what the worker may edit.
5. **Observable acceptance:** the exact commands that must pass, such as
   `npx vitest run`, `npm run lint:types`, `node scripts/run-tests.mjs`.

Add the handoff fields from the orchestrator agent: inputs already available,
what done means, prior confidence, what was tried and failed, and the owner
if the chain stops. End the brief with the report shape: **Blocked on me**,
**Changed**, **Found**.

Point the worker at `docs/reference/PHASE_STATE.json` or the task's state file
for its entry. Do not say "continue where you left off".

## Step 4. Dispatch

**Claude:** use the `Agent` tool with `subagent_type`. Run it in the
background. Continue it later with `SendMessage`.

**Codex or Cursor:** use Orca. Resolve the CLI as the `orchestration` skill
says, then load its guide once with `orca skills get orchestration`.

```text
orca orchestration run-create --objective "<objective>" --json
orca orchestration worker-start --spec "<brief>" --agent <codex|cursor> --worktree <current|new-child> --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

- Read-only work may use `--worktree current`.
- Any worker that edits files gets its own worktree (`--worktree new-child`)
  unless its file scope is disjoint from every other live editor.
- `packages/core` has one editor at a time, whatever the provider.
- If `worker-start` exits non-zero, do not relaunch. Read `failedStage` and
  `lastError`, and fix the cause. Example seen 2026-10-02: Codex stopped at
  `agent-update-prompt`.
- Never run `worker-start` for Codex until a smoke test has passed (see
  below). Mark `available` accordingly.

## Step 5. Verify, then accept

A `worker_done` is a claim. Before accepting it:

1. Read the diff.
2. Rerun the acceptance commands yourself.
3. For core work, run the golden snapshot and mutation checks the brief
   required.

Then do exactly one: reuse the terminal for a follow-up, retain it, or
`worker-release` it. Acknowledge the delivery.

## Step 6. Cross-provider review

A diff is reviewed by a different provider than the one that wrote it. Use
`review` and `reviewOrder` in the JSON. Typical pairs:

- Codex or Cursor wrote it: Claude `architect` reviews (read-only).
- Claude `executor` wrote it: Codex or Cursor reviews with a read-only brief,
  or Claude `architect` when the others are unavailable.

If only one provider is available, review with a different model tier and
say so in the report.

## Step 7. Pass off and continue

Work moves between providers when one is blocked or low on quota:

1. Stop the blocked worker only on positive proof it stopped (see the
   `orchestration` skill). Absence of output is not proof.
2. Record in the state file: what is done, what is in the tree, what failed.
3. Check `git status` and run the gates. The tree is the truth, not the
   worker's report.
4. Write a new brief from the handoff fields. Dispatch to the next provider
   in the class's `build` list. Use `--retry-of <dispatch_id>` with
   `--task` for an Orca retry. Resume Claude agents with `SendMessage`.

## Smoke test before first use of a provider

Start one read-only worker: run `node --version` and
`git rev-parse --abbrev-ref HEAD`, edit nothing, send `worker_done`. Pass
means it launches, runs both commands, and reports the correct values. Then
set `available: true` and a `verified` note in the JSON.

## Status on 2026-10-02

- Claude: working.
- Cursor: smoke test passed. No local usage figure; enter one by hand.
- Codex: smoke test passed after updating the CLI to 0.160.0. Usage is read
  from its session logs. A later CLI update can bring back the update prompt
  that blocks unattended launch; rerun the smoke test if `worker-start` fails
  with `agent-update-prompt`.
