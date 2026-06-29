@echo off
setlocal EnableExtensions
title Omni Swim Suite (Production)

set "SUITE_ROOT=%~dp0"
cd /d "%SUITE_ROOT%"

echo.
echo  ========================================
echo   OMNI SWIM SUITE  (PRODUCTION)
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

if not defined OMNI_DB set "OMNI_DB=sqlite"
set "NODE_ENV=production"
set "NODE_OPTIONS=--use-system-ca"

echo.
echo [START] Production server at http://localhost:3000  (OMNI_DB=%OMNI_DB%)
echo        Stale servers are stopped and a fresh build runs automatically.
echo        Close this window or press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:3000/"

:: prestart hook frees port 3000 and runs npm run build before node dist/server.js
call npm start

echo.
echo Server stopped.
pause
