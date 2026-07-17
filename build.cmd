@echo off
rem Build the Thore desktop app (portable exe + NSIS installer).
rem Usage: double-click, or run "build.cmd" from a terminal.
pushd "%~dp0"
call npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED
  popd
  exit /b 1
)
echo.
echo Portable exe:  src-tauri\target\release\thore.exe
echo Installer:     src-tauri\target\release\bundle\nsis\
popd
