@echo off
:: Launcher at workspace root — delegates to the suite folder
cd /d "%~dp0omniswim-suite"
if not exist "Start-OmniSwim-Suite.bat" (
  echo omniswim-suite folder or startup script not found.
  pause
  exit /b 1
)
call "%~dp0omniswim-suite\Start-OmniSwim-Suite.bat"
