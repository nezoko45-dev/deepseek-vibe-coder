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
where ollama >nul 2>nul
if errorlevel 1 (
  echo Ollama is required for local Qwen coding.
  echo Install Ollama, then run this file again.
  pause
  exit /b 1
)
if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
  echo.
  echo Created config.json.
  echo Open config.json and enter your GitHub token.
  echo No Qwen API key is required.
  pause
  exit /b 0
)
start "Qwen Vibe Coder Backend" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787"
exit /b 0
