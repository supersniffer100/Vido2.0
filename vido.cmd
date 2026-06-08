@echo off
setlocal

set "ROOT=%~dp0"
set "PID_FILE=%ROOT%.vido-server.pid"

if "%~1"=="" goto :usage
if /I "%~1"=="start" goto :start
if /I "%~1"=="stop" goto :stop
if /I "%~1"=="status" goto :status
goto :usage

:start
call :resolvepid
if exist "%PID_FILE%" (
  set /p VIDOPID=<"%PID_FILE%"
  if not "%VIDOPID%"=="" (
    tasklist /FI "PID eq %VIDOPID%" | find "%VIDOPID%" >nul
    if not errorlevel 1 (
      echo Vido is already running with PID %VIDOPID%.
      exit /b 0
    )
  )
  del "%PID_FILE%" >nul 2>nul
)
if not "%VIDOPID%"=="" (
  echo Vido is already running with PID %VIDOPID%.
  exit /b 0
)

cd /d "%ROOT%"
node server.js
exit /b %errorlevel%

:stop
call :resolvepid
if "%VIDOPID%"=="" (
  echo Vido is not running.
  exit /b 0
)

taskkill /PID %VIDOPID% /T >nul
if errorlevel 1 (
  echo Could not stop Vido.
  exit /b 1
)

del "%PID_FILE%" >nul 2>nul
echo Vido stopped.
exit /b 0

:status
call :resolvepid
if "%VIDOPID%"=="" (
  echo Vido is not running.
  exit /b 0
)

echo Vido is running with PID %VIDOPID%.
exit /b 0

:resolvepid
set "VIDOPID="
if exist "%PID_FILE%" (
  set /p VIDOPID=<"%PID_FILE%"
  if not "%VIDOPID%"=="" (
    tasklist /FI "PID eq %VIDOPID%" | find "%VIDOPID%" >nul
    if not errorlevel 1 exit /b 0
  )
  set "VIDOPID="
  del "%PID_FILE%" >nul 2>nul
)

for /f %%P in ('powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if($p){$p}"') do set "VIDOPID=%%P"
exit /b 0

:usage
echo Usage: vido start ^| stop ^| status
exit /b 1
