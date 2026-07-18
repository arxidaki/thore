@echo off
rem Build the Thore desktop app for Windows.
rem
rem This builds the host architecture (x64). macOS, Linux and Windows-ARM64
rem binaries can't be cross-built from a normal Windows box — those are built
rem automatically by GitHub Actions on a version tag (.github/workflows/release.yml).
rem To also build the Windows ARM64 installer locally you need the "MSVC ARM64
rem build tools" component in Visual Studio; then run: npm run build:win-arm64
pushd "%~dp0"
call npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED
  popd
  exit /b 1
)
echo.
echo Installer:  src-tauri\target\release\bundle\nsis\
echo Portable:   src-tauri\target\release\thore.exe
popd
