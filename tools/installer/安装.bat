@echo off
rem ===================================================================
rem  Lemon one-click installer (double-click this file).
rem
rem  This file is deliberately ASCII-only and tiny: cmd parses .bat
rem  using the console code page, so Chinese text in here would show
rem  up as mojibake on a machine with a different code page.
rem  All the real work (and all the Chinese output) lives in
rem  install.ps1, which PowerShell reads as UTF-8 when it has a BOM.
rem ===================================================================

setlocal
set "PS1=%~dp0install.ps1"

if not exist "%PS1%" (
  echo [ERROR] install.ps1 not found next to this file.
  echo         Please keep the whole folder together.
  echo.
  pause
  exit /b 1
)

rem -ExecutionPolicy Bypass: a freshly copied .ps1 may be blocked by the
rem default Restricted policy on some machines.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" echo [exit code %CODE%]
pause
exit /b %CODE%
