@echo off
:: Restart Lyra Router
:: Windows Explorer: double-click
:: Git Bash: cd Router && cmd //c ".\\_restart.bat"
cd /d "%~dp0"

set OLD_PID=0
if not exist router.pid goto start
set /p OLD_PID=<router.pid
taskkill /PID %OLD_PID% /T /F >nul 2>&1
echo Stopped router (PID %OLD_PID%)
ping -n 2 127.0.0.1 >nul

:start
powershell -NoProfile -Command "Start-Process node -ArgumentList 'server.mjs' -WindowStyle Hidden"
ping -n 4 127.0.0.1 >nul

if not exist router.pid goto fail
set /p NEW_PID=<router.pid
if "%NEW_PID%"=="%OLD_PID%" goto fail
echo Started router (PID %NEW_PID%)
goto end

:fail
echo ERROR: Router failed to start!
exit /b 1

:end
