@echo off
setlocal EnableExtensions
title Omni Swim Suite

:: Resolve suite root (folder containing this script)
set "SUITE_ROOT=%~dp0"
cd /d "%SUITE_ROOT%"

echo.
echo  ========================================
echo   OMNI SWIM SUITE  (DEV)
echo  ========================================
echo.

:: --- Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Install Node 20+ from https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo [OK] Node %NODE_VER%

:: --- Python (optional, for PDF parsing) ---
where python >nul 2>&1
if errorlevel 1 (
  echo [WARN] Python not found. PDF upload may fail until Python 3 is installed.
) else (
  for /f "delims=" %%v in ('python --version 2^>^&1') do echo [OK] %%v
)

:: --- Dependencies ---
if not exist "node_modules\" (
  echo.
  echo [SETUP] First run: installing npm packages...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo [OK] node_modules present
)

:: --- SSL workaround ---
set "NODE_OPTIONS=--use-system-ca"

echo.
echo [START] Launching dev server at http://localhost:3000
echo        Stale servers on port 3000 are stopped automatically.
echo        API routes ^(meet PDF, psych PDF^) load from live server.ts.
echo        Close this window or press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000/"

:: predev hook frees port 3000 before tsx server.ts
call npm run dev

echo.
echo Server stopped.
pause
