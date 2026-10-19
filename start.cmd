@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12+ is required. Install Node.js and reopen this file.
  pause
  exit /b 1
)
node scripts\cli.mjs start
if errorlevel 1 pause
