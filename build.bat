@echo off
setlocal
cd /d "%~dp0"

rem Builds ClipWorld into dist\win-unpacked\ClipWorld.exe and launches it.
rem   build.bat            build, then launch
rem   build.bat nolaunch   build only
rem   build.bat installer  build the Windows installer (dist\ClipWorld Setup x.y.z.exe) instead

set "MODE=%~1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this again.
  goto :fail
)

rem Anything holding the last build's files open (a running ClipWorld, an editor, OneDrive uploading it)
rem would make the build fail half way. Check first and say exactly which program it is.
if exist dist\win-unpacked (
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-unlocked.ps1 dist\win-unpacked
  if errorlevel 1 goto :fail
)

if not exist node_modules (
  echo === Installing dependencies ===
  call npm install --no-fund --no-audit
  if errorlevel 1 goto :fail
)

if not exist vendor\ffmpeg\win32-x64\ffmpeg.exe (
  echo === Downloading ffmpeg ===
  call npm run fetch-ffmpeg
  if errorlevel 1 goto :fail
)

echo === Type-checking ===
call npm run typecheck
if errorlevel 1 goto :fail

if /I "%MODE%"=="installer" (
  echo === Building installer ===
  call npm run package
) else (
  echo === Building app ===
  call npm run package:dir
)
if errorlevel 1 goto :fail

echo.
if /I "%MODE%"=="installer" (
  echo Done. The installer is in the dist folder.
  explorer dist
  goto :end
)

echo Done: %CD%\dist\win-unpacked\ClipWorld.exe
if /I "%MODE%"=="nolaunch" goto :end
start "" "%CD%\dist\win-unpacked\ClipWorld.exe"
goto :end

:fail
echo.
echo Build failed.
if /I not "%MODE%"=="nolaunch" pause
endlocal & exit /b 1

:end
endlocal
