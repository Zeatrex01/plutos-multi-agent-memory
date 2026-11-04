@echo off
title Stop the PLUT_OS server
cd /d "%~dp0"

echo ===================================================
echo           Stopping the PLUT_OS server
echo ===================================================
echo.

set PORT=3040
if not "%PLUTOS_PORT%"=="" set PORT=%PLUTOS_PORT%

echo Checking port %PORT%...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$conn = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; " ^
    "if ($conn) { " ^
    "    $pids = $conn.OwningProcess | Select-Object -Unique; " ^
    "    foreach ($p in $pids) { " ^
    "        try { " ^
    "            $proc = Get-Process -Id $p -ErrorAction Stop; " ^
    "            Write-Host ('[+] Server process found: ' + $proc.ProcessName + ' (PID: ' + $p + ')'); " ^
    "            Stop-Process -Id $p -Force; " ^
    "            Write-Host '[OK] Server stopped.'; " ^
    "        } catch { " ^
    "            Write-Host ('[-] Could not stop the process: ' + $_.Exception.Message); " ^
    "        } " ^
    "    } " ^
    "} else { " ^
    "    Write-Host '[INFO] No running PLUT_OS server found on port %PORT%.'; " ^
    "}"

:: Close the PLUT_OS console window too, if it is open
taskkill /FI "WINDOWTITLE eq PLUT_OS Dashboard*" /F /T >nul 2>&1

echo.
echo Done.
echo.
pause
