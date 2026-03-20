@echo off
chcp 65001 >nul

set "IBCMD=C:\Program Files\1cv8\current\bin\ibcmd.exe"
set "SRC=C:\1ext.ru\projects\github.com\ЕХТ_Лира_Роутер\src"
set "EXT=ЕХТ_Лира_Роутер"

echo === Тест 3: --remote без протокола ===
"%IBCMD%" --remote=localhost:8442 infobase config import --extension=%EXT% "%SRC%" 2>&1
echo EXIT: %ERRORLEVEL%
echo.

echo === Тест 4: extension import вместо infobase config import ===
"%IBCMD%" --remote=tcp://localhost:8442 config import --extension=%EXT% "%SRC%" 2>&1
echo EXIT: %ERRORLEVEL%
echo.

echo === Тест 5: ibcmd help config import ===
"%IBCMD%" help config 2>&1
