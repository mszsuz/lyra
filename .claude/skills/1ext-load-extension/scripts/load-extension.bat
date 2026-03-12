@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM Загрузка расширения в базу Lyra через DESIGNER /S
REM
REM Параметры:
REM   %1 - каталог с XML-файлами расширения
REM   %2 - имя расширения
REM   %3 - (опционально) "skipapply" для пропуска применения к БД
REM
REM Подключение через /S (кластер автономного сервера),
REM а не /F (файловая база — требует эксклюзивную блокировку).
REM ============================================================

set "V8=C:\Program Files\1cv8\current\bin\1cv8.exe"
set "SERVER=HOME:8441\Lyra-TEST"

if "%~2"=="" (
    echo Использование: load-extension.bat ^<XML_DIR^> ^<EXT_NAME^> [skipapply]
    echo.
    echo Примеры:
    echo   load-extension.bat "C:\1ext.ru\projects\github.com\ЕХТ_Лира_Роутер\src" "ЕХТ_Лира_Роутер"
    echo   load-extension.bat "C:\path\to\src" "МоёРасширение" skipapply
    exit /b 1
)

set "XML_DIR=%~1"
set "EXT_NAME=%~2"
set "SKIP_APPLY=0"
if /i "%~3"=="skipapply" set "SKIP_APPLY=1"

set "LOG_IMPORT=%TEMP%\1ext-import-%EXT_NAME%.log"
set "LOG_UPDATE=%TEMP%\1ext-update-%EXT_NAME%.log"

echo === Загрузка расширения (DESIGNER) ===
echo   Источник: %XML_DIR%
echo   Расширение: %EXT_NAME%
echo   Сервер: %SERVER%

REM Шаг 1: загрузка XML в конфигурацию расширения
echo.
echo [1/2] Импорт конфигурации расширения...
"%V8%" DESIGNER /S %SERVER% /DisableStartupDialogs /LoadConfigFromFiles "%XML_DIR%" -Extension %EXT_NAME% /Out "%LOG_IMPORT%"

if %ERRORLEVEL% neq 0 (
    echo ОШИБКА импорта расширения (код %ERRORLEVEL%)
    if exist "%LOG_IMPORT%" type "%LOG_IMPORT%"
    exit /b 1
)
echo Импорт OK

if "%SKIP_APPLY%"=="1" (
    echo Применение к БД пропущено
    exit /b 0
)

REM Шаг 2: применение расширения к БД
echo.
echo [2/2] Применение расширения к БД...
"%V8%" DESIGNER /S %SERVER% /DisableStartupDialogs /UpdateDBCfg -Extension %EXT_NAME% /Out "%LOG_UPDATE%"

if %ERRORLEVEL% neq 0 (
    echo ОШИБКА применения расширения к БД (код %ERRORLEVEL%)
    if exist "%LOG_UPDATE%" type "%LOG_UPDATE%"
    exit /b 1
)
echo Применение OK

echo.
echo === Расширение %EXT_NAME% загружено и применено ===
exit /b 0
