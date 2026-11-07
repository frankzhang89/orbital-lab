@echo off
setlocal
set "ORBITAL_ROOT=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22.12+ ^(22.x^) or 24+ and try again. 1>&2
  exit /b 1
)
node "%ORBITAL_ROOT%launcher.mjs" %*
exit /b %ERRORLEVEL%
