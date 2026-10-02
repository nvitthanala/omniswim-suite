# Omniswim Suite: instructions for Codex and Cursor agents

You are a worker in a multi-provider setup (Claude, Codex, Cursor). An
orchestrator briefs you through Orca. Follow your brief first. This file holds
the rules that always apply. `CLAUDE.md` holds the full project rules; read it
for anything not covered here.

## 1. Read the Obsidian vault before you read code cold

The project knowledge base is at:

`C:\Users\nihar\Documents\Obsidian Vault\omniswim-suite\`

It is outside this repo and not in git. Start at `00-INDEX.md`. It has the
architecture, the load-bearing gotchas (`02-Invariants-and-Gotchas.md`),
current known issues (`04-Known-Issues-and-Current-State.md`), and the data
provenance rules (`06-Data-Provenance-Rules.md`).

- Read the notes that match your task before you grep the codebase.
- If you cannot open that folder, say so in your report. Do not guess its content.
- The repo is ground truth. If a vault note disagrees with the code or with
  `docs/INVARIANTS.md`, trust the repo and say which note is stale.
- You may add ONE new note per task under `Sessions\`, named
  `<provider>-YYYY-MM-DD-<topic>.md`. State what changed, why, and which files.
  Cite your source for every claim. Do not edit any other vault note. The
  orchestrator merges your note into the main ones.

## 2. Rules that never bend

- **Never invent competition data.** No cut standard, qualifying time or rule
  is estimated, interpolated or hand-typed. Missing means absent, not zero.
  Parsers fail loudly. Unknown division is not D1. See `CLAUDE.md`, "Data
  provenance".
- **No git operations.** Do not commit, branch, merge, rebase, stash, push or
  reset. Produce a diff only.
- **Stay in scope.** Edit only what your brief lists. Other workers may be
  active in other areas.
- **Additive changes.** Existing exports and props keep working.
- **Nothing hardcoded to one conference or division.** The suite must work for
  every division and conference. Read settings; do not branch on a name.
- **Dark, Light and custom themes must keep working.** Use existing CSS
  variables. No hardcoded hex colors. New tokens are prefixed `--ui-*`.
- **Briefs stand alone.** Ask the coordinator with the `ask` command from your
  Orca preamble if something blocks you. Do not guess.

## 3. Gates

Before you report done, these must pass, or you must say exactly what fails:

```
npx vitest run
npm run lint:types
node scripts/run-tests.mjs
```

Also run eslint on the files you touched. Another worker may be editing in
parallel; if a failure is in a file you did not touch, rerun once before you
report it.

For any change to scoring, lineup, entry-cap or cut-standard logic: capture a
golden output on real data before the change and show it is unchanged after,
except for differences your brief explains. Then break your own fix on purpose
to prove a test catches it.

## 4. Report shape

End with three headings: **Blocked on me**, **Changed** (files, exports, what
changed), **Found** (anything surprising, with file and line). Write "none"
under an empty heading. Be concise. State which checks you ran and their
results. Do not say something passed unless you ran it.

## 5. Quota awareness

Codex has a hard 30-day cap. Cursor's Free plan allows only the `Auto` model
and has a small monthly cap. Do not run loops or large exploratory scans you do
not need. Prefer targeted reads. Never launch `cursor-agent` or `codex` yourself
from a script; the user's antivirus flags it.
