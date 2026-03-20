@echo off
chcp 65001 >nul
REM Ищем ibsrv.exe, который слушает порт 8441 (regport из srv1c.yml)
netstat -ano | findstr ":8441" | findstr "LISTENING"
