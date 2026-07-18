@echo off
setlocal EnableExtensions
title Omni Swim Suite

:: Resolve suite root (folder containing this script)
set "SUITE_ROOT=%~dp0"
:: Strip trailing backslash for cleaner display
if "%SUITE_ROOT:~-1%"=="\" set "SUITE_ROOT=%SUITE_ROOT:~0,-1%"
cd /d "%SUITE_ROOT%"

echo.
echo  ========================================
echo   OMNI SWIM SUITE  (DEV)
echo  ========================================
echo.
echo  [CODE] %SUITE_ROOT%
echo         Manager/Matrix source is loaded from this folder only.
echo         Desktop launcher syncs FROM this checkout, then starts its own copy:
echo         %%USERPROFILE%%\Desktop\omniswim suite\Start-OmniSwim-Suite.bat
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

:: Free port + clear Vite prebundle cache so source edits always show up
echo.
echo [CACHE] Freeing port 3000 and clearing Vite cache...
node "%SUITE_ROOT%\scripts\free-port.mjs" 3000
node "%SUITE_ROOT%\scripts\clear-vite-cache.mjs"

echo.
echo [START] Launching DEV server at http://localhost:3000
echo         Serving live source from:
echo         %SUITE_ROOT%
echo         Close this window or press Ctrl+C to stop.
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000/"

:: predev also frees port / clears cache; safe to run again
call npm run dev

echo.
echo Server stopped.
pause
