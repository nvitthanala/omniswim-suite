@echo off
setlocal EnableExtensions
title Omni Swim Suite - Smoke Tests
cd /d "%~dp0.."

echo.
echo  === Omni Swim Suite smoke tests ===
echo.

set "NODE_OPTIONS=--use-system-ca"

call npm test
set "RESULT=%ERRORLEVEL%"

echo.
if not "%RESULT%"=="0" (
  echo [RESULT] One or more smoke tests FAILED.
  pause
  exit /b 1
)
echo [RESULT] All smoke tests passed.
pause
