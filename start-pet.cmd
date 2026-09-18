@echo off
rem deskpet-guard desktop pet launcher (double-click works).
rem
rem   start-pet.cmd                 start DSH pet (watches the DSH host process)
rem   start-pet.cmd --client zcode  start ZCode pet (watches by process name)
rem   start-pet.cmd --status        print status text only, no window
rem   start-pet.cmd --stop all      stop every pet
rem   start-pet.cmd --list          list running pets
rem
rem NOTE: keep this file ASCII-only. Batch files are read with the console code page,
rem and GBK double-byte chars can contain 0x26 (&) or 0x7C (|), which cmd treats as
rem command separators -> garbled errors. Chinese docs live in README.md instead.
setlocal
set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--client dsh"
node "%~dp0bin\deskpet-guard-pet.js" %ARGS%
if errorlevel 1 (
  echo.
  echo [FAILED] see the error above. Common causes: Node.js not installed, an old
  echo          copy of this repo ^(run: git pull^), or the package is missing.
  pause
)
endlocal
