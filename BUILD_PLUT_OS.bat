@echo off
title PLUT_OS Build
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Error: Node.js was not found on this machine.
    echo Building requires Node.js ^(the produced exe does not^).
    pause
    exit /b 1
)

if not exist "node_modules\esbuild" goto install
if not exist "node_modules\postject" goto install
if not exist "node_modules\resedit" goto install
goto menu

:install
echo First run: installing the build tools ^(npm install^)...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo npm install failed. See the output above.
    pause
    exit /b 1
)

:menu
echo.
echo   PLUT_OS build - the result goes to dist\
echo.
echo   1  App: PLUT_OS.exe, no console window
echo   2  App with a console window ^(shows the log^)
echo   3  Lite: one file for a machine that has Node.js
echo.
choice /c 123 /n /m "Pick 1, 2 or 3: "
if errorlevel 3 set "PLUTOS_BUILD_FLAG=--lite" & goto build
if errorlevel 2 set "PLUTOS_BUILD_FLAG=--console" & goto build
set "PLUTOS_BUILD_FLAG=--windowed"

:build
echo.
node build.mjs %PLUTOS_BUILD_FLAG%
if errorlevel 1 (
    echo.
    echo The build stopped with an error. See the output above.
    pause
    exit /b 1
)
echo.
pause
