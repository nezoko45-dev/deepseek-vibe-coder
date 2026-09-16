@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install Node.js, then double-click start.bat again.
  pause
  exit /b 1
)
if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
  echo.
  echo Created config.json.
  echo Open config.json and enter your DeepSeek API key and GitHub token.
  echo Then run start.bat again.
  pause
  exit /b 0
)
node server.js
pause
