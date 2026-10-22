@echo off
rem Launch Gleeok from the checkout on Windows. Put a shortcut to this file on the desktop or
rem in the Start menu. Rebuild after pulling changes:  cd app ^&^& npm run build
cd /d "%~dp0..\app"
rem One line per pass; the last one is the path (the first run prints a download line before it).
for /f "delims=" %%i in ('node -e "console.log(require('electron'))"') do set "GLEEOK_ELECTRON=%%i"
start "" "%GLEEOK_ELECTRON%" .
