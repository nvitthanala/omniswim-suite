@echo off
setlocal EnableExtensions
title Omni Swim Suite - Smoke Tests
cd /d "%~dp0.."

echo.
echo  === Omni Swim Suite smoke tests ===
echo.

set "NODE_OPTIONS=--use-system-ca"
set FAILED=0

echo [TEST] Vitest unit tests...
call npm test || set FAILED=1

echo [TEST] SQLite round-trip...
call npx tsx scripts/test_sqlite_roundtrip.mjs || set FAILED=1

if exist "scripts\test_athlete_history.mjs" (
  echo [TEST] athlete history (legacy script)...
  call npx tsx scripts/test_athlete_history.mjs || set FAILED=1
)
if exist "scripts\test_roster_optimizer.mjs" (
  echo [TEST] roster optimizer (legacy script)...
  call npx tsx scripts/test_roster_optimizer.mjs || set FAILED=1
)
if exist "scripts\test_entry_limits.mjs" (
  echo [TEST] entry limits (legacy script)...
  call npx tsx scripts/test_entry_limits.mjs || set FAILED=1
)

echo.
if "%FAILED%"=="1" (
  echo [RESULT] One or more smoke tests FAILED.
  pause
  exit /b 1
)
echo [RESULT] All smoke tests passed.
pause
