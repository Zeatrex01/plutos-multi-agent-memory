@echo off
setlocal
cd /d "%~dp0"

rem Development mode: PLUT_OS working on itself (lib/run-mode.mjs). It keeps its own data
rem folder and default port 3041, and its project list holds only PLUT_OS itself and the
rem sandbox folder, so the normal app's data and your real projects are never touched.
rem PLUTOS_DEV_HOME overrides the data folder (tests); PLUTOS_HOME from the shell is not
rem trusted here, because it may point at the normal app's data.
if not exist "%~dp0dashboard.mjs" (
    echo Development mode runs only from the PLUT_OS source folder.
    pause
    exit /b 1
)
set "PLUTOS_MODE=dev"
rem No parenthesised block here: a ")" in a path would end it early.
set "PLUTOS_HOME=%LOCALAPPDATA%\PLUT_OS-dev"
if defined PLUTOS_DEV_HOME set "PLUTOS_HOME=%PLUTOS_DEV_HOME%"
title PLUT_OS [DEV]
call "%~dp0START_PLUT_OS.bat" %*
exit /b %errorlevel%
