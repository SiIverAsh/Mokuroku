@echo off
setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
set LOGFILE=logs\sync-%TODAY%.log

echo [%DATE% %TIME%] Starting Mokuroku weekly archive sync... >> "%LOGFILE%"
node.exe --env-file-if-exists=.env --use-env-proxy ".\node_modules\tsx\dist\cli.mjs" ".\src\cli.ts" sync --skip-if-unchanged >> "%LOGFILE%" 2>&1
set EXITCODE=%ERRORLEVEL%
echo [%DATE% %TIME%] Finished with exit code %EXITCODE% >> "%LOGFILE%"
exit /b %EXITCODE%
