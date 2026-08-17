@echo off
title NIGHTSHIFT
color 0D
echo.
echo    N I G H T S H I F T
echo.

cd /d "%~dp0"

where node >nul 2>nul || goto noNode

rem the floor runs without a gateway, but then every output is a ghost
curl -s -o nul -m 3 http://localhost:20128/v1/models && goto up
echo    [!] omniroute is not answering on :20128 - the floor will run in ghost mode
echo        and nothing will be sent to a model. start it first with
echo        "START OMNIROUTE.bat" in %USERPROFILE%\.omniroute
echo.
goto run

:up
echo    gateway: up on :20128
echo.

:run
node bin\nightshift.mjs %*
if errorlevel 1 pause
exit /b %errorlevel%

:noNode
echo    [!] node is not on PATH. nightshift needs node 22.6 or newer.
pause
exit /b 1
