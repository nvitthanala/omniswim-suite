#!/usr/bin/env bash
# Usage: scripts/orca/dispatch-codex.sh <brief-file> <objective>. Starts one Codex worker in the current worktree,
# clears Codex's update prompt if shown, sends the brief by hand if Codex dropped it, and prints
# run, dispatch and terminal.
set -u
F="$1"; OBJ="$2"
cd /c/Users/nihar/Documents/GitHub/omniswim-suite
R=$(orca orchestration run-create --objective "$OBJ" --json 2>&1 | grep -oE 'run_[0-9a-f]+' | head -1)
sed -i "s/RUNID/$R/" "$F"
OUT=$(orca orchestration worker-start --run "$R" --spec "$(cat "$F")" --agent "${AGENT:-codex}" --worktree current --json 2>&1)
D=$(echo "$OUT" | grep -oE '"dispatchId": "[^"]+"' | head -1 | cut -d'"' -f4)
T=$(echo "$OUT" | grep -oE 'term_[0-9a-f-]+' | head -1)
sleep 20
# Codex may open on its "Update available" menu: choose 3 (skip until next version), then a raw Enter.
if orca terminal read --terminal "$T" --screen 2>&1 | grep -q "Update available"; then
  orca terminal send --terminal "$T" --text "3" >/dev/null 2>&1; sleep 3
  orca terminal send --terminal "$T" --text $'\r' >/dev/null 2>&1; sleep 12
  orca terminal send --terminal "$T" --text "$(tr '\n' ' ' < "$F")" --enter --wait-submit 20 >/dev/null 2>&1
  echo "update prompt cleared; brief resent"
elif orca terminal read --terminal "$T" 2>&1 | tail -4 | grep -q "^›\s*$"; then
  orca terminal send --terminal "$T" --text "$(tr '\n' ' ' < "$F")" --enter --json 2>&1 | grep -oE '"accepted": (true|false)' | head -1
fi
echo "run=$R dispatch=$D terminal=$T"
