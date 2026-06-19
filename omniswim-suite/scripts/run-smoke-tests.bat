@echo off
setlocal EnableExtensions
title Omni Swim Suite - Smoke Tests
cd /d "%~dp0.."

echo.
echo  === Omni Swim Suite smoke tests ===
echo.

set "NODE_OPTIONS=--use-system-ca"
set FAILED=0

echo [TEST] SQLite round-trip...
call npx tsx scripts/test_sqlite_roundtrip.mjs || set FAILED=1

if exist "test_athlete_history.mjs" (
  echo [TEST] athlete history...
  call npx tsx test_athlete_history.mjs || set FAILED=1
)
if exist "test_roster_optimizer.mjs" (
  echo [TEST] roster optimizer...
  call npx tsx test_roster_optimizer.mjs || set FAILED=1
)
if exist "test_entry_limits.mjs" (
  echo [TEST] entry limits...
  call npx tsx test_entry_limits.mjs || set FAILED=1
)

echo.
if "%FAILED%"=="1" (
  echo [RESULT] One or more smoke tests FAILED.
  pause
  exit /b 1
)
echo [RESULT] All smoke tests passed.
pause
