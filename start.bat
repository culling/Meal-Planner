@echo off
rem Double-click to start the Meal Planner. Close this window to stop it.
cd /d "%~dp0"
if not exist "packages\web\dist\index.html" (
  echo Building the web app for the first time...
  call npm run build
)
call npm run start
pause
