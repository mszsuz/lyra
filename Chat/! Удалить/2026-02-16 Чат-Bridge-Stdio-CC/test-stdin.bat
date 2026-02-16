@echo off
set CLAUDECODE=
cd /d "C:\WORKS\2026-02-10 1ccc.ru"
echo {"type":"user","message":{"role":"user","content":"Say hi"}} | claude --print --output-format stream-json --input-format stream-json --model claude-sonnet-4-20250514 --dangerously-skip-permissions --verbose
echo.
echo EXIT CODE: %ERRORLEVEL%
