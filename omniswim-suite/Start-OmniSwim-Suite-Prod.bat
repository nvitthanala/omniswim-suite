@echo off
setlocal EnableExtensions
title Omni Swim Suite (Production)

set "SUITE_ROOT=%~dp0"
cd /d "%SUITE_ROOT%"

echo.
echo  ========================================
echo   OMNI SWIM SUITE  (PRODUCTION BUILD)
echo  ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [SETUP] Installing npm packages...
  call npm install || (echo [ERROR] npm install failed. & pause & exit /b 1)
)

echo [BUILD] Building client + server bundle...
call npm run build || (echo [ERROR] Build failed. & pause & exit /b 1)

:: Persistence: SQLite is default (OMNI_DB=sqlite). Use OMNI_DB=json for legacy JSON.
if not defined OMNI_DB set "OMNI_DB=sqlite"
set "NODE_ENV=production"
set "NODE_OPTIONS=--use-system-ca"

echo.
echo [START] Production server at http://localhost:3000  (OMNI_DB=%OMNI_DB%)
echo        Close this window or press Ctrl+C to stop.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000/"

call npm start

echo.
echo Server stopped.
pause
