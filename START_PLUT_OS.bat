@echo off
setlocal
cd /d "%~dp0"

rem Source checkouts run current code without rebuilding a stale dist package.
rem Both paths reuse the same Hub without importing legacy checkout settings.
if not defined PLUTOS_HOME set "PLUTOS_HOME=%LOCALAPPDATA%\PLUT_OS"
if not exist "%~dp0dashboard.mjs" goto portable
rem Explorer can retain an old PATH after Node is installed. Use an actual
rem compatible executable, including standard installs missing from that PATH.
set "PLUTOS_NODE="
for /f "delims=" %%N in ('"%SystemRoot%\System32\where.exe" node.exe 2^>nul') do if not defined PLUTOS_NODE call :check_node "%%N"
if not defined PLUTOS_NODE call :check_node "%ProgramFiles%\nodejs\node.exe"
if not defined PLUTOS_NODE call :check_node "%ProgramW6432%\nodejs\node.exe"
if not defined PLUTOS_NODE call :check_node "%ProgramFiles(x86)%\nodejs\node.exe"
if not defined PLUTOS_NODE call :check_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined PLUTOS_NODE if defined NVM_SYMLINK call :check_node "%NVM_SYMLINK%\node.exe"
if not defined PLUTOS_NODE (
    echo Node.js 22+ was not found, so PLUTOS cannot start from source. Checking for the ready-made EXE.
    goto portable
)
if not exist "%~dp0node_modules\@modelcontextprotocol\sdk\package.json" call :install_deps
if not exist "%~dp0node_modules\@modelcontextprotocol\sdk\package.json" (
    echo Source dependencies are missing. To run from source, run npm ci in this folder.
    goto portable
)
if /i not "%PLUTOS_MODE%"=="dev" title PLUT_OS Dashboard
echo PLUTOS is starting from source. Keep this window open; press Ctrl+C to stop.
"%PLUTOS_NODE%" "%~dp0dashboard.mjs" --auto-port --open %*
if errorlevel 1 goto failed
exit /b 0

:portable
rem Development mode runs the source being edited, never a built copy.
if /i "%PLUTOS_MODE%"=="dev" (
    echo Development mode runs from source: it needs Node.js 22+ and npm ci in this folder.
    goto failed
)
set "PLUTOS_EXE=%~dp0dist\PLUT_OS.exe"
if exist "%~dp0PLUT_OS.exe" set "PLUTOS_EXE=%~dp0PLUT_OS.exe"
if not exist "%PLUTOS_EXE%" (
    echo PLUTOS could not open: it needs Node.js 22+, or PLUT_OS.exe in this folder or under dist.
    goto failed
)
rem Keep startup errors visible instead of abandoning a hidden process.
"%PLUTOS_EXE%" %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo PLUTOS could not start. Check the error above.
pause
exit /b 1

rem First source run: install the runtime dependency from the committed lockfile with the
rem npm that ships beside the Node found above. Build tools stay with BUILD_PLUT_OS.bat.
:install_deps
if not exist "%~dp0package-lock.json" exit /b 0
for %%D in ("%PLUTOS_NODE%") do set "PLUTOS_NPM=%%~dpDnpm.cmd"
if not exist "%PLUTOS_NPM%" exit /b 0
echo First run: installing the source dependencies (npm ci)...
call "%PLUTOS_NPM%" ci --omit=dev --no-audit --no-fund
if errorlevel 1 echo npm ci failed. Check the error above.
exit /b 0

:check_node
if not exist "%~1" exit /b 0
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if not errorlevel 1 set "PLUTOS_NODE=%~1"
exit /b 0
