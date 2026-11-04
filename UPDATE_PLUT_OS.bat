@echo off
rem Brings this PLUT_OS checkout up to date: plutos update (lib/update.mjs).
rem UPDATE_PLUT_OS.bat --check only reports; --clean also moves the files git neither tracks
rem nor ignores into the Hub, out of the way. Nothing is deleted, and local work stops an update.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22+ was not found on PATH. & pause & exit /b 1)
node "%~dp0cli.mjs" update %*
pause
