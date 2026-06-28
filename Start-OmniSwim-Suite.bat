@echo off
setlocal EnableExtensions
title Omni Swim Suite

:: Resolve suite root (folder containing this script)
set "SUITE_ROOT=%~dp0"
cd /d "%SUITE_ROOT%"

echo.
echo  ========================================
echo   OMNI SWIM SUITE
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
  echo [WARN] Python not found. Matrix PDF upload may fail until Python 3 is installed.
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

:: --- Port 3000 check (stale dev server serves old chart code) ---
set "STALE_PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":3000 .*LISTENING"') do set "STALE_PID=%%a"

if defined STALE_PID (
  echo.
  echo [WARN] Port 3000 is already in use by PID %STALE_PID%.
  echo        A stale Omni Swim Suite window may still be running old code.
  echo        Close the previous server window first, or stop that process.
  echo.
  choice /C YK /M "Try to start anyway (Y) or Kill stale process (K)"
  if errorlevel 2 (
    echo [STOP] Ending PID %STALE_PID%...
    taskkill /PID %STALE_PID% /F >nul 2>&1
    if errorlevel 1 (
      echo [ERROR] Could not stop PID %STALE_PID%. Close the old server manually.
      pause
      exit /b 1
    )
    echo [OK] Stopped stale process.
    timeout /t 1 /nobreak >nul
  )
)

:: --- SSL workaround (matches prior install on this machine) ---
set "NODE_OPTIONS=--use-system-ca"

echo.
echo [START] Launching suite at http://localhost:3000
echo        Hard-refresh the browser ^(Ctrl+Shift+R^) after code changes.
echo        Close this window or press Ctrl+C to stop the server.
echo.

:: Open browser after a short delay (server needs time to bind)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000/"

call npm run dev

echo.
echo Server stopped.
pause
