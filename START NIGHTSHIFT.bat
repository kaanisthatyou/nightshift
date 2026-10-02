@echo off
title NIGHTSHIFT
color 0D
echo.
echo    N I G H T S H I F T
echo.

cd /d "%~dp0"

where node >nul 2>nul || goto noNode

rem no gateway to start: keys go in mains > providers, or in NVIDIA_API_KEY and friends

:run
node bin\nightshift.mjs %*
if errorlevel 1 pause
exit /b %errorlevel%

:noNode
echo    [!] node is not on PATH. nightshift needs node 22.6 or newer.
pause
exit /b 1
