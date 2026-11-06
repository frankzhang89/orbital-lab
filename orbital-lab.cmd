@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0orbital-lab.ps1" %*
exit /b %errorlevel%
