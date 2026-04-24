@echo off
chcp 65001 >nul 2>&1
title Binance Grid Bot Scraper

echo ============================================
echo   Binance Grid Bot Scraper - Start
echo ============================================
echo.

set "DIR=%~dp0"
cd /d "%DIR%"

REM === 1. Check Edge debug port ===
echo [1/3] Checking Edge debug port...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%check-edge.ps1" >nul 2>&1
if %errorlevel% equ 0 (
    echo      [OK] Edge is running on port 9222
) else (
    echo      [!!] Edge not found, launching...
    start "" msedge --remote-debugging-port=9222
    echo      Please login to Binance and open the grid trading page
    echo      Waiting 8 seconds...
    timeout /t 8 /nobreak >nul
)

REM === 2. Kill leftover node processes ===
echo.
echo [2/3] Checking leftover processes...
for /f "tokens=2" %%i in ('wmic process where "name='node.exe' and commandline like '%%auto-scrape%%'" get processid /value 2^>nul ^| findstr "ProcessId"') do (
    echo      Killing old auto-scrape PID=%%i ...
    taskkill /pid %%i /f >nul 2>&1
)
echo      Ready

REM === 3. Start scraper ===
echo.
echo [3/3] Starting scraper...
echo.
node.exe auto-scrape.js %*

pause
