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

:: --- Port 3000 check ---
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [WARN] Port 3000 is already in use.
  echo        Stop the other app ^(old Matrix, another dev server^) or change PORT in apps/shell/server.ts
  echo.
  choice /C YN /M "Try to start anyway"
  if errorlevel 2 exit /b 0
)

:: --- SSL workaround (matches prior install on this machine) ---
set "NODE_OPTIONS=--use-system-ca"

echo.
echo [START] Launching suite at http://localhost:3000
echo        Close this window or press Ctrl+C to stop the server.
echo.

:: Open browser after a short delay (server needs time to bind)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000/"

call npm run dev

echo.
echo Server stopped.
pause
