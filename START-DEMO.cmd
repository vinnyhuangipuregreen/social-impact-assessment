@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24.12 or later is required.
  pause
  exit /b 1
)
set SIMP_DEMO=1
set HOST=127.0.0.1
echo Public site    http://127.0.0.1:3030/
echo Admin console  http://127.0.0.1:3030/admin
echo Keep this window open while using the demo.
node src/server.ts
pause
